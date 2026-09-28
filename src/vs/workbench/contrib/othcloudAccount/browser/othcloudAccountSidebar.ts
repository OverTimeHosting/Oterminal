/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { $, addDisposableListener, append, clearNode, EventType, isActiveElement } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { IntervalTimer, RunOnceScheduler, TimeoutTimer } from '../../../../base/common/async.js';
import { fromNow } from '../../../../base/common/date.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import {
	Extensions as ViewExtensions,
	IViewContainersRegistry,
	IViewDescriptor,
	IViewsRegistry,
	IViewDescriptorService,
	ViewContainer,
	ViewContainerLocation,
} from '../../../common/views.js';
import { IOthcloudAccountService, IOthcloudUser } from '../common/othcloudAccountService.js';
import { getOthcloudBaseUrl, IOthcloudDevEnvStatus, IOthcloudServiceRow, IOthcloudServices, OthcloudAccountApiError, OthcloudAccountClient } from './othcloudAccountClient.js';
import { OPEN_REMOTE_COMMAND, START_COMMAND, STOP_COMMAND } from './othcloudDevEnvironments.js';
import { BrowserViewUri } from '../../../../platform/browserView/common/browserViewUri.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';

export const OTHCLOUD_ACCOUNT_VIEW_CONTAINER_ID = 'workbench.view.othcloudAccount';
export const OTHCLOUD_ACCOUNT_VIEW_ID = 'workbench.view.othcloudAccount.home';

const SIGN_IN_COMMAND = 'othcloud.account.signIn';
const SIGN_OUT_COMMAND = 'othcloud.account.signOut';

/** Reload the projects this often while the panel is visible. */
const AUTO_REFRESH_INTERVAL = 5 * 60 * 1000;
/** Reload when the panel is shown again if the list is older than this. */
const STALE_AFTER = 60 * 1000;
/** Delays between automatic retries after a failed load. */
const RETRY_DELAYS = [15, 30, 60, 120, 300].map(seconds => seconds * 1000);

interface IFriendlyError {
	readonly title: string;
	readonly detail: string;
}

interface ISectionDef {
	/** Dev environment rows get remote-editing actions instead of the link ones. */
	readonly devEnvironments?: boolean;
	readonly label: string;
	readonly ariaLabel: string;
	/** Icon of the top-level rows (environments always use the server environment icon). */
	readonly icon: ThemeIcon;
	/** `undefined` when the server does not send this list at all. */
	readonly rows: readonly IOthcloudServiceRow[] | undefined;
	readonly emptyLabel: string;
	readonly emptyAction: { readonly label: string; readonly path: string };
}

/**
 * The desktop API resolves avatars against the site origin, which mangles an
 * inline avatar into `https://host/data:image/...` - a path that can never
 * load, leaving the user with the fallback glyph. Recover the embedded URI so
 * the avatar still renders against servers that have not been fixed yet.
 */
function normalizeAvatarUrl(raw: string): string {
	const dataIndex = raw.indexOf('data:');
	return dataIndex > 0 ? raw.slice(dataIndex) : raw;
}

function toAbsoluteOthcloudUrl(path: string): string {
	return path.startsWith('http://') || path.startsWith('https://')
		? path
		: getOthcloudBaseUrl() + (path.startsWith('/') ? path : '/' + path);
}

function othcloudHostLabel(): string {
	try {
		return new URL(getOthcloudBaseUrl()).host;
	} catch {
		return 'OTHCloud'; // relative base URL (web build)
	}
}

/** Turns a failed load into something a person can act on. */
function describeError(err: unknown): IFriendlyError {
	if (err instanceof OthcloudAccountApiError) {
		if (err.status === 403) {
			return {
				title: localize('othcloud.account.error.forbidden', "You don't have access to this account's services"),
				detail: localize('othcloud.account.error.forbiddenDetail', "Ask an owner of your organization to give you access, then refresh."),
			};
		}
		if (err.status >= 500) {
			return {
				title: localize('othcloud.account.error.server', "OTHCloud is having trouble right now"),
				detail: localize('othcloud.account.error.serverDetail', "The server answered with HTTP {0}. This will retry automatically.", err.status),
			};
		}
		return {
			title: localize('othcloud.account.error.generic', "Couldn't load your OTHCloud services"),
			detail: err.message,
		};
	}
	// `fetch` rejects with a TypeError when the request never got an answer
	if (err instanceof TypeError) {
		if (!navigator.onLine) {
			return {
				title: localize('othcloud.account.error.offline', "You're offline"),
				detail: localize('othcloud.account.error.offlineDetail', "Everything will load again as soon as you're back online."),
			};
		}
		return {
			title: localize('othcloud.account.error.unreachable', "Can't reach {0}", othcloudHostLabel()),
			detail: localize('othcloud.account.error.unreachableDetail', "Check your internet connection. This will retry automatically."),
		};
	}
	return {
		title: localize('othcloud.account.error.generic', "Couldn't load your OTHCloud services"),
		detail: String((err as Error)?.message ?? err),
	};
}

type StatusCategory = 'ok' | 'busy' | 'error' | 'off' | 'unknown';

function statusCategory(status: string): StatusCategory {
	const s = status.toLowerCase();
	if (/^(running|active|online|healthy|deployed|done|ready|up)$/.test(s)) {
		return 'ok';
	}
	if (/^(pending|queued|building|deploying|starting|restarting|provisioning|updating)$/.test(s)) {
		return 'busy';
	}
	if (/^(error|failed|failure|crashed|unhealthy|down)$/.test(s)) {
		return 'error';
	}
	if (/^(stopped|inactive|offline|paused|idle|suspended|disabled)$/.test(s)) {
		return 'off';
	}
	return 'unknown';
}

class OthcloudAccountSidebarView extends ViewPane {

	static readonly TITLE = localize2('othcloud.account.sidebarViewTitle', 'OTHCloud');

	private services: IOthcloudServices | undefined;
	private loading = false;
	private error: IFriendlyError | undefined;
	private lastLoaded: number | undefined;
	/** Bumped on every fetch so out-of-order responses can be ignored. */
	private fetchSeq = 0;
	/** Id of the account the loaded projects belong to. */
	private loadedForUserId: string | undefined;

	/** Live dev environment state per application id, fetched after each load. */
	private readonly devEnvStatuses = new Map<string, IOthcloudDevEnvStatus | 'loading' | 'failed'>();
	private devEnvSeq = 0;
	private readonly devEnvRenderScheduler = this._register(new RunOnceScheduler(() => this.renderSections(), 50));

	/** IDs of rows currently expanded (parent rows only). */
	private readonly expandedRows = new Set<string>();

	private wrap: HTMLElement | undefined;
	private headerEl: HTMLElement | undefined;
	private refreshButton: HTMLButtonElement | undefined;
	private refreshIcon: HTMLElement | undefined;
	private sectionsEl: HTMLElement | undefined;
	/** Rendered rows, in display order. */
	private rowElements: HTMLElement[] = [];
	/** Disposables of the signed-in/signed-out UI, replaced on every full render. */
	private readonly renderDisposables = this._register(new DisposableStore());
	/** Disposables of the project and game server lists, replaced on every list render. */
	private readonly sectionsDisposables = this._register(new DisposableStore());

	private readonly autoRefreshTimer = this._register(new IntervalTimer());
	private readonly retryTimer = this._register(new TimeoutTimer());
	private retryAttempt = 0;

	/** Cache of avatar source URL → resolved blob URL, so we don't re-fetch on every rerender. */
	private avatarBlobCache: { source: string; blobUrl: string } | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IOthcloudAccountService private readonly accountService: IOthcloudAccountService,
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	override dispose(): void {
		if (this.avatarBlobCache) {
			URL.revokeObjectURL(this.avatarBlobCache.blobUrl);
			this.avatarBlobCache = undefined;
		}
		super.dispose();
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('othcloud-account-sidebar');

		this.wrap = append(container, $('div.othcloud-account-wrap'));
		this.renderView();

		this._register(this.accountService.onDidChangeAuth(() => {
			const user = this.accountService.getUser();
			if (user && user.id === this.loadedForUserId) {
				// Same account, profile details changed: only the header needs repainting
				this.renderAccountHeader(user);
				return;
			}
			this.resetProjects();
			this.renderView();
			if (user) {
				void this.refresh();
			}
		}));

		// Keep the list fresh while it is on screen, and only then
		this._register(this.onDidChangeBodyVisibility(visible => this.onVisibilityChanged(visible)));
		this._register(addDisposableListener(mainWindow, 'online', () => {
			if (this.isBodyVisible() && this.accountService.isSignedIn()) {
				void this.refresh();
			}
		}));

		if (this.isBodyVisible()) {
			this.onVisibilityChanged(true);
		}
	}

	private onVisibilityChanged(visible: boolean): void {
		if (!visible) {
			this.autoRefreshTimer.cancel();
			this.retryTimer.cancel();
			return;
		}
		this.autoRefreshTimer.cancelAndSet(() => void this.refresh(), AUTO_REFRESH_INTERVAL, mainWindow);
		const stale = this.lastLoaded === undefined || Date.now() - this.lastLoaded > STALE_AFTER;
		if (this.accountService.isSignedIn() && (stale || this.error)) {
			void this.refresh();
		}
	}

	private resetProjects(): void {
		this.fetchSeq++; // drop any in-flight result
		this.services = undefined;
		this.loading = false;
		this.error = undefined;
		this.lastLoaded = undefined;
		this.loadedForUserId = undefined;
		this.expandedRows.clear();
		this.devEnvSeq++;
		this.devEnvStatuses.clear();
		this.retryTimer.cancel();
		this.retryAttempt = 0;
	}

	private renderView(): void {
		if (!this.wrap) {
			return;
		}
		this.renderDisposables.clear();
		this.sectionsDisposables.clear();
		clearNode(this.wrap);
		this.headerEl = this.refreshButton = this.refreshIcon = this.sectionsEl = undefined;
		this.rowElements = [];

		const user = this.accountService.getUser();
		if (user) {
			this.renderSignedIn(this.wrap, user);
		} else {
			this.renderSignedOut(this.wrap);
		}
	}

	private renderSignedOut(parent: HTMLElement): void {
		const card = append(parent, $('.othcloud-account-card.signed-out'));
		append(card, $('span.othcloud-account-card-icon' + ThemeIcon.asCSSSelector(Codicon.cloud)));
		append(card, $('.othcloud-account-title', {}, localize('othcloud.account.signInTitle', 'Sign in to OTHCloud')));
		append(card, $('.othcloud-account-subtitle', {},
			localize('othcloud.account.signInBlurb', 'Link this terminal to your othcloud.xyz account to see and manage your projects.'),
		));

		const cta = append(card, $('button.othcloud-account-button.primary')) as HTMLButtonElement;
		cta.textContent = localize('othcloud.account.signInCta', 'Sign in at othcloud.xyz');
		cta.onclick = () => this.commandService.executeCommand(SIGN_IN_COMMAND);
	}

	private renderSignedIn(parent: HTMLElement, user: IOthcloudUser): void {
		this.headerEl = append(parent, $('.othcloud-account-header'));
		this.renderAccountHeader(user);
		append(parent, $('.othcloud-account-divider'));

		this.sectionsEl = append(parent, $('.othcloud-account-section'));
		this.renderSections();
	}

	private renderAccountHeader(user: IOthcloudUser): void {
		const header = this.headerEl;
		if (!header) {
			return;
		}
		clearNode(header);

		this.renderAvatar(header, user);
		const nameWrap = append(header, $('.othcloud-account-name-wrap'));
		const name = append(nameWrap, $('.othcloud-account-name', {}, user.name || user.email));
		name.title = user.name || user.email;
		if (user.name && user.email) {
			const email = append(nameWrap, $('.othcloud-account-email', {}, user.email));
			email.title = user.email;
		}

		const actions = append(header, $('.othcloud-account-header-actions'));
		this.iconButton(actions, Codicon.window, localize('othcloud.account.openConsoleTooltip', 'Open OTHCloud Console'),
			() => void this.commandService.executeCommand('othcloud.console.open'));
		this.refreshButton = this.iconButton(actions, Codicon.refresh, '', () => void this.refresh());
		this.refreshIcon = this.refreshButton.firstElementChild as HTMLElement;
		this.iconButton(actions, Codicon.signOut, localize('othcloud.account.signOutTooltip', 'Sign out of OTHCloud'),
			() => void this.commandService.executeCommand(SIGN_OUT_COMMAND));
		this.updateRefreshButton();
	}

	private iconButton(parent: HTMLElement, icon: ThemeIcon, label: string, run: (e: MouseEvent) => void): HTMLButtonElement {
		const button = append(parent, $('button.othcloud-account-iconbtn')) as HTMLButtonElement;
		append(button, $('span' + ThemeIcon.asCSSSelector(icon)));
		button.title = label;
		button.setAttribute('aria-label', label);
		button.onclick = e => {
			e.stopPropagation();
			run(e);
		};
		return button;
	}

	private updateRefreshButton(): void {
		if (!this.refreshButton || !this.refreshIcon) {
			return;
		}
		this.refreshIcon.classList.toggle('codicon-modifier-spin', this.loading);
		this.refreshButton.disabled = this.loading;
		const label = this.loading
			? localize('othcloud.account.refreshing', 'Refreshing...')
			: this.lastLoaded
				? localize('othcloud.account.refreshTooltipUpdated', 'Refresh (updated {0})', fromNow(this.lastLoaded, true))
				: localize('othcloud.account.refreshTooltip', 'Refresh');
		this.refreshButton.title = label;
		this.refreshButton.setAttribute('aria-label', label);
	}

	/**
	 * Avatar in the signed-in header. Always uses {@link Codicon.account} as
	 * the fallback (both when no `avatarUrl` is set and when the configured
	 * URL fails to load) so we never end up with a broken-image glyph or
	 * out-of-place initials in the VS Code chrome.
	 *
	 * The workbench CSP only permits `https:` / `data:` / `blob:` for `img-src`,
	 * which blocks `http://localhost:3001` avatars in dev. We work around that
	 * by fetching the avatar bytes and showing it as a `blob:` URL - which
	 * also future-proofs us against private/authed avatar endpoints.
	 */
	private renderAvatar(parent: HTMLElement, user: IOthcloudUser): void {
		const renderFallback = () => {
			const fallback = $('span.othcloud-account-avatar.placeholder' + ThemeIcon.asCSSSelector(Codicon.account));
			parent.insertBefore(fallback, parent.firstChild);
		};
		if (!user.avatarUrl) {
			renderFallback();
			return;
		}

		const img = $('img.othcloud-account-avatar') as HTMLImageElement;
		img.alt = '';
		img.onerror = () => {
			img.remove();
			renderFallback();
		};
		parent.insertBefore(img, parent.firstChild);

		const sourceUrl = normalizeAvatarUrl(user.avatarUrl);

		// Inline images need no network round trip, and `data:` is already
		// permitted by the workbench CSP.
		if (sourceUrl.startsWith('data:')) {
			img.src = sourceUrl;
			return;
		}

		// HTTPS images (prod) are allowed directly by the CSP; HTTP (dev
		// localhost) is not, so we always proxy through a blob URL.
		if (this.avatarBlobCache?.source === sourceUrl) {
			img.src = this.avatarBlobCache.blobUrl;
			return;
		}

		void (async () => {
			try {
				const res = await fetch(sourceUrl);
				if (!res.ok) {
					throw new Error(`HTTP ${res.status}`);
				}
				const blob = await res.blob();
				const blobUrl = URL.createObjectURL(blob);
				// Revoke the previous one before we replace it.
				if (this.avatarBlobCache) {
					URL.revokeObjectURL(this.avatarBlobCache.blobUrl);
				}
				this.avatarBlobCache = { source: sourceUrl, blobUrl };
				if (img.isConnected) {
					img.src = blobUrl;
				}
			} catch {
				if (img.isConnected) {
					img.onerror?.(new Event('error'));
				}
			}
		})();
	}

	//#region Projects and game servers

	private renderSections(): void {
		const container = this.sectionsEl;
		if (!container) {
			return;
		}
		// Keep keyboard focus on the same row across re-renders
		const focusedId = this.rowElements.find(item => isActiveElement(item))?.dataset.rowId;
		this.sectionsDisposables.clear();
		this.rowElements = [];
		clearNode(container);

		const services = this.services;
		if (!services) {
			if (this.error) {
				this.renderErrorCard(container, this.error);
			} else {
				this.renderSkeleton(container);
			}
			return;
		}

		if (this.error) {
			this.renderErrorBanner(container, this.error);
		}

		const sections: readonly ISectionDef[] = [
			{
				label: localize('othcloud.account.projects', 'Projects'),
				ariaLabel: localize('othcloud.account.projectsAria', 'OTHCloud projects'),
				icon: Codicon.project,
				rows: services.projects ?? [],
				emptyLabel: localize('othcloud.account.noProjects', 'No projects yet.'),
				emptyAction: { label: localize('othcloud.account.openDashboard', 'Open the OTHCloud dashboard'), path: '/dashboard' },
			},
			{
				devEnvironments: true,
				label: localize('othcloud.account.devEnvironments', 'Dev Environments'),
				ariaLabel: localize('othcloud.account.devEnvironmentsAria', 'OTHCloud dev environments'),
				icon: Codicon.remote,
				rows: services.applications && this.withDevEnvStatus(services.applications),
				emptyLabel: localize('othcloud.account.noApplications', 'No applications yet.'),
				emptyAction: { label: localize('othcloud.account.openDashboard', 'Open the OTHCloud dashboard'), path: '/dashboard' },
			},
			{
				label: localize('othcloud.account.gameServers', 'Game Servers'),
				ariaLabel: localize('othcloud.account.gameServersAria', 'OTHCloud game servers'),
				icon: Codicon.game,
				rows: services.gameServers,
				emptyLabel: localize('othcloud.account.noGameServers', 'No game servers yet.'),
				emptyAction: { label: localize('othcloud.account.browseGameServers', 'Browse game servers'), path: '/dashboard/games' },
			},
		];
		sections.forEach((def, index) => {
			if (index > 0) {
				append(container, $('.othcloud-account-divider'));
			}
			this.renderSection(container, def);
		});

		// Roving tab index: all rows together are one tab stop, arrow keys move between them
		const items = this.rowElements;
		if (items.length) {
			const focusTarget = items.find(item => item.dataset.rowId === focusedId);
			(focusTarget ?? items[0]).tabIndex = 0;
			focusTarget?.focus();
		}
	}

	private renderSection(parent: HTMLElement, def: ISectionDef): void {
		const section = append(parent, $('.othcloud-account-section'));
		const header = append(section, $('.othcloud-account-section-header'));
		append(header, $('span.othcloud-account-section-label', {}, def.label));

		if (!def.rows) {
			// An othcloud.xyz from before this section existed
			append(section, $('.othcloud-account-empty', {},
				localize('othcloud.account.sectionUnsupported', 'This will show up once othcloud.xyz is updated.')));
			return;
		}

		if (def.rows.length) {
			append(header, $('span.othcloud-account-section-count', {}, String(def.rows.length)));
		}

		if (def.rows.length === 0) {
			const empty = append(section, $('.othcloud-account-empty'));
			append(empty, $('div', {}, def.emptyLabel));
			const action = append(empty, $('button.othcloud-account-button.secondary')) as HTMLButtonElement;
			action.textContent = def.emptyAction.label;
			action.onclick = () => void this.openInEditor(def.emptyAction.path);
			return;
		}

		const tree = append(section, $('.othcloud-account-tree'));
		tree.setAttribute('role', 'tree');
		tree.setAttribute('aria-label', def.ariaLabel);
		this.sectionsDisposables.add(addDisposableListener(tree, EventType.KEY_DOWN, (e: KeyboardEvent) => this.onTreeKeyDown(e)));

		for (const row of def.rows) {
			const children = row.children ?? [];
			const expanded = children.length > 0 && this.expandedRows.has(row.id);
			this.renderRow(tree, row, def.icon, 0, children.length > 0, expanded, undefined, def.devEnvironments);
			if (expanded) {
				for (const child of children) {
					this.renderRow(tree, child, Codicon.serverEnvironment, 1, false, false, row);
				}
			}
		}
	}

	private renderRow(parent: HTMLElement, row: IOthcloudServiceRow, icon: ThemeIcon, depth: number, hasChildren: boolean, expanded: boolean, parentRow?: IOthcloudServiceRow, devEnvironment = false): void {
		const el = append(parent, $('.othcloud-account-item'));
		el.dataset.rowId = row.id;
		if (parentRow) {
			el.dataset.parentId = parentRow.id;
		}
		el.tabIndex = -1;
		el.setAttribute('role', 'treeitem');
		el.setAttribute('aria-level', String(depth + 1));
		if (hasChildren) {
			el.setAttribute('aria-expanded', String(expanded));
		}
		el.style.paddingLeft = `${4 + depth * 16}px`;

		const main = append(el, $('.othcloud-account-item-main'));
		const twistie = append(main, $('span.othcloud-account-item-twistie'));
		if (hasChildren) {
			twistie.classList.add(...ThemeIcon.asClassNameArray(expanded ? Codicon.chevronDown : Codicon.chevronRight));
		}
		append(main, $('span.othcloud-account-item-icon' + ThemeIcon.asCSSSelector(icon)));
		const name = append(main, $('span.othcloud-account-item-name', {}, row.name));

		if (row.status) {
			const category = statusCategory(row.status);
			const status = append(main, $(`span.othcloud-account-item-status.s-${category}`));
			append(status, $('span.othcloud-account-item-status-dot'));
			append(status, $('span.othcloud-account-item-status-label', {}, row.status));
		}

		if (devEnvironment) {
			const actions = append(main, $('.othcloud-account-item-actions'));
			this.iconButton(actions, Codicon.remote, localize('othcloud.account.openRemote', 'Open Remotely'), () => void this.openDevEnvironment(row));
			if (this.isDevEnvRunning(row.id)) {
				this.iconButton(actions, Codicon.debugStop, localize('othcloud.account.stopDevEnv', 'Stop Dev Environment'), () => void this.stopDevEnvironment(row));
			} else {
				this.iconButton(actions, Codicon.debugStart, localize('othcloud.account.startDevEnv', 'Start Dev Environment'), () => void this.startDevEnvironment(row));
			}
			if (row.url) {
				const url = row.url;
				this.iconButton(actions, Codicon.goToFile, localize('othcloud.account.openOnOthcloud', 'Open on OTHCloud'), () => void this.openInEditor(url));
			}
		} else if (row.url) {
			const url = row.url;
			const actions = append(main, $('.othcloud-account-item-actions'));
			this.iconButton(actions, Codicon.goToFile, localize('othcloud.account.openTab', 'Open in Editor'), () => void this.openInEditor(url));
			this.iconButton(actions, Codicon.linkExternal, localize('othcloud.account.openExternal', 'Open in Browser'), () => void this.openExternal(url));
			this.iconButton(actions, Codicon.copy, localize('othcloud.account.copyLink', 'Copy Link'), () => void this.copyLink(url));
		}

		const metaLine = row.meta ? Object.values(row.meta).filter(Boolean).join(' · ') : '';
		if (metaLine) {
			append(el, $('.othcloud-account-item-meta', {}, metaLine));
		}

		name.title = row.url
			? localize('othcloud.account.rowTooltip', '{0}\n{1}', row.name, toAbsoluteOthcloudUrl(row.url))
			: row.name;

		if (devEnvironment) {
			el.dataset.devEnvironment = 'true';
		}
		el.onclick = () => {
			el.focus();
			// Opens the service's OTHCloud page in an editor tab. A remote window
			// stays on the row's button and in the menu, being too heavy for a click.
			this.activateRow(row, hasChildren);
		};
		el.ondblclick = () => {
			if (hasChildren && row.url) {
				void this.openInEditor(row.url);
			}
		};
		el.oncontextmenu = e => {
			e.preventDefault();
			this.showRowMenu(row, { x: e.clientX, y: e.clientY }, devEnvironment);
		};
		el.onfocus = () => {
			for (const item of this.rowElements) {
				item.tabIndex = item === el ? 0 : -1;
			}
		};
		this.rowElements.push(el);
	}

	/** Click / Enter: projects expand and collapse, environments open. */
	private activateRow(row: IOthcloudServiceRow, hasChildren: boolean): void {
		if (hasChildren) {
			this.setRowExpanded(row.id, !this.expandedRows.has(row.id));
		} else if (row.url) {
			void this.openInEditor(row.url);
		}
	}

	private setRowExpanded(id: string, expanded: boolean): void {
		if (expanded) {
			this.expandedRows.add(id);
		} else {
			this.expandedRows.delete(id);
		}
		this.renderSections();
	}

	private onTreeKeyDown(e: KeyboardEvent): void {
		const items = this.rowElements;
		const current = items.find(item => item === e.target);
		if (!current) {
			return; // keys pressed on a row's action buttons behave as buttons
		}
		const index = items.indexOf(current);
		const row = this.findRow(current.dataset.rowId);
		const hasChildren = current.hasAttribute('aria-expanded');
		const expanded = current.getAttribute('aria-expanded') === 'true';

		switch (e.key) {
			case 'ArrowDown':
				items[index + 1]?.focus();
				break;
			case 'ArrowUp':
				items[index - 1]?.focus();
				break;
			case 'Home':
				items[0]?.focus();
				break;
			case 'End':
				items[items.length - 1]?.focus();
				break;
			case 'ArrowRight':
				if (hasChildren && !expanded) {
					this.setRowExpanded(current.dataset.rowId!, true);
				} else if (hasChildren) {
					items[index + 1]?.focus();
				}
				break;
			case 'ArrowLeft':
				if (hasChildren && expanded) {
					this.setRowExpanded(current.dataset.rowId!, false);
				} else if (current.dataset.parentId) {
					items.find(item => item.dataset.rowId === current.dataset.parentId)?.focus();
				}
				break;
			case 'Enter':
			case ' ':
				if (row) {
					this.activateRow(row, hasChildren);
				}
				break;
			case 'ContextMenu':
			case 'F10':
				if (e.key === 'F10' && !e.shiftKey) {
					return;
				}
				if (row) {
					const rect = current.getBoundingClientRect();
					this.showRowMenu(row, { x: rect.left + 16, y: rect.bottom }, !!current.dataset.devEnvironment);
				}
				break;
			default:
				return;
		}
		e.preventDefault();
		e.stopPropagation();
	}

	private findRow(id: string | undefined): IOthcloudServiceRow | undefined {
		for (const project of [...this.services?.projects ?? [], ...this.services?.applications ?? [], ...this.services?.gameServers ?? []]) {
			if (project.id === id) {
				return project;
			}
			const child = project.children?.find(c => c.id === id);
			if (child) {
				return child;
			}
		}
		return undefined;
	}

	private showRowMenu(row: IOthcloudServiceRow, anchor: { x: number; y: number }, devEnvironment = false): void {
		const actions: IAction[] = [];
		if (devEnvironment) {
			const running = this.isDevEnvRunning(row.id);
			actions.push(
				toAction({ id: 'othcloud.row.openRemote', label: localize('othcloud.account.openRemote', 'Open Remotely'), run: () => this.openDevEnvironment(row) }),
				running
					? toAction({ id: 'othcloud.row.stopDevEnv', label: localize('othcloud.account.stopDevEnv', 'Stop Dev Environment'), run: () => this.stopDevEnvironment(row) })
					: toAction({ id: 'othcloud.row.startDevEnv', label: localize('othcloud.account.startDevEnv', 'Start Dev Environment'), run: () => this.startDevEnvironment(row) }),
				new Separator(),
			);
		}
		if (row.url) {
			const url = row.url;
			actions.push(
				toAction({ id: 'othcloud.row.open', label: localize('othcloud.account.openTab', 'Open in Editor'), run: () => this.openInEditor(url) }),
				toAction({ id: 'othcloud.row.openExternal', label: localize('othcloud.account.openExternal', 'Open in Browser'), run: () => this.openExternal(url) }),
				toAction({ id: 'othcloud.row.copyLink', label: localize('othcloud.account.copyLink', 'Copy Link'), run: () => this.copyLink(url) }),
			);
		}
		const address = row.meta?.address;
		if (address) {
			actions.push(toAction({ id: 'othcloud.row.copyAddress', label: localize('othcloud.account.copyAddress', 'Copy Server Address'), run: () => this.clipboardService.writeText(address) }));
		}
		if (actions.length) {
			actions.push(new Separator());
		}
		actions.push(toAction({ id: 'othcloud.row.refresh', label: localize('othcloud.account.refreshList', 'Refresh'), run: () => this.refresh() }));
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
		});
	}

	/**
	 * Applications with their dev environment's state as the row status,
	 * running ones first.
	 */
	private withDevEnvStatus(rows: readonly IOthcloudServiceRow[]): IOthcloudServiceRow[] {
		const withStatus = rows.map(row => {
			const status = this.devEnvStatuses.get(row.id);
			const label = typeof status === 'object'
				? status.state === 'running'
					? localize('othcloud.account.devEnv.running', 'running')
					: status.state === 'stopped'
						? localize('othcloud.account.devEnv.stopped', 'stopped')
						: localize('othcloud.account.devEnv.unavailable', 'unavailable')
				: undefined;
			return { ...row, status: label, running: this.isDevEnvRunning(row.id) };
		});
		withStatus.sort((a, b) => Number(b.running) - Number(a.running));
		return withStatus.map(({ running: _running, ...row }) => row);
	}

	private isDevEnvRunning(applicationId: string): boolean {
		const status = this.devEnvStatuses.get(applicationId);
		return typeof status === 'object' && status.state === 'running';
	}

	/** Reads each application's dev environment state, a few at a time. */
	private async loadDevEnvStatuses(): Promise<void> {
		const applications = this.services?.applications;
		const token = await this.accountService.getToken();
		if (!applications?.length || !token) {
			return;
		}
		const seq = ++this.devEnvSeq;
		const queue = applications.map(app => app.id);
		const worker = async () => {
			for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
				if (!this.devEnvStatuses.has(id)) {
					this.devEnvStatuses.set(id, 'loading');
				}
				let status: IOthcloudDevEnvStatus | 'failed';
				try {
					status = await OthcloudAccountClient.devEnvironmentStatus(token, id);
				} catch {
					status = 'failed';
				}
				if (seq !== this.devEnvSeq) {
					return;
				}
				this.devEnvStatuses.set(id, status);
				this.devEnvRenderScheduler.schedule();
			}
		};
		await Promise.all([worker(), worker(), worker(), worker()]);
	}

	private async openDevEnvironment(row: IOthcloudServiceRow): Promise<void> {
		await this.commandService.executeCommand(OPEN_REMOTE_COMMAND, row.id, row.name);
		void this.refreshDevEnvStatus(row.id);
	}

	private async startDevEnvironment(row: IOthcloudServiceRow): Promise<void> {
		this.devEnvStatuses.set(row.id, 'loading');
		this.renderSections();
		const status = await this.commandService.executeCommand<IOthcloudDevEnvStatus | undefined>(START_COMMAND, row.id, row.name);
		if (status) {
			this.devEnvStatuses.set(row.id, status);
			this.renderSections();
		} else {
			void this.refreshDevEnvStatus(row.id);
		}
	}

	private async stopDevEnvironment(row: IOthcloudServiceRow): Promise<void> {
		const stopped = await this.commandService.executeCommand<boolean>(STOP_COMMAND, row.id, row.name);
		if (stopped) {
			void this.refreshDevEnvStatus(row.id);
		}
	}

	private async refreshDevEnvStatus(applicationId: string): Promise<void> {
		const token = await this.accountService.getToken();
		if (!token) {
			return;
		}
		try {
			this.devEnvStatuses.set(applicationId, await OthcloudAccountClient.devEnvironmentStatus(token, applicationId));
		} catch {
			this.devEnvStatuses.set(applicationId, 'failed');
		}
		this.renderSections();
	}

	private renderSkeleton(parent: HTMLElement): void {
		const skeleton = append(parent, $('.othcloud-account-skeleton'));
		skeleton.setAttribute('aria-busy', 'true');
		skeleton.setAttribute('aria-label', localize('othcloud.account.loading', 'Loading'));
		for (const width of [70, 52, 62]) {
			const line = append(skeleton, $('.othcloud-account-skeleton-row'));
			append(line, $('span.othcloud-account-skeleton-icon'));
			append(line, $('span.othcloud-account-skeleton-text')).style.width = `${width}%`;
		}
	}

	private renderErrorCard(parent: HTMLElement, error: IFriendlyError): void {
		const card = append(parent, $('.othcloud-account-error-card'));
		card.setAttribute('role', 'alert');
		append(card, $('span.othcloud-account-error-icon' + ThemeIcon.asCSSSelector(Codicon.warning)));
		append(card, $('.othcloud-account-error-title', {}, error.title));
		append(card, $('.othcloud-account-error-detail', {}, error.detail));
		const retry = append(card, $('button.othcloud-account-button.secondary')) as HTMLButtonElement;
		retry.textContent = localize('othcloud.account.retry', 'Try Again');
		retry.disabled = this.loading;
		retry.onclick = () => void this.refresh();
	}

	/** Shown above a list that is still usable but could not be refreshed. */
	private renderErrorBanner(parent: HTMLElement, error: IFriendlyError): void {
		const banner = append(parent, $('.othcloud-account-error-banner'));
		banner.setAttribute('role', 'status');
		append(banner, $('span' + ThemeIcon.asCSSSelector(Codicon.warning)));
		const text = append(banner, $('span.othcloud-account-error-banner-text', {},
			localize('othcloud.account.staleList', "{0}. Showing the last loaded list.", error.title)));
		text.title = error.detail;
		const retry = append(banner, $('button.othcloud-account-link')) as HTMLButtonElement;
		retry.textContent = localize('othcloud.account.retryShort', 'Retry');
		retry.disabled = this.loading;
		retry.onclick = () => void this.refresh();
	}

	//#endregion

	private async openInEditor(path: string): Promise<void> {
		await this.openInBrowserView(toAbsoluteOthcloudUrl(path));
	}

	private async openExternal(path: string): Promise<void> {
		await this.openerService.open(URI.parse(toAbsoluteOthcloudUrl(path)), { openExternal: true });
	}

	private async copyLink(path: string): Promise<void> {
		await this.clipboardService.writeText(toAbsoluteOthcloudUrl(path));
	}

	/**
	 * Opens an othcloud.xyz page as a new in-editor tab - without the
	 * BrowserView's URL bar / quick-links toolbar (`chrome=hidden` query
	 * flag, stripped in `BrowserEditor.setInput`). Each click adds another
	 * tab; the group locks so subsequent navigations don't pollute the user's
	 * code editor tabs.
	 *
	 * The "Open OTHCloud Console" button in the header is still available for
	 * folks who want the standalone window instead.
	 */
	private async openInBrowserView(absolute: string): Promise<void> {
		const targetGroup = this.editorGroupsService.activeGroup;
		await this.editorService.openEditor(
			{
				resource: BrowserViewUri.forUrl(absolute, undefined, { hideChrome: true }),
				options: { pinned: true },
			},
			targetGroup.id,
		);
		if (!targetGroup.isLocked) {
			targetGroup.lock(true);
		}
	}

	private async refresh(): Promise<void> {
		const user = this.accountService.getUser();
		const token = await this.accountService.getToken();
		if (!token || !user) {
			return;
		}
		const seq = ++this.fetchSeq;
		this.retryTimer.cancel();
		this.loading = true;
		this.updateRefreshButton();
		if (!this.services) {
			this.renderSections(); // skeleton / disable the retry button
		}
		try {
			// Refresh user + services in parallel. `/me` carries roles + avatar,
			// so this also picks up any profile changes the website made since
			// pairing (otherwise the cached IOthcloudUser is permanently stale).
			const [services, me] = await Promise.all([
				OthcloudAccountClient.listServices(token),
				OthcloudAccountClient.me(token).catch(() => undefined),
			]);
			if (seq !== this.fetchSeq) {
				return; // a newer refresh started, or the user signed out; discard.
			}
			this.services = services;
			this.error = undefined;
			this.lastLoaded = Date.now();
			this.loadedForUserId = user.id;
			this.retryAttempt = 0;
			this.loading = false;
			void this.loadDevEnvStatuses();
			if (me) {
				this.accountService.updateUser(me);
			}
		} catch (err) {
			if (seq !== this.fetchSeq) {
				return;
			}
			this.loading = false;
			// 401: the stored token is no longer valid - sign out so the CTA
			// shows up again and the user re-pairs.
			if (err instanceof OthcloudAccountApiError && err.status === 401) {
				void this.accountService.signOut();
				return;
			}
			this.error = describeError(err);
			this.loadedForUserId = user.id;
			this.scheduleRetry();
		}
		this.updateRefreshButton();
		this.renderSections();
	}

	/** Retries a failed load with a growing delay, while the panel is visible. */
	private scheduleRetry(): void {
		if (!this.isBodyVisible()) {
			return; // becoming visible again triggers a reload
		}
		const delay = RETRY_DELAYS[Math.min(this.retryAttempt, RETRY_DELAYS.length - 1)];
		this.retryAttempt++;
		this.retryTimer.cancelAndSet(() => void this.refresh(), delay);
	}
}

/**
 * Registers the activity-bar entry (cloud icon) and the single view inside it.
 * The container shows up as soon as this module is imported - sign-in state is
 * read live in {@link OthcloudAccountSidebarView}.
 */
export function registerOthcloudAccountSidebar(): void {
	const viewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
		id: OTHCLOUD_ACCOUNT_VIEW_CONTAINER_ID,
		title: localize2('othcloud.account.activityBarTitle', 'OTHCloud'),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [OTHCLOUD_ACCOUNT_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		icon: Codicon.cloud,
		order: 6,
		storageId: OTHCLOUD_ACCOUNT_VIEW_CONTAINER_ID + '.state',
		hideIfEmpty: false,
		// OTerminal: the primary side bar is reserved for the Explorer (see navigationLayout.contribution.ts)
	}, ViewContainerLocation.AuxiliaryBar);

	const viewDescriptor: IViewDescriptor = {
		id: OTHCLOUD_ACCOUNT_VIEW_ID,
		name: OthcloudAccountSidebarView.TITLE,
		containerIcon: Codicon.cloud,
		ctorDescriptor: new SyncDescriptor(OthcloudAccountSidebarView),
		canToggleVisibility: false,
		canMoveView: true,
		order: 1,
	};

	Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([viewDescriptor], viewContainer);
}
