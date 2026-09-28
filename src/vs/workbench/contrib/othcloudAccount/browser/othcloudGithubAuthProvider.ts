/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { BrowserViewUri } from '../../../../platform/browserView/common/browserViewUri.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import {
	AuthenticationSession,
	AuthenticationSessionsChangeEvent,
	IAuthenticationProvider,
	IAuthenticationProviderSessionOptions,
	IAuthenticationService,
} from '../../../services/authentication/common/authentication.js';
import { IOthcloudAccountService } from '../common/othcloudAccountService.js';
import { getOthcloudBaseUrl, OthcloudAccountApiError } from './othcloudAccountClient.js';

// Registered as the canonical `github` provider id so every GitHub-using surface
// in the workbench - git, GitLens, the GitHub Pull Requests extension, Settings
// Sync - silently uses the GitHub token OTHCloud hands out instead of prompting
// for a separate GitHub sign-in. There is deliberately only one account to sign in to:
// OTHCloud. The built-in `vscode.github-authentication` extension's own
// `contributes.authentication` registrations are cleared in its package.json so we
// own this slot uncontested.
export const OTHCLOUD_GITHUB_PROVIDER_ID = 'github';
const OTHCLOUD_GITHUB_PROVIDER_LABEL = 'GitHub';

/** How early (ms) we proactively refresh before the server-reported expiry. */
const REFRESH_BUFFER_MS = 60_000;

/** Opens the website page that connects the user's GitHub account, then waits for it. */
export const CONNECT_GITHUB_COMMAND_ID = '_othcloud.github.connect';
const DEFAULT_CONNECT_PATH = '/desktop-github';
/** How often, and how long, to check whether the connect page has finished. */
const CONNECT_POLL_MS = 3_000;
const CONNECT_WAIT_MS = 10 * 60_000;
/** Set by "Don't Show Again" on the offer to connect GitHub. */
const CONNECT_OFFER_DISMISSED_KEY = 'othcloud.github.connectOfferDismissed';

interface IGithubTokenResponse {
	/**
	 * `user`: the user's own GitHub account, reaching every repository they can.
	 * `installation`: their organization's GitHub App, reaching only the repositories
	 * it is installed on, with its permissions (often read-only). Missing from older
	 * servers, which only had installation tokens.
	 */
	kind?: 'user' | 'installation';
	token: string;
	expiresAt: string;
	githubId: string;
	/** GitHub username, for `user` tokens. */
	login?: string;
	appName?: string;
	/** An installation token, handed out because the user's account isn't connected. */
	needsConnect?: boolean;
	/** Website path of the page that connects the user's GitHub account. */
	connectPath?: string;
}

/**
 * Authentication provider that fronts the user's GitHub connection on
 * othcloud.xyz. Hits `/api/desktop/github-token` for the user's GitHub token
 * (or an installation token when their account isn't connected); cached until
 * shortly before the expiry the server gives, refreshed transparently.
 *
 * When there is no token that can push, it offers to connect the user's GitHub
 * account: a website page in the integrated browser, which this provider waits
 * on so the new token is used as soon as the page is done.
 *
 * Registered with the workbench's {@link IAuthenticationService} under the
 * canonical `github` id; the built-in `vscode.github-authentication` extension is
 * declaration-free so nothing competes for it.
 */
export class OthcloudGithubAuthProvider extends Disposable implements IAuthenticationProvider, IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.othcloudGithubAuthProvider';

	readonly id = OTHCLOUD_GITHUB_PROVIDER_ID;
	readonly label = OTHCLOUD_GITHUB_PROVIDER_LABEL;
	readonly supportsMultipleAccounts = false;

	private readonly _onDidChangeSessions = this._register(new Emitter<AuthenticationSessionsChangeEvent>());
	readonly onDidChangeSessions: Event<AuthenticationSessionsChangeEvent> = this._onDidChangeSessions.event;

	private cached: { session: AuthenticationSession; expiresAtMs: number; response: IGithubTokenResponse } | undefined;
	private inFlight: Promise<AuthenticationSession | undefined> | undefined;
	/** Offered once per window: after that, the Connect GitHub command is there. */
	private offeredConnect = false;
	private connectWait: { cancel(): void } | undefined;

	constructor(
		@IOthcloudAccountService private readonly accountService: IOthcloudAccountService,
		@IAuthenticationService authService: IAuthenticationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IEditorService private readonly editorService: IEditorService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		this._register(CommandsRegistry.registerCommand(CONNECT_GITHUB_COMMAND_ID, () => this.connect()));
		this._register({ dispose: () => this.connectWait?.cancel() });

		// `registerDeclaredAuthenticationProvider` throws if `github` is already
		// declared (e.g. the half-disabled built-in github-authentication
		// extension raced us to it). If that throw escaped, the constructor would
		// abort *before* `registerAuthenticationProvider` and the provider would
		// never actually register - leaving GitHub-using extensions (Copilot, the
		// PR extension) to time out waiting for `github`. So guard the declaration
		// and always register the provider itself.
		let didDeclare = false;
		if (!authService.declaredProviders.some(p => p.id === OTHCLOUD_GITHUB_PROVIDER_ID)) {
			try {
				authService.registerDeclaredAuthenticationProvider({
					id: OTHCLOUD_GITHUB_PROVIDER_ID,
					label: OTHCLOUD_GITHUB_PROVIDER_LABEL,
				});
				didDeclare = true;
			} catch {
				// Already declared by someone else - fine, we still register below.
			}
		}
		authService.registerAuthenticationProvider(OTHCLOUD_GITHUB_PROVIDER_ID, this);
		this._register({
			dispose: () => {
				// Only take `github` down if it is still ours: when another provider registered
				// over this one (which is what disposes it), unregistering would remove theirs too
				// and leave no GitHub provider at all.
				if (!authService.isAuthenticationProviderRegistered(OTHCLOUD_GITHUB_PROVIDER_ID) || authService.getProvider(OTHCLOUD_GITHUB_PROVIDER_ID) !== this) {
					return;
				}
				authService.unregisterAuthenticationProvider(OTHCLOUD_GITHUB_PROVIDER_ID);
				if (didDeclare) {
					authService.unregisterDeclaredAuthenticationProvider(OTHCLOUD_GITHUB_PROVIDER_ID);
				}
			},
		});

		// Whenever the Othcloud session flips, our GitHub session becomes
		// stale - invalidate so the next call refreshes.
		this._register(this.accountService.onDidChangeAuth(() => {
			const previous = this.cached?.session;
			this.cached = undefined;
			if (previous) {
				this._onDidChangeSessions.fire({ added: undefined, removed: [previous], changed: undefined });
			}
		}));
	}

	async getSessions(scopes: string[] | undefined, _options: IAuthenticationProviderSessionOptions): Promise<readonly AuthenticationSession[]> {
		const session = await this.resolveSession({ interactive: false });
		if (!session) {
			return [];
		}
		return [this.withScopes(session, scopes)];
	}

	async createSession(scopes: string[], _options: IAuthenticationProviderSessionOptions): Promise<AuthenticationSession> {
		const session = await this.resolveSession({ interactive: true });
		if (!session) {
			throw new Error('OTHCloud GitHub session unavailable');
		}
		return this.withScopes(session, scopes);
	}

	/**
	 * Re-wraps the cached session with whatever scopes the caller requested.
	 *
	 * The OTHCloud-proxied token has what it has (the user's `repo` access, or
	 * an installation's app permissions) - whatever scopes the caller asks for (`repo`, `workflow`,
	 * `read:user`, ...) get echoed back so VS Code's scope-matching logic
	 * treats the session as valid for every consumer (Copilot, the PR
	 * extension, Settings Sync, etc.). If the token can't actually perform
	 * an operation, the API call fails downstream - but the user no longer
	 * sees the upstream "Sign in to GitHub" prompt.
	 */
	private withScopes(session: AuthenticationSession, scopes: string[] | undefined): AuthenticationSession {
		if (!scopes || scopes.length === 0) {
			return session;
		}
		return { ...session, scopes };
	}

	async removeSession(_sessionId: string): Promise<void> {
		// Removing the desktop-side session doesn't disconnect GitHub on
		// othcloud.xyz - that's a website action. We just drop the cache here;
		// users disconnect via the website's git settings page.
		const previous = this.cached?.session;
		this.cached = undefined;
		if (previous) {
			this._onDidChangeSessions.fire({ added: undefined, removed: [previous], changed: undefined });
		}
	}

	private async resolveSession(opts: { interactive: boolean }): Promise<AuthenticationSession | undefined> {
		if (this.cached && this.cached.expiresAtMs - Date.now() > REFRESH_BUFFER_MS) {
			return this.cached.session;
		}
		if (this.inFlight) {
			return this.inFlight;
		}
		this.inFlight = this.fetchSession(opts);
		try {
			return await this.inFlight;
		} finally {
			this.inFlight = undefined;
		}
	}

	private async fetchSession(opts: { interactive: boolean }): Promise<AuthenticationSession | undefined> {
		const token = await this.accountService.getToken();
		if (!token) {
			// User isn't signed in to Othcloud at all. Nothing we can do.
			return undefined;
		}

		let response: IGithubTokenResponse;
		try {
			const result = await this.requestToken(token);
			if (!result.connected) {
				this.offerToConnect(result.connectPath, false);
				return undefined;
			}
			response = result.response;
		} catch (err) {
			if (opts.interactive) {
				this.notificationService.notify({
					severity: Severity.Error,
					message: localize('othcloud.github.tokenFetchFailed', "Couldn't get a GitHub token from OTHCloud: {0}", String((err as Error).message ?? err)),
				});
			}
			return undefined;
		}

		const session = this.adopt(response);
		if (response.needsConnect) {
			this.offerToConnect(response.connectPath, true);
		}
		return session;
	}

	/** The server's GitHub token for the signed-in user, or that there is none. */
	private async requestToken(token: string): Promise<{ connected: true; response: IGithubTokenResponse } | { connected: false; connectPath?: string }> {
		const res = await fetch(`${getOthcloudBaseUrl()}/api/desktop/github-token`, {
			method: 'GET',
			headers: { 'Authorization': `Bearer ${token}` },
		});
		if (res.status === 404) {
			const body = await res.json().catch(() => undefined) as { connectPath?: string } | undefined;
			return { connected: false, connectPath: body?.connectPath };
		}
		if (!res.ok) {
			throw new OthcloudAccountApiError(res.status, `HTTP ${res.status}`);
		}
		return { connected: true, response: await res.json() as IGithubTokenResponse };
	}

	/** Caches `response` as the session and tells consumers. */
	private adopt(response: IGithubTokenResponse): AuthenticationSession {
		const user = this.accountService.getUser();
		const previous = this.cached?.session;
		const kind = response.kind ?? 'installation';
		const session: AuthenticationSession = {
			id: `othcloud-github:${kind}:${response.githubId}`,
			accessToken: response.token,
			account: {
				id: response.githubId,
				label: response.login ?? response.appName ?? user?.email ?? 'OTHCloud GitHub',
			},
			scopes: [],
		};
		const expiresAtMs = new Date(response.expiresAt).getTime();
		this.cached = { session, expiresAtMs: isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 50 * 60_000, response };

		if (previous && previous.id !== session.id) {
			this._onDidChangeSessions.fire({ added: [session], removed: [previous], changed: undefined });
		} else if (previous) {
			this._onDidChangeSessions.fire({ added: undefined, removed: undefined, changed: [session] });
		} else {
			this._onDidChangeSessions.fire({ added: [session], removed: undefined, changed: undefined });
		}
		return session;
	}

	/**
	 * Offers to connect the user's GitHub account, once per window unless dismissed for
	 * good. `limited`: there is a token, but only the organization's GitHub App's, which
	 * usually can't push.
	 */
	private offerToConnect(connectPath: string | undefined, limited: boolean): void {
		if (this.offeredConnect || this.connectWait || this.storageService.getBoolean(CONNECT_OFFER_DISMISSED_KEY, StorageScope.APPLICATION, false)) {
			return;
		}
		this.offeredConnect = true;
		this.notificationService.prompt(
			limited ? Severity.Info : Severity.Warning,
			limited
				? localize('othcloud.github.limited', "OTHCloud is using your organization's GitHub App, which only reaches the repositories it's installed on and may not be able to push. Connect your GitHub account to work with all your repositories.")
				: localize('othcloud.github.notLinked', "Connect your GitHub account to OTHCloud to clone, push and create repositories."),
			[{
				label: localize('othcloud.github.connectAction', "Connect GitHub"),
				run: () => void this.connect(connectPath),
			}, {
				label: localize('othcloud.github.dontShowAgain', "Don't Show Again"),
				isSecondary: true,
				run: () => this.storageService.store(CONNECT_OFFER_DISMISSED_KEY, true, StorageScope.APPLICATION, StorageTarget.USER),
			}],
		);
	}

	/**
	 * Opens the website page that connects the user's GitHub account and waits for the
	 * token it produces: every GitHub consumer gets it from then on without a reload.
	 */
	private async connect(connectPath = this.cached?.response.connectPath ?? DEFAULT_CONNECT_PATH): Promise<void> {
		if (!(await this.accountService.getToken())) {
			this.notificationService.info(localize('othcloud.github.signInFirst', "Sign in to OTHCloud first, then connect GitHub."));
			return;
		}
		const path = connectPath.startsWith('/') ? connectPath : DEFAULT_CONNECT_PATH;
		await this.editorService.openEditor({ resource: BrowserViewUri.forUrl(getOthcloudBaseUrl() + path), options: { pinned: true } });

		this.connectWait?.cancel();
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		this.connectWait = { cancel: () => { cancelled = true; clearTimeout(timer); } };
		const wait = this.connectWait;
		const deadline = Date.now() + CONNECT_WAIT_MS;
		const stop = () => {
			if (this.connectWait === wait) {
				this.connectWait = undefined;
			}
		};
		const check = async () => {
			const token = await this.accountService.getToken();
			if (cancelled) {
				return;
			}
			if (!token) {
				stop(); // signed out meanwhile
				return;
			}
			// Straight to the server, bypassing the cache: consumers only hear about the
			// token the page produced, not about every check
			const result = await this.requestToken(token).catch(() => undefined);
			if (cancelled) {
				return;
			}
			if (result?.connected && result.response.kind === 'user') {
				stop();
				const session = this.adopt(result.response);
				this.notificationService.info(localize('othcloud.github.connected', "GitHub connected as {0}.", session.account.label));
				return;
			}
			if (Date.now() < deadline) {
				timer = setTimeout(check, CONNECT_POLL_MS);
			} else {
				stop();
			}
		};
		timer = setTimeout(check, CONNECT_POLL_MS);
	}
}
