/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/githubRepos.css';
import { localize, localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { URI } from '../../../../base/common/uri.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IViewContainersRegistry, IViewDescriptor, IViewsRegistry, Extensions as ViewExtensions, ViewContainer, ViewContainerLocation, IViewDescriptorService } from '../../../common/views.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { append, $, addDisposableListener, EventType, clearNode } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { IListVirtualDelegate, IListRenderer } from '../../../../base/browser/ui/list/list.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IOthcloudAccountService, OthcloudIsSignedInContext } from '../../othcloudAccount/common/othcloudAccountService.js';
import { IGithubOwner, ICreatedRepo, IRemoteRepo, GithubApiError, resolveGithubToken, resolveGithubOwner, createGithubRepo, listGithubRepos } from './githubRepoCreation.js';

export interface IRepoEntry {
	id: string;
	name: string;
	path: string;
	url?: string;
	source: 'manual' | 'scan' | 'github';
}

export const GITHUB_REPOS_STORAGE_KEY = 'githubRepos.entries';
const STORAGE_KEY = GITHUB_REPOS_STORAGE_KEY;

export function loadGithubRepoEntries(storage: IStorageService): IRepoEntry[] {
	return loadEntries(storage);
}
const VIEW_CONTAINER_ID = 'workbench.view.githubRepos';
const VIEW_ID = 'workbench.view.githubRepos.list';

const githubReposIcon = registerIcon('github-repos-icon', Codicon.githubInverted, localize('githubReposIcon', 'Activity bar icon for GitHub Repos.'));

function loadEntries(storage: IStorageService): IRepoEntry[] {
	const raw = storage.get(STORAGE_KEY, StorageScope.PROFILE, '[]');
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function saveEntries(storage: IStorageService, entries: IRepoEntry[]): void {
	storage.store(STORAGE_KEY, JSON.stringify(entries), StorageScope.PROFILE, StorageTarget.USER);
}

const SCAN_ROOTS_KEY = 'githubRepos.scanRoots';

function loadScanRoots(storage: IStorageService): string[] {
	const raw = storage.get(SCAN_ROOTS_KEY, StorageScope.PROFILE, '[]');
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
	} catch {
		return [];
	}
}

function saveScanRoots(storage: IStorageService, roots: string[]): void {
	storage.store(SCAN_ROOTS_KEY, JSON.stringify(roots), StorageScope.PROFILE, StorageTarget.USER);
}

/**
 * Re-derives all `source: 'scan'` entries from the remembered scan roots while
 * preserving created/cloned (`github`) entries. Picks up repos created since the
 * last scan and drops ones whose folder vanished. Existing scan-entry ids are
 * reused so we only persist (and re-render) when the set actually changed.
 * Returns true if the stored entries changed.
 */
/** How deep below each scan root we look for nested git repositories. */
const MAX_SCAN_DEPTH = 4;

/** Directories we never descend into while scanning - heavy or irrelevant. */
const SKIP_SCAN_DIRS = new Set(['node_modules', '.git', 'bower_components', 'vendor', '.hg', '.svn', 'out', 'dist']);

/**
 * Walks `dir` looking for git repositories, descending up to `maxDepth` levels.
 * When a directory is itself a repo it's collected and we stop descending into
 * it (its working tree may hold nested .git dirs / submodules we don't want to
 * list separately).
 */
async function collectGitRepos(fileService: IFileService, dir: URI, depth: number, maxDepth: number, found: URI[]): Promise<void> {
	if (await isGitRepo(fileService, dir)) {
		found.push(dir);
		return;
	}
	if (depth >= maxDepth) {
		return;
	}
	let children;
	try {
		const stat = await fileService.resolve(dir, { resolveSingleChildDescendants: false });
		children = stat.children ?? [];
	} catch {
		return; // unreadable - skip
	}
	for (const child of children) {
		if (!child.isDirectory || SKIP_SCAN_DIRS.has(basename(child.resource.fsPath))) {
			continue;
		}
		await collectGitRepos(fileService, child.resource, depth + 1, maxDepth, found);
	}
}

async function rescanRoots(storage: IStorageService, fileService: IFileService): Promise<boolean> {
	const roots = loadScanRoots(storage);
	const all = loadEntries(storage);
	const preserved = all.filter(e => e.source !== 'scan');
	const prevScanIds = new Map(all.filter(e => e.source === 'scan').map(e => [e.path, e.id] as const));
	const seen = new Set(preserved.map(e => e.path));

	const scanned: IRepoEntry[] = [];
	for (const root of roots) {
		let children;
		try {
			const stat = await fileService.resolve(URI.file(root), { resolveSingleChildDescendants: false });
			children = stat.children ?? [];
		} catch {
			continue; // root removed or unreadable - skip it
		}
		// Walk each top-level child recursively so repositories nested inside
		// folders (e.g. <root>/work/projectA) are found, not just direct children.
		const found: URI[] = [];
		for (const child of children) {
			if (!child.isDirectory || SKIP_SCAN_DIRS.has(basename(child.resource.fsPath))) {
				continue;
			}
			await collectGitRepos(fileService, child.resource, 1, MAX_SCAN_DEPTH, found);
		}
		for (const repo of found) {
			const fsPath = repo.fsPath;
			if (seen.has(fsPath)) {
				continue;
			}
			seen.add(fsPath);
			scanned.push({ id: prevScanIds.get(fsPath) ?? uuid(), name: basename(fsPath), path: fsPath, source: 'scan' });
		}
	}

	const next = [...preserved, ...scanned];
	const fingerprint = (list: IRepoEntry[]) => list.map(e => `${e.source}|${e.path}|${e.url ?? ''}`).join('\n');
	if (fingerprint(all) !== fingerprint(next)) {
		saveEntries(storage, next);
		return true;
	}
	return false;
}

const HasReposContext = new RawContextKey<boolean>('githubRepos.hasEntries', false);

const REPO_ROW_HEIGHT = 22;

interface IRepoRowTemplate {
	readonly root: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly remove: HTMLElement;
	readonly disposables: DisposableStore;
	element?: IRepoEntry;
}

class RepoListDelegate implements IListVirtualDelegate<IRepoEntry> {
	getHeight(): number { return REPO_ROW_HEIGHT; }
	getTemplateId(): string { return 'repo'; }
}

class RepoListRenderer implements IListRenderer<IRepoEntry, IRepoRowTemplate> {
	readonly templateId = 'repo';

	constructor(private readonly onRemove: (entry: IRepoEntry) => void) { }

	renderTemplate(container: HTMLElement): IRepoRowTemplate {
		const root = append(container, $('.github-repos-row'));
		const icon = append(root, $('span.github-repos-icon'));
		const label = append(root, $('span.github-repos-name'));
		const remove = append(root, $('span.github-repos-remove'));
		remove.className = 'github-repos-remove ' + ThemeIcon.asClassName(Codicon.close);
		remove.title = localize('githubRepos.removeAction', "Remove from list");

		const disposables = new DisposableStore();
		const template: IRepoRowTemplate = { root, icon, label, remove, disposables };
		disposables.add(addDisposableListener(remove, EventType.CLICK, e => {
			e.stopPropagation();
			if (template.element) {
				this.onRemove(template.element);
			}
		}));
		return template;
	}

	renderElement(element: IRepoEntry, _index: number, template: IRepoRowTemplate): void {
		template.element = element;
		template.icon.className = 'github-repos-icon ' + ThemeIcon.asClassName(
			element.source === 'scan' ? Codicon.searchFuzzy
				: element.source === 'github' ? Codicon.github
					: Codicon.repo);
		template.label.textContent = element.name;
		template.root.title = `${element.path}${element.url ? `\n${element.url}` : ''}`;
	}

	disposeTemplate(template: IRepoRowTemplate): void {
		template.disposables.dispose();
	}
}

class GithubReposViewPane extends ViewPane {

	static readonly ID = VIEW_ID;
	static readonly TITLE = localize2('githubRepos.viewTitle', "GitHub Repositories");

	private accountEl!: HTMLElement;
	private listContainer!: HTMLElement;
	private list!: WorkbenchList<IRepoEntry>;
	private readonly hasReposKey: IContextKey<boolean>;
	private bodyHeight = 0;
	private bodyWidth = 0;

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
		@IStorageService private readonly storageService: IStorageService,
		@IHostService private readonly hostService: IHostService,
		@IFileService private readonly fileService: IFileService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this.hasReposKey = HasReposContext.bindTo(contextKeyService);
		this.refreshContext();

		this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, STORAGE_KEY, this._store)(() => {
			this.refreshContext();
			this.updateList();
			this._onDidChangeViewWelcomeState.fire();
		}));

		// Re-scan the remembered roots (and refresh the linked-account header)
		// every time the view becomes visible, so newly created/cloned repos
		// show up without a manual action.
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				void this.onBecameVisible();
			}
		}));
	}

	private refreshContext(): void {
		this.hasReposKey.set(loadEntries(this.storageService).length > 0);
	}

	override shouldShowWelcome(): boolean {
		return loadEntries(this.storageService).length === 0;
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('github-repos-view');

		this.accountEl = append(container, $('.github-repos-account'));
		this.accountEl.style.display = 'none';

		this.listContainer = append(container, $('.github-repos-list'));
		this.list = this._register(this.instantiationService.createInstance(
			WorkbenchList,
			'GithubRepos',
			this.listContainer,
			new RepoListDelegate(),
			[new RepoListRenderer(entry => this.removeEntry(entry.id))],
			{
				horizontalScrolling: false,
				multipleSelectionSupport: false,
				identityProvider: { getId: (e: IRepoEntry) => e.id },
				accessibilityProvider: {
					getWidgetAriaLabel: () => localize('githubRepos.listAria', "Repositories"),
					getAriaLabel: (e: IRepoEntry) => e.name,
				},
			},
		)) as WorkbenchList<IRepoEntry>;

		this._register(this.list.onDidOpen(e => {
			if (e.element) {
				this.launch(e.element);
			}
		}));

		this.updateList();
		void this.onBecameVisible();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.bodyHeight = height;
		this.bodyWidth = width;
		this.layoutList();
	}

	private layoutList(): void {
		if (!this.list) {
			return;
		}
		const accountH = this.accountEl && this.accountEl.style.display !== 'none' ? this.accountEl.offsetHeight : 0;
		const listHeight = Math.max(0, this.bodyHeight - accountH);
		this.listContainer.style.height = `${listHeight}px`;
		this.list.layout(listHeight, this.bodyWidth);
	}

	private updateList(): void {
		if (!this.list) {
			return;
		}
		this.list.splice(0, this.list.length, loadEntries(this.storageService));
	}

	private async onBecameVisible(): Promise<void> {
		// Saving inside rescanRoots triggers our storage listener → updateList.
		await rescanRoots(this.storageService, this.fileService);
		await this.refreshAccount();
	}

	private async refreshAccount(): Promise<void> {
		let owner: IGithubOwner | undefined;
		const token = await resolveGithubToken(this.authenticationService);
		if (token) {
			owner = await resolveGithubOwner(token);
		}
		this.setAccount(owner);
	}

	private setAccount(owner: IGithubOwner | undefined): void {
		if (!this.accountEl) {
			return;
		}
		clearNode(this.accountEl);
		if (owner) {
			const icon = append(this.accountEl, $('span'));
			icon.className = ThemeIcon.asClassName(owner.type === 'Organization' ? Codicon.organization : Codicon.account);
			const text = append(this.accountEl, $('span.github-repos-account-name'));
			text.textContent = localize('githubRepos.accountLabel', "Creates under {0}", owner.login);
			this.accountEl.title = `${owner.login} (${owner.type})`;
			this.accountEl.style.display = '';
		} else {
			this.accountEl.style.display = 'none';
		}
		this.layoutList();
	}

	private launch(entry: IRepoEntry): void {
		this.hostService.openWindow([{ folderUri: URI.file(entry.path) }], { forceNewWindow: false });
	}

	private removeEntry(id: string): void {
		const entries = loadEntries(this.storageService).filter(e => e.id !== id);
		saveEntries(this.storageService, entries);
		// Storage listener handles refreshContext + updateList + welcome state.
	}
}

// View container

const viewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: VIEW_CONTAINER_ID,
	title: localize2('githubRepos.containerTitle', "GitHub Repositories"),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	icon: githubReposIcon,
	order: 6,
	storageId: 'workbench.githubRepos.state',
	hideIfEmpty: false,
	// OTerminal: the primary side bar is reserved for the Explorer (see navigationLayout.contribution.ts)
}, ViewContainerLocation.AuxiliaryBar);

const viewDescriptor: IViewDescriptor = {
	id: VIEW_ID,
	name: GithubReposViewPane.TITLE,
	containerIcon: githubReposIcon,
	ctorDescriptor: new SyncDescriptor(GithubReposViewPane),
	canToggleVisibility: false,
	canMoveView: true,
	order: 1,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([viewDescriptor], viewContainer);

// Open GitHub Repositories in the secondary side bar the first time a profile is used, so a fresh
// install shows it next to the Explorer. Whether the user keeps it open is then respected on
// subsequent launches.
class GithubReposDefaultViewContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.githubReposDefaultView';
	private static readonly SHOWN_KEY = 'githubRepos.defaultViewShown';

	constructor(
		@IPaneCompositePartService paneCompositePartService: IPaneCompositePartService,
		@IStorageService storageService: IStorageService,
	) {
		if (storageService.getBoolean(GithubReposDefaultViewContribution.SHOWN_KEY, StorageScope.PROFILE, false)) {
			return;
		}
		storageService.store(GithubReposDefaultViewContribution.SHOWN_KEY, true, StorageScope.PROFILE, StorageTarget.MACHINE);
		void paneCompositePartService.openPaneComposite(VIEW_CONTAINER_ID, ViewContainerLocation.AuxiliaryBar, false);
	}
}
registerWorkbenchContribution2(GithubReposDefaultViewContribution.ID, GithubReposDefaultViewContribution, WorkbenchPhase.AfterRestored);

// Helpers

function uuid(): string {
	return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Takes {@link IFileDialogService} rather than a {@link ServicesAccessor}: callers
 * reach this after awaiting, and an accessor is only valid during the synchronous
 * part of the method it was passed to ("illegal state: service accessor is only
 * valid during the invocation of its target method").
 */
async function pickFolder(dialog: IFileDialogService, message: string): Promise<URI | undefined> {
	const picked = await dialog.showOpenDialog({
		canSelectFolders: true,
		canSelectFiles: false,
		canSelectMany: false,
		title: message,
	});
	return picked?.[0];
}

async function isGitRepo(fileService: IFileService, folder: URI): Promise<boolean> {
	try {
		const gitDir = URI.joinPath(folder, '.git');
		const stat = await fileService.stat(gitDir);
		return !!stat;
	} catch {
		return false;
	}
}

// Actions

registerAction2(class CreateGithubRepoAction extends Action2 {
	constructor() {
		super({
			id: 'githubRepos.createOnGithub',
			title: localize2('githubRepos.createOnGithub', "Create Repository on GitHub..."),
			icon: Codicon.repoCreate,
			category: localize2('githubRepos.category', "GitHub Repositories"),
			f1: true,
			menu: [{
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.and(ContextKeyExpr.equals('view', VIEW_ID), OthcloudIsSignedInContext),
				group: 'navigation',
				order: 0,
			}],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const storage = accessor.get(IStorageService);
		const quickInput = accessor.get(IQuickInputService);
		const accountService = accessor.get(IOthcloudAccountService);
		const authService = accessor.get(IAuthenticationService);
		const notificationService = accessor.get(INotificationService);
		const progressService = accessor.get(IProgressService);
		const commandService = accessor.get(ICommandService);
		// Resolve eagerly: the accessor is dead after the first await below.
		const fileDialogService = accessor.get(IFileDialogService);

		if (!accountService.isSignedIn()) {
			notificationService.prompt(
				Severity.Info,
				localize('githubRepos.signInFirst', "Sign in to OTHCloud first to create GitHub repositories."),
				[{ label: localize('githubRepos.signInAction', "Sign in to OTHCloud"), run: () => void commandService.executeCommand('othcloud.account.signIn') }],
			);
			return;
		}

		// Pull the GitHub installation token from the `github` auth session.
		const token = await resolveGithubToken(authService);
		if (!token) {
			notificationService.prompt(
				Severity.Warning,
				localize('githubRepos.notLinked', "GitHub isn't linked to your OTHCloud account yet. Connect it to create repositories."),
				[{ label: localize('githubRepos.linkAction', "Link GitHub on OTHCloud"), run: () => void commandService.executeCommand('othcloud.github.link') }],
			);
			return;
		}

		// Resolve which account/org the token belongs to so we can both show it
		// and route the create call correctly.
		const owner = await resolveGithubOwner(token);
		if (!owner) {
			notificationService.error(localize('githubRepos.noOwner', "Couldn't determine your linked GitHub account. Open a repo on othcloud.xyz's GitHub settings, then try again."));
			return;
		}

		const name = await quickInput.input({
			prompt: localize('githubRepos.newRepoName', "New repository name (created under {0})", owner.login),
			placeHolder: 'my-awesome-project',
			validateInput: async value => {
				if (!value || !/^[A-Za-z0-9._-]+$/.test(value)) {
					return localize('githubRepos.invalidName', "Use only letters, numbers, '.', '_' or '-'.");
				}
				return undefined;
			},
		});
		if (!name) {
			return;
		}

		const description = await quickInput.input({
			prompt: localize('githubRepos.newRepoDescription', "Description (optional)"),
		});
		if (description === undefined) {
			return; // user pressed Escape
		}

		const visibility = await quickInput.pick(
			[
				{ label: localize('githubRepos.private', "Private"), description: localize('githubRepos.privateDetail', "Only you and people you grant access can see it"), id: 'private' },
				{ label: localize('githubRepos.public', "Public"), description: localize('githubRepos.publicDetail', "Anyone on the internet can see it"), id: 'public' },
			],
			{ placeHolder: localize('githubRepos.pickVisibility', "Create {0}/{1} as…", owner.login, name) },
		);
		if (!visibility) {
			return;
		}

		// Create the repo directly on GitHub using the installation token.
		let repo: ICreatedRepo;
		try {
			repo = await progressService.withProgress(
				{ location: ProgressLocation.Notification, title: localize('githubRepos.creating', "Creating {0}/{1} on GitHub…", owner.login, name) },
				() => createGithubRepo(token, owner, {
					name,
					description: description || undefined,
					private: visibility.id === 'private',
					autoInit: true,
				}),
			);
		} catch (err) {
			const status = err instanceof GithubApiError ? err.status : 0;
			if (status === 403) {
				notificationService.error(localize('githubRepos.forbidden', "GitHub rejected the request for {0}: the linked app may not have permission to create repositories there.", owner.login));
			} else {
				notificationService.error(localize('githubRepos.createFailed', "Couldn't create the repository: {0}", String((err as Error).message ?? err)));
			}
			return;
		}

		// Let the user pick where to clone it locally.
		const parent = await pickFolder(fileDialogService, localize('githubRepos.pickCloneParent', "Choose a folder to clone \"{0}\" into", repo.name));
		if (!parent) {
			// Repo was created on GitHub; just record it and tell the user.
			notificationService.info(localize('githubRepos.createdNoClone', "Created {0} on GitHub. Clone it later from {1}.", repo.fullName, repo.htmlUrl));
			return;
		}

		const destPath = URI.joinPath(parent, repo.name).fsPath;

		// Record it in the list now, using the path it will live at after clone.
		const entries = loadEntries(storage);
		if (!entries.some(e => e.path === destPath)) {
			entries.push({ id: uuid(), name: repo.name, path: destPath, url: repo.htmlUrl, source: 'github' });
			saveEntries(storage, entries);
		}

		// Clone via the git extension. Credentials flow through the `github`
		// auth provider (OthcloudGithubAuthProvider), and it prompts to open
		// the freshly cloned folder once done.
		try {
			await commandService.executeCommand('git.clone', repo.cloneUrl, parent.fsPath);
		} catch (err) {
			notificationService.error(localize('githubRepos.cloneFailed', "Repository created, but cloning failed: {0}", String((err as Error).message ?? err)));
		}
	}
});

registerAction2(class CloneGithubRepoAction extends Action2 {
	constructor() {
		super({
			id: 'githubRepos.cloneFromGithub',
			title: localize2('githubRepos.cloneFromGithub', "Clone Repository from GitHub..."),
			icon: Codicon.repoClone,
			category: localize2('githubRepos.category', "GitHub Repositories"),
			f1: true,
			menu: [{
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', VIEW_ID),
				group: 'navigation',
				order: 0,
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const authService = accessor.get(IAuthenticationService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);
		const commandService = accessor.get(ICommandService);
		const progressService = accessor.get(IProgressService);
		const storage = accessor.get(IStorageService);
		// Resolve eagerly: the accessor is dead after the first await below.
		const fileDialogService = accessor.get(IFileDialogService);

		const token = await resolveGithubToken(authService);
		if (!token) {
			notificationService.prompt(
				Severity.Info,
				localize('githubRepos.cloneSignInFirst', "Sign in to OTHCloud to browse your GitHub repositories."),
				[{ label: localize('githubRepos.signInAction', "Sign in to OTHCloud"), run: () => void commandService.executeCommand('othcloud.account.signIn') }],
			);
			return;
		}

		let repos: IRemoteRepo[] = [];
		try {
			repos = await progressService.withProgress(
				{ location: ProgressLocation.Window, title: localize('githubRepos.loadingRepos', "Loading GitHub repositories…") },
				() => listGithubRepos(token),
			);
		} catch (err) {
			const status = err instanceof GithubApiError ? err.status : undefined;
			notificationService.error(status
				? localize('githubRepos.listFailedStatus', "Couldn't list your GitHub repositories (HTTP {0}).", status)
				: localize('githubRepos.listFailed', "Couldn't list your GitHub repositories: {0}", String((err as Error).message ?? err)));
			return;
		}

		if (!repos.length) {
			notificationService.info(localize('githubRepos.noRemoteRepos', "No repositories are visible to your OTHCloud GitHub connection. Grant the OTHCloud GitHub App access to them on othcloud.xyz, then refresh."));
			return;
		}

		const picked = await quickInputService.pick(
			repos.map(repo => ({
				label: repo.name,
				description: repo.owner && repo.owner !== repo.name ? repo.fullName : undefined,
				detail: repo.description,
				iconClass: ThemeIcon.asClassName(repo.private ? Codicon.lock : Codicon.repo),
				repo,
			})),
			{
				placeHolder: localize('githubRepos.pickRepo', "Select a repository to clone"),
				matchOnDescription: true,
				matchOnDetail: true,
			},
		);
		if (!picked) {
			return;
		}

		const repo = picked.repo;
		const parent = await pickFolder(fileDialogService, localize('githubRepos.pickCloneParent', "Choose a folder to clone \"{0}\" into", repo.name));
		if (!parent) {
			return;
		}

		// Record it now against the path it will occupy, matching what the
		// create-then-clone flow does, so the list reflects it either way.
		const destPath = URI.joinPath(parent, repo.name).fsPath;
		const entries = loadEntries(storage);
		if (!entries.some(e => e.path === destPath)) {
			entries.push({ id: uuid(), name: repo.name, path: destPath, url: repo.htmlUrl, source: 'github' });
			saveEntries(storage, entries);
		}

		// Clone via the git extension; it handles credentials through the auth
		// providers and offers to open the folder when it finishes.
		try {
			await commandService.executeCommand('git.clone', repo.cloneUrl, parent.fsPath);
		} catch (err) {
			notificationService.error(localize('githubRepos.cloneFailedPlain', "Cloning failed: {0}", String((err as Error).message ?? err)));
		}
	}
});

registerAction2(class ScanFolderAction extends Action2 {
	constructor() {
		super({
			id: 'githubRepos.scanFolder',
			title: localize2('githubRepos.scanFolder', "Scan Folder for Repositories..."),
			icon: Codicon.searchFuzzy,
			category: localize2('githubRepos.category', "GitHub Repositories"),
			f1: true,
			menu: [{
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', VIEW_ID),
				group: 'navigation',
				order: 1,
			}],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const storage = accessor.get(IStorageService);
		const fileService = accessor.get(IFileService);
		const fileDialogService = accessor.get(IFileDialogService);
		const root = await pickFolder(fileDialogService, localize('githubRepos.pickScanFolder', "Select a folder to scan for git repositories"));
		if (!root) {
			return;
		}
		// Remember this root so the view auto-re-scans it on every open, then
		// scan it right away.
		const roots = loadScanRoots(storage);
		if (!roots.includes(root.fsPath)) {
			roots.push(root.fsPath);
			saveScanRoots(storage, roots);
		}
		await rescanRoots(storage, fileService);
	}
});

registerAction2(class RefreshReposAction extends Action2 {
	constructor() {
		super({
			id: 'githubRepos.refresh',
			title: localize2('githubRepos.refresh', "Refresh Repositories"),
			icon: Codicon.refresh,
			category: localize2('githubRepos.category', "GitHub Repositories"),
			f1: true,
			menu: [{
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', VIEW_ID),
				group: 'navigation',
				order: 2,
			}],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await rescanRoots(accessor.get(IStorageService), accessor.get(IFileService));
	}
});

registerAction2(class ClearReposAction extends Action2 {
	constructor() {
		super({
			id: 'githubRepos.clearAll',
			title: localize2('githubRepos.clearAll', "Clear All Repositories"),
			icon: Codicon.clearAll,
			category: localize2('githubRepos.category', "GitHub Repositories"),
			f1: true,
			menu: [{
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.and(ContextKeyExpr.equals('view', VIEW_ID), HasReposContext),
				group: 'navigation',
				order: 3,
			}],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const storage = accessor.get(IStorageService);
		// Drop both the entries and the remembered scan roots, otherwise the
		// next open would silently re-add the scanned repos.
		saveScanRoots(storage, []);
		saveEntries(storage, []);
	}
});

// Welcome content for empty state
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViewWelcomeContent(VIEW_ID, {
	content: localize('githubRepos.welcomeSignedIn', "No repositories yet.\n[Clone from GitHub](command:githubRepos.cloneFromGithub)\n[Create a Repository on GitHub](command:githubRepos.createOnGithub)\n[Scan a Folder](command:githubRepos.scanFolder)"),
	when: ContextKeyExpr.and(HasReposContext.toNegated(), OthcloudIsSignedInContext),
});
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViewWelcomeContent(VIEW_ID, {
	content: localize('githubRepos.welcome', "No repositories yet.\n[Clone from GitHub](command:githubRepos.cloneFromGithub)\n[Scan a Folder](command:githubRepos.scanFolder)\nSign in to OTHCloud to create repositories on GitHub."),
	when: ContextKeyExpr.and(HasReposContext.toNegated(), OthcloudIsSignedInContext.toNegated()),
});

function basename(p: string): string {
	const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
	return idx >= 0 ? p.slice(idx + 1) : p;
}
