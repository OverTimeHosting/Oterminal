/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { VIEWLET_ID as EXPLORER_VIEW_CONTAINER_ID } from '../../files/common/files.js';
import { VIEWLET_ID as SCM_VIEW_CONTAINER_ID } from '../../scm/common/scm.js';

const GITHUB_REPOS_VIEW_CONTAINER_ID = 'workbench.view.githubRepos';
const OTHCLOUD_ACCOUNT_VIEW_CONTAINER_ID = 'workbench.view.othcloudAccount';

/** Prefix of the containers the view descriptor service creates when a view is dropped on a part. */
const GENERATED_VIEW_CONTAINER_PREFIX = 'workbench.views.service.';

const REASON = 'othcloud navigation layout';

/**
 * OTerminal layout: the primary side bar (left) only ever holds the Explorer. It can be hidden
 * or resized like any side bar, but never switches to another view.
 *
 * Every other view container that would land in the primary side bar (Source Control, GitHub
 * Repos, OTHCloud, Search, Extensions, extension contributions, ...) is moved to the secondary
 * side bar (right). Views dropped on the primary side bar on their own (e.g. the terminal) are
 * merged into the Explorer instead, so they show up underneath the file tree.
 *
 * This is enforced continuously rather than once, so containers registered later by extensions,
 * a "Reset View Locations" or a drag and drop all end up back in this layout.
 */
class NavigationLayoutContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.othcloudNavigationLayout';

	private readonly scheduler = this._register(new RunOnceScheduler(() => this.enforce(), 0));

	constructor(
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
	) {
		super();

		this.enforce();

		// Deferred so that moves never happen in the middle of another listener's event delivery
		this._register(viewDescriptorService.onDidChangeViewContainers(() => this.scheduler.schedule()));
		this._register(viewDescriptorService.onDidChangeContainerLocation(() => this.scheduler.schedule()));
	}

	private enforce(): void {
		const explorer = this.viewDescriptorService.getViewContainerById(EXPLORER_VIEW_CONTAINER_ID);
		if (!explorer) {
			return;
		}

		if (this.viewDescriptorService.getViewContainerLocation(explorer) !== ViewContainerLocation.Sidebar) {
			this.viewDescriptorService.moveViewContainerToLocation(explorer, ViewContainerLocation.Sidebar, undefined, REASON);
		}

		for (const container of this.viewDescriptorService.getViewContainersByLocation(ViewContainerLocation.Sidebar)) {
			if (container.id === EXPLORER_VIEW_CONTAINER_ID) {
				continue;
			}

			if (container.id.startsWith(GENERATED_VIEW_CONTAINER_PREFIX)) {
				const views = this.viewDescriptorService.getViewContainerModel(container).allViewDescriptors;
				this.viewDescriptorService.moveViewsToContainer([...views], explorer, undefined, REASON);
			} else {
				this.viewDescriptorService.moveViewContainerToLocation(container, ViewContainerLocation.AuxiliaryBar, undefined, REASON);
			}
		}
	}
}

registerWorkbenchContribution2(NavigationLayoutContribution.ID, NavigationLayoutContribution, WorkbenchPhase.BlockStartup);

/**
 * Opens a view container in the secondary side bar, moving it there first if the user had put it
 * somewhere else (e.g. the bottom panel).
 */
async function openInSecondarySideBar(accessor: ServicesAccessor, viewContainerId: string): Promise<void> {
	const viewDescriptorService = accessor.get(IViewDescriptorService);
	const paneCompositeService = accessor.get(IPaneCompositePartService);

	const container = viewDescriptorService.getViewContainerById(viewContainerId);
	if (!container) {
		return;
	}
	if (viewDescriptorService.getViewContainerLocation(container) !== ViewContainerLocation.AuxiliaryBar) {
		viewDescriptorService.moveViewContainerToLocation(container, ViewContainerLocation.AuxiliaryBar, undefined, REASON);
	}
	await paneCompositeService.openPaneComposite(viewContainerId, ViewContainerLocation.AuxiliaryBar, true);
}

const NAVIGATION_CATEGORY = localize2('othcloud.navigation.category', "View");

// The hamburger menu in the title bar lists these above File, Edit, ... (see CustomMenubarControl)

registerAction2(class ShowExplorerAction extends Action2 {
	constructor() {
		super({
			id: 'othcloud.navigation.showExplorer',
			title: {
				...localize2('othcloud.navigation.showExplorer', "Show Explorer"),
				mnemonicTitle: localize({ key: 'othcloud.navigation.miExplorer', comment: ['&& denotes a mnemonic'] }, "&&Explorer"),
			},
			category: NAVIGATION_CATEGORY,
			f1: true,
			// First in the hamburger menu: the way back to the Explorer after hiding the side bar
			menu: { id: MenuId.MenubarCompactNavigation, group: '0_explorer', order: 0 },
		});
	}

	run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(IPaneCompositePartService).openPaneComposite(EXPLORER_VIEW_CONTAINER_ID, ViewContainerLocation.Sidebar, true);
	}
});

registerAction2(class OpenSourceControlAction extends Action2 {
	constructor() {
		super({
			id: 'othcloud.navigation.openSourceControl',
			title: {
				...localize2('othcloud.navigation.openSourceControl', "Open Source Control"),
				mnemonicTitle: localize({ key: 'othcloud.navigation.miSourceControl', comment: ['&& denotes a mnemonic'] }, "S&&ource Control"),
			},
			category: NAVIGATION_CATEGORY,
			f1: true,
			menu: { id: MenuId.MenubarCompactNavigation, group: '1_views', order: 1 },
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return openInSecondarySideBar(accessor, SCM_VIEW_CONTAINER_ID);
	}
});

registerAction2(class OpenGithubReposAction extends Action2 {
	constructor() {
		super({
			id: 'othcloud.navigation.openGithubRepos',
			title: {
				...localize2('othcloud.navigation.openGithubRepos', "Open GitHub Repos"),
				mnemonicTitle: localize({ key: 'othcloud.navigation.miGithubRepos', comment: ['&& denotes a mnemonic'] }, "&&GitHub Repos"),
			},
			category: NAVIGATION_CATEGORY,
			f1: true,
			menu: { id: MenuId.MenubarCompactNavigation, group: '1_views', order: 2 },
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return openInSecondarySideBar(accessor, GITHUB_REPOS_VIEW_CONTAINER_ID);
	}
});

registerAction2(class OpenOthcloudAction extends Action2 {
	constructor() {
		super({
			id: 'othcloud.navigation.openOthcloud',
			title: {
				...localize2('othcloud.navigation.openOthcloud', "Open OTHCloud"),
				mnemonicTitle: localize({ key: 'othcloud.navigation.miOthcloud', comment: ['&& denotes a mnemonic'] }, "&&OTHCloud"),
			},
			category: NAVIGATION_CATEGORY,
			f1: true,
			menu: { id: MenuId.MenubarCompactNavigation, group: '1_views', order: 3 },
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return openInSecondarySideBar(accessor, OTHCLOUD_ACCOUNT_VIEW_CONTAINER_ID);
	}
});
