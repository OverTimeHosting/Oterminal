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
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
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
// for a separate GitHub sign-in. Which of the user's GitHub accounts on OTHCloud that is
// can be switched (Switch GitHub Account), and more can be added from OTerminal. The built-in `vscode.github-authentication` extension's own
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

/** Picks which of the user's GitHub accounts on OTHCloud OTerminal uses, or adds one. */
export const SWITCH_GITHUB_ACCOUNT_COMMAND_ID = '_othcloud.github.switchAccount';
/** Signs in to a GitHub account in OTerminal and saves it on OTHCloud. */
export const SIGN_IN_GITHUB_COMMAND_ID = '_othcloud.github.signIn';
/** The chosen account, `{ user, account }`: only applies while that OTHCloud user is signed in. */
const SELECTED_ACCOUNT_KEY = 'othcloud.github.selectedAccount';
/** Where to create a token for "Sign in to GitHub": the scopes OTHCloud needs to clone, push and deploy. */
const NEW_TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo,workflow,read:org&description=OTerminal';

/** One of the user's GitHub accounts on OTHCloud, as `/api/desktop/github-accounts` lists it. */
interface IGithubAccount {
	/** `user:<id>` for a linked GitHub account, `app:<id>` for an organization's git provider. */
	id: string;
	kind: 'user' | 'installation';
	label: string;
	login?: string;
	githubId: string;
	avatarUrl?: string;
	/** Whether its token can push (a user token with repository access). */
	canPush: boolean;
	/** Whether OTHCloud can deploy projects from it. */
	deployable: boolean;
}

interface IGithubAccountsResponse {
	accounts: IGithubAccount[];
	connectPath?: string;
	connectAvailable?: boolean;
}

interface IGithubTokenResponse {
	/** Which of `/api/desktop/github-accounts` this token belongs to. Missing from older servers. */
	accountId?: string;
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
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();

		this._register(CommandsRegistry.registerCommand(CONNECT_GITHUB_COMMAND_ID, () => this.connect()));
		this._register(CommandsRegistry.registerCommand(SWITCH_GITHUB_ACCOUNT_COMMAND_ID, () => this.switchAccount()));
		this._register(CommandsRegistry.registerCommand(SIGN_IN_GITHUB_COMMAND_ID, () => this.signInWithToken()));
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
			let result: Awaited<ReturnType<OthcloudGithubAuthProvider['requestToken']>> | undefined;
			const selected = this.getSelectedAccount();
			if (selected) {
				// A failure (e.g. GitHub unreachable) keeps the pick for next time
				result = await this.requestToken(token, selected).catch(() => undefined);
				if (result && !result.connected) {
					// Gone from OTHCloud (or expired): back to the server's own choice
					this.setSelectedAccount(undefined);
				}
				if (!result?.connected) {
					result = undefined;
				}
			}
			result ??= await this.requestToken(token);
			if (!result.connected) {
				void this.offerToConnect(result.connectPath, false);
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
			void this.offerToConnect(response.connectPath, true);
		}
		return session;
	}

	/**
	 * The server's GitHub token for the signed-in user, or that there is none. `accountId`
	 * asks for one of their accounts in particular (see `/api/desktop/github-accounts`).
	 */
	private async requestToken(token: string, accountId?: string): Promise<{ connected: true; response: IGithubTokenResponse } | { connected: false; connectPath?: string }> {
		const query = accountId ? `?account=${encodeURIComponent(accountId)}` : '';
		const res = await fetch(`${getOthcloudBaseUrl()}/api/desktop/github-token${query}`, {
			method: 'GET',
			headers: { 'Authorization': `Bearer ${token}` },
		});
		if (accountId && (res.status === 404 || res.status === 409)) {
			return { connected: false };
		}
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
			id: `othcloud-github:${response.accountId ?? `${kind}:${response.githubId}`}`,
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
	private async offerToConnect(connectPath: string | undefined, limited: boolean): Promise<void> {
		if (this.offeredConnect || this.connectWait || this.storageService.getBoolean(CONNECT_OFFER_DISMISSED_KEY, StorageScope.APPLICATION, false)) {
			return;
		}
		this.offeredConnect = true;
		// Nothing to offer when the server can't link GitHub accounts: the page would only say so
		if (!(await this.isConnectAvailable())) {
			return;
		}
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

	/** The GitHub account the signed-in OTHCloud user picked, if any. */
	private getSelectedAccount(): string | undefined {
		const user = this.accountService.getUser();
		const raw = this.storageService.get(SELECTED_ACCOUNT_KEY, StorageScope.APPLICATION);
		if (!user || !raw) {
			return undefined;
		}
		try {
			const stored = JSON.parse(raw) as { user?: string; account?: string };
			return stored.user === user.id ? stored.account : undefined;
		} catch {
			return undefined;
		}
	}

	private setSelectedAccount(accountId: string | undefined): void {
		const user = this.accountService.getUser();
		if (!user || !accountId) {
			this.storageService.remove(SELECTED_ACCOUNT_KEY, StorageScope.APPLICATION);
			return;
		}
		this.storageService.store(SELECTED_ACCOUNT_KEY, JSON.stringify({ user: user.id, account: accountId }), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	/** The user's GitHub accounts on OTHCloud; `undefined` from servers that can't list them yet. */
	private async listAccounts(token: string): Promise<IGithubAccountsResponse | undefined> {
		const res = await fetch(`${getOthcloudBaseUrl()}/api/desktop/github-accounts`, {
			headers: { 'Authorization': `Bearer ${token}` },
		});
		if (res.status === 404 || res.status === 405) {
			return undefined;
		}
		if (!res.ok) {
			throw new OthcloudAccountApiError(res.status, `HTTP ${res.status}`);
		}
		return await res.json() as IGithubAccountsResponse;
	}

	/** Uses `accountId` from now on and tells every GitHub consumer. */
	private async useAccount(accountId: string): Promise<boolean> {
		const token = await this.accountService.getToken();
		if (!token) {
			return false;
		}
		const result = await this.requestToken(token, accountId).catch(() => undefined);
		if (!result?.connected) {
			this.notificationService.warn(localize('othcloud.github.accountUnavailable', "That GitHub account can't be used right now: it may have been removed from OTHCloud or its access revoked on GitHub."));
			return false;
		}
		this.setSelectedAccount(accountId);
		const session = this.adopt(result.response);
		this.notificationService.info(localize('othcloud.github.switched', "OTerminal now uses GitHub as {0}.", session.account.label));
		return true;
	}

	/**
	 * Lists the user's GitHub accounts on OTHCloud (their own linked accounts and their
	 * organizations' git providers) to pick the one OTerminal uses, or add another.
	 */
	private async switchAccount(): Promise<void> {
		const token = await this.accountService.getToken();
		if (!token) {
			this.notificationService.info(localize('othcloud.github.signInFirst', "Sign in to OTHCloud first, then connect GitHub."));
			return;
		}

		type Item = IQuickPickItem & { run: () => Promise<unknown> };
		const removeButton = { iconClass: ThemeIcon.asClassName(Codicon.trash), tooltip: localize('othcloud.github.removeAccount', "Remove from OTHCloud") };
		const picker = this.quickInputService.createQuickPick<Item>({ useSeparators: true });
		picker.title = localize('othcloud.github.switchTitle', "GitHub Account");
		picker.placeholder = localize('othcloud.github.switchPlaceholder', "Choose the GitHub account OTerminal uses for cloning, pushing and repositories");
		picker.busy = true;
		picker.show();

		const load = async () => {
			picker.busy = true;
			let list: IGithubAccountsResponse | undefined;
			try {
				list = await this.listAccounts(token);
			} catch (err) {
				picker.hide();
				this.notificationService.error(localize('othcloud.github.listFailed', "Couldn't load your GitHub accounts from OTHCloud: {0}", String((err as Error).message ?? err)));
				return;
			}
			const current = this.cached?.response.accountId ?? this.getSelectedAccount();
			const items: Array<Item | IQuickPickSeparator> = [];
			if (list) {
				if (list.accounts.length) {
					items.push({ type: 'separator', label: localize('othcloud.github.accountsOnOthcloud', "On OTHCloud") });
				}
				for (const account of list.accounts) {
					const traits = [
						account.kind === 'user'
							? (account.canPush ? localize('othcloud.github.traitPush', "clone and push") : localize('othcloud.github.traitReadOnly', "read-only"))
							: localize('othcloud.github.traitApp', "organization GitHub App"),
					];
					if (account.deployable) {
						traits.push(localize('othcloud.github.traitDeploy', "deploys"));
					}
					items.push({
						id: account.id,
						label: `${account.id === current ? '$(check) ' : ''}${account.label}`,
						description: account.login && account.login !== account.label ? account.login : undefined,
						detail: traits.join(' · '),
						iconClass: account.id === current ? undefined : ThemeIcon.asClassName(account.kind === 'user' ? Codicon.account : Codicon.organization),
						buttons: account.id.startsWith('user:') ? [removeButton] : undefined,
						run: () => this.useAccount(account.id),
					});
				}
			}
			items.push({ type: 'separator', label: localize('othcloud.github.addAccount', "Add") });
			items.push({
				label: localize('othcloud.github.signInHere', "$(github) Sign in to GitHub in OTerminal..."),
				detail: localize('othcloud.github.signInHereDetail', "Use any GitHub account; it is saved on OTHCloud so projects can deploy from it too"),
				run: () => this.signInWithToken(),
			});
			if (list?.connectAvailable !== false) {
				items.push({
					label: localize('othcloud.github.connectOnWebsite', "$(globe) Connect a GitHub account on the OTHCloud website..."),
					run: () => this.connect(list?.connectPath),
				});
			}
			if (!list) {
				items.push({ type: 'separator', label: localize('othcloud.github.serverOld', "This OTHCloud server can't list GitHub accounts yet") });
			}
			picker.items = items;
			picker.busy = false;
		};

		const disposables = [
			picker.onDidAccept(() => {
				const item = picker.selectedItems[0];
				picker.hide();
				void item?.run();
			}),
			picker.onDidTriggerItemButton(async e => {
				const accountId = e.item.id;
				if (!accountId) {
					return;
				}
				try {
					const res = await fetch(`${getOthcloudBaseUrl()}/api/desktop/github-accounts?account=${encodeURIComponent(accountId)}`, {
						method: 'DELETE',
						headers: { 'Authorization': `Bearer ${token}` },
					});
					if (res.status === 409) {
						this.notificationService.warn(localize('othcloud.github.lastLogin', "That GitHub account is how you sign in to OTHCloud, so it can't be removed."));
						return;
					}
					if (!res.ok) {
						throw new OthcloudAccountApiError(res.status, `HTTP ${res.status}`);
					}
				} catch (err) {
					this.notificationService.error(localize('othcloud.github.removeFailed', "Couldn't remove the GitHub account: {0}", String((err as Error).message ?? err)));
					return;
				}
				if (this.getSelectedAccount() === accountId || this.cached?.response.accountId === accountId) {
					this.setSelectedAccount(undefined);
					void this.removeSession(accountId);
				}
				await load();
			}),
			picker.onDidHide(() => {
				for (const d of disposables) {
					d.dispose();
				}
				picker.dispose();
			}),
		];

		await load();
	}

	/**
	 * Signs in to any GitHub account from OTerminal with a token the user creates on GitHub,
	 * saves it on OTHCloud (as a linked account, and as a git provider so projects can deploy
	 * from it) and switches to it.
	 */
	private async signInWithToken(): Promise<void> {
		const othcloudToken = await this.accountService.getToken();
		if (!othcloudToken) {
			this.notificationService.info(localize('othcloud.github.signInFirst', "Sign in to OTHCloud first, then connect GitHub."));
			return;
		}

		const create = await this.quickInputService.pick([
			{ id: 'create', label: localize('othcloud.github.createToken', "$(link-external) Create a token on GitHub"), detail: localize('othcloud.github.createTokenDetail', "Opens GitHub signed in as the account you want, with the repo, workflow and read:org scopes filled in") },
			{ id: 'have', label: localize('othcloud.github.haveToken', "$(key) I already have a token") },
		], { title: localize('othcloud.github.signInTitle', "Sign in to GitHub") });
		if (!create) {
			return;
		}
		if (create.id === 'create') {
			await this.openerService.open(URI.parse(NEW_TOKEN_URL), { openExternal: true });
		}

		const githubToken = await this.quickInputService.input({
			title: localize('othcloud.github.signInTitle', "Sign in to GitHub"),
			prompt: localize('othcloud.github.tokenPrompt', "Paste a GitHub token (classic with the repo scope, or fine-grained). It is stored on OTHCloud for this account."),
			placeHolder: 'ghp_... / github_pat_...',
			password: true,
			ignoreFocusLost: true,
			validateInput: async value => value.trim() ? undefined : localize('othcloud.github.tokenEmpty', "Paste the token"),
		});
		if (!githubToken?.trim()) {
			return;
		}

		let account: IGithubAccount;
		try {
			const res = await fetch(`${getOthcloudBaseUrl()}/api/desktop/github-accounts`, {
				method: 'POST',
				headers: { 'Authorization': `Bearer ${othcloudToken}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ token: githubToken.trim(), deployProvider: true }),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => undefined) as { error?: string; message?: string } | undefined;
				this.notificationService.error(describeAddAccountError(res.status, body?.error, body?.message));
				return;
			}
			account = (await res.json() as { account: IGithubAccount }).account;
		} catch (err) {
			this.notificationService.error(localize('othcloud.github.addFailed', "Couldn't save the GitHub account on OTHCloud: {0}", String((err as Error).message ?? err)));
			return;
		}
		await this.useAccount(account.id);
	}

	/**
	 * Whether the server can link GitHub accounts at all: the connect page needs GitHub
	 * sign-in configured there (the same public list the website's sign-in form reads).
	 * Unknown (e.g. offline) counts as available, so the page can explain.
	 */
	private async isConnectAvailable(): Promise<boolean> {
		try {
			const res = await fetch(`${getOthcloudBaseUrl()}/api/trpc/settings.socialProviders`);
			if (!res.ok) {
				return true;
			}
			const body = await res.json() as { result?: { data?: { json?: { github?: boolean } } } };
			return body.result?.data?.json?.github !== false;
		} catch {
			return true;
		}
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
		if (!(await this.isConnectAvailable())) {
			this.notificationService.warn(localize('othcloud.github.connectUnavailable', "{0} can't connect GitHub accounts yet: GitHub sign-in isn't set up on the server (GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET). Until then, OTerminal uses your organization's GitHub App.", getOthcloudBaseUrl()));
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
				// The account just connected is the one to use, over any earlier pick
				this.setSelectedAccount(result.response.accountId);
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

/** Says why OTHCloud didn't take a GitHub token from "Sign in to GitHub". */
function describeAddAccountError(status: number, code: string | undefined, message: string | undefined): string {
	switch (code) {
		case 'invalid_token':
			return localize('othcloud.github.invalidToken', "GitHub didn't accept that token. Check it was copied whole and hasn't expired.");
		case 'missing_repo_scope':
			return localize('othcloud.github.missingRepoScope', "That token can't reach repositories. Create one with the repo scope.");
		case 'linked_to_other_user':
			return localize('othcloud.github.linkedToOther', "That GitHub account is already linked to a different OTHCloud account.");
	}
	if (status === 404 || status === 405) {
		return localize('othcloud.github.addUnsupported', "This OTHCloud server can't save GitHub accounts from OTerminal yet.");
	}
	return localize('othcloud.github.addFailed', "Couldn't save the GitHub account on OTHCloud: {0}", message ?? `HTTP ${status}`);
}
