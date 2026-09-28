/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { VIEWLET_ID as EXPLORER_VIEW_CONTAINER_ID } from '../../files/common/files.js';
import { TERMINAL_VIEW_ID } from '../../terminal/common/terminal.js';

/**
 * Lets the terminal live in the primary side bar instead of the bottom panel, the same way the
 * panel itself can be moved around. The view is movable already (drag and drop); these actions
 * make it a one-click choice from the terminal's title menu and the command palette.
 *
 * The primary side bar only ever shows the Explorer (see navigationLayout.contribution.ts), so
 * "side bar" means a pane underneath the file tree inside the Explorer.
 */
async function moveTerminal(accessor: ServicesAccessor, location: ViewContainerLocation.Sidebar | ViewContainerLocation.Panel): Promise<void> {
	const viewDescriptorService = accessor.get(IViewDescriptorService);
	const viewsService = accessor.get(IViewsService);
	const view = viewDescriptorService.getViewDescriptorById(TERMINAL_VIEW_ID);
	if (!view) {
		return;
	}
	if (viewDescriptorService.getViewLocationById(TERMINAL_VIEW_ID) !== location) {
		// Prefer the Explorer in the side bar and the terminal's own container in the panel over a
		// generated container of its own.
		const target = location === ViewContainerLocation.Sidebar
			? viewDescriptorService.getViewContainerById(EXPLORER_VIEW_CONTAINER_ID)
			: viewDescriptorService.getDefaultContainerById(TERMINAL_VIEW_ID);
		if (target && viewDescriptorService.getViewContainerLocation(target) === location) {
			viewDescriptorService.moveViewsToContainer([view], target, undefined, 'othcloud.terminal.move');
		} else {
			viewDescriptorService.moveViewToLocation(view, location, 'othcloud.terminal.move');
		}
	}
	await viewsService.openView(TERMINAL_VIEW_ID, true);
}

const TERMINAL_VIEW_TITLE_MENU = {
	id: MenuId.ViewTitle,
	when: ContextKeyExpr.equals('view', TERMINAL_VIEW_ID),
	group: '9_othcloud_location',
};

registerAction2(class MoveTerminalToSideBarAction extends Action2 {
	constructor() {
		super({
			id: 'othcloud.terminal.moveToSideBar',
			title: localize2('othcloud.terminal.moveToSideBar', 'Move Terminal to Primary Side Bar'),
			category: localize2('othcloud.terminal.category', 'Terminal'),
			icon: Codicon.layoutSidebarLeft,
			f1: true,
			menu: [{ ...TERMINAL_VIEW_TITLE_MENU, order: 1 }],
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return moveTerminal(accessor, ViewContainerLocation.Sidebar);
	}
});

registerAction2(class MoveTerminalToPanelAction extends Action2 {
	constructor() {
		super({
			id: 'othcloud.terminal.moveToPanel',
			title: localize2('othcloud.terminal.moveToPanel', 'Move Terminal to Panel'),
			category: localize2('othcloud.terminal.category', 'Terminal'),
			icon: Codicon.layoutPanel,
			f1: true,
			menu: [{ ...TERMINAL_VIEW_TITLE_MENU, order: 2 }],
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return moveTerminal(accessor, ViewContainerLocation.Panel);
	}
});
