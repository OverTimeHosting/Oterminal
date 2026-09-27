/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { ITerminalProfileService } from '../common/terminal.js';
import { ICreateTerminalOptions, ITerminalService } from './terminal.js';

/**
 * Fills the "New Terminal" submenus of the context menus with the available
 * terminal profiles, mirroring the "+" dropdown in the panel:
 *
 * - `TerminalNewWithProfileContext` (terminal, tab and tab-area menus) opens
 *   the profile at the default location, like "New Terminal" there did.
 * - `TerminalNewEditorWithProfileContext` (empty editor area, editor tab bar)
 *   opens it as a terminal editor, like "New Terminal" there did.
 *
 * Menu items cannot carry arguments, so each profile gets its own command.
 * The commands and menu items are re-registered whenever the profiles change.
 */
export class TerminalProfileContextMenuContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.terminalProfileContextMenu';

	private static readonly _commandPrefix = 'workbench.action.terminal.newWithProfileFromContextMenu.';

	private readonly _entries = this._register(new DisposableStore());

	constructor(
		@ITerminalProfileService private readonly _terminalProfileService: ITerminalProfileService,
		@ITerminalService private readonly _terminalService: ITerminalService,
	) {
		super();
		this._register(this._terminalProfileService.onDidChangeAvailableProfiles(() => this._refresh()));
		this._refresh();
	}

	private _refresh(): void {
		this._entries.clear();

		const defaultProfileName = this._terminalProfileService.getDefaultProfileName();
		let order = 0;

		const addEntry = (title: string, config: ICreateTerminalOptions['config']) => {
			const sanitizedTitle = title.replace(/[\n\r\t]/g, '');
			const label = sanitizedTitle === defaultProfileName
				? localize('defaultTerminalProfile', "{0} (Default)", sanitizedTitle)
				: sanitizedTitle;
			const targets: [MenuId, ICreateTerminalOptions][] = [
				[MenuId.TerminalNewWithProfileContext, { config }],
				[MenuId.TerminalNewEditorWithProfileContext, { config, location: TerminalLocation.Editor }],
			];
			for (const [menuId, options] of targets) {
				const id = `${TerminalProfileContextMenuContribution._commandPrefix}${menuId.id}.${order}`;
				this._entries.add(CommandsRegistry.registerCommand(id, () => this._terminalService.createAndFocusTerminal(options)));
				this._entries.add(MenuRegistry.appendMenuItem(menuId, {
					command: { id, title: label },
					group: '1_profiles',
					order
				}));
			}
			order++;
		};

		for (const profile of this._terminalProfileService.availableProfiles) {
			if (profile.isAutoDetected) {
				continue;
			}
			addEntry(profile.profileName, profile);
		}

		for (const contributed of this._terminalProfileService.contributedProfiles) {
			addEntry(contributed.title, {
				extensionIdentifier: contributed.extensionIdentifier,
				id: contributed.id,
				title: contributed.title.replace(/[\n\r\t]/g, '')
			});
		}
	}
}
