/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IMenuItem, MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { getOthcloudRoleLabel, IOthcloudAccountService } from '../common/othcloudAccountService.js';
import { SWITCH_GITHUB_ACCOUNT_COMMAND_ID } from './othcloudGithubAuthProvider.js';

const SIGN_IN_COMMAND = 'othcloud.account.signIn';
const SIGN_OUT_COMMAND = 'othcloud.account.signOut';
const OPEN_CONSOLE_COMMAND = 'othcloud.console.open';

/**
 * Owns the entries shown in the workbench's Accounts dropdown (the person
 * icon - top-right when the activity bar is positioned at the top, bottom-
 * left otherwise) for the Othcloud account.
 *
 * The dropdown shows either "Sign in to Othcloud" when signed out, or the
 * user's email + a "Sign out" entry when signed in. Re-creates the entries
 * on every auth change so the email is always current.
 *
 * Sibling of {@link DevelopersAccountMenuContribution}, which owns the
 * older localhost-Developer entries in the same menu.
 */
export class OthcloudAccountMenuContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.othcloudAccountMenu';

	private readonly menuDisposables = this._register(new DisposableStore());

	constructor(
		@IOthcloudAccountService private readonly accountService: IOthcloudAccountService,
	) {
		super();
		this.refresh();
		this._register(this.accountService.onDidChangeAuth(() => this.refresh()));
	}

	private refresh(): void {
		this.menuDisposables.clear();
		const user = this.accountService.getUser();
		const items: IMenuItem[] = [];
		if (user) {
			// Prefer the display name and append the role when we have one, so the
			// dropdown says who you are *and* what you can do, not just an address.
			const roleLabel = getOthcloudRoleLabel(user);
			const who = user.name || user.email;
			items.push({
				group: '4_othcloud',
				order: 1,
				command: {
					id: OPEN_CONSOLE_COMMAND,
					title: roleLabel
						? localize('othcloud.account.menuSignedInAsWithRole', 'OTHCloud: {0} ({1})', who, roleLabel)
						: localize('othcloud.account.menuSignedInAs', 'OTHCloud: {0}', who),
				},
			});
			items.push({
				group: '4_othcloud',
				order: 2,
				command: {
					id: SWITCH_GITHUB_ACCOUNT_COMMAND_ID,
					title: localize('othcloud.account.menuSwitchGithub', 'Switch GitHub Account...'),
				},
			});
			items.push({
				group: '4_othcloud',
				order: 3,
				command: {
					id: SIGN_OUT_COMMAND,
					title: localize('othcloud.account.menuSignOut', 'Sign out of OTHCloud'),
				},
			});
		} else {
			items.push({
				group: '4_othcloud',
				order: 1,
				command: {
					id: SIGN_IN_COMMAND,
					title: localize('othcloud.account.menuSignIn', 'Sign in to OTHCloud'),
				},
			});
		}
		for (const item of items) {
			this.menuDisposables.add(MenuRegistry.appendMenuItem(MenuId.AccountsContext, item));
		}
	}
}
