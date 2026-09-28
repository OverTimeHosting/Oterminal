/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationDefaults, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IPathService } from '../../../services/path/common/pathService.js';

/**
 * The folder GitHub repositories are cloned into: `~/Documents/GitHub` unless configured.
 * Created when missing, used by the GitHub Repositories view without asking, and set as the
 * git extension's default clone destination so Git: Clone starts there too.
 */
export const CLONE_DIRECTORY_SETTING = 'githubRepos.cloneDirectory';
const DEFAULT_CLONE_DIRECTORY = '~/Documents/GitHub';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'githubRepos',
	title: localize('githubRepos.configTitle', "GitHub Repositories"),
	type: 'object',
	properties: {
		[CLONE_DIRECTORY_SETTING]: {
			type: 'string',
			default: DEFAULT_CLONE_DIRECTORY,
			scope: ConfigurationScope.MACHINE,
			markdownDescription: localize('githubRepos.cloneDirectory', "Folder GitHub repositories are cloned into. `~` is your home folder. It is created when missing, and Git: Clone offers it by default too."),
		},
	},
});

/**
 * The configured clone folder, created if missing. A folder that only differs in case (an
 * existing `~/Documents/github`, say) is used rather than creating a second one beside it.
 */
export async function ensureCloneFolder(configurationService: IConfigurationService, pathService: IPathService, fileService: IFileService): Promise<URI> {
	const configured = (configurationService.getValue<string>(CLONE_DIRECTORY_SETTING) || DEFAULT_CLONE_DIRECTORY).trim();
	const home = await pathService.userHome();
	let folder = configured === '~' || configured.startsWith('~/')
		? URI.joinPath(home, configured.slice(1))
		: home.with({ path: configured });

	if (!(await fileService.exists(folder))) {
		const parent = URI.joinPath(folder, '..');
		const name = folder.path.split('/').pop()?.toLowerCase();
		try {
			const sibling = (await fileService.resolve(parent)).children?.find(child => child.isDirectory && child.name.toLowerCase() === name);
			if (sibling) {
				folder = sibling.resource;
			}
		} catch {
			// The parent doesn't exist yet either; createFolder makes both
		}
	}
	if (!(await fileService.exists(folder))) {
		await fileService.createFolder(folder);
	}
	return folder;
}

export interface ICloneServices {
	readonly commandService: ICommandService;
	readonly configurationService: IConfigurationService;
	readonly pathService: IPathService;
	readonly fileService: IFileService;
	readonly dialogService: IDialogService;
	readonly workspaceContextService: IWorkspaceContextService;
	readonly workspaceEditingService: IWorkspaceEditingService;
}

/**
 * Clones `cloneUrl` into the clone folder through the git extension, calls `onCloned` with
 * where the repository now is (git may pick `name-1` when `name` is taken, or reuse an
 * existing clone), then offers to open it. Returns that location, or `undefined` when the
 * clone was cancelled or failed (the git extension reports failures itself).
 *
 * The git extension's own "open the repository?" prompt is skipped (`postCloneAction:
 * 'none'`): it is modal, so the caller only got the path back once it was answered, and
 * answering Open reloads the window before anything could be recorded.
 */
export async function cloneIntoCloneFolder(cloneUrl: string, services: ICloneServices, onCloned: (repository: URI) => void): Promise<URI | undefined> {
	const folder = await ensureCloneFolder(services.configurationService, services.pathService, services.fileService);
	const clonedPath = await services.commandService.executeCommand<string | undefined>('git.clone', cloneUrl, folder.fsPath, { postCloneAction: 'none' });
	if (typeof clonedPath !== 'string' || !clonedPath) {
		return undefined;
	}
	const cloned = folder.with({ path: URI.file(clonedPath).path });
	if (!(await services.fileService.exists(URI.joinPath(cloned, '.git')))) {
		return undefined;
	}
	onCloned(cloned);
	await offerToOpen(cloned, services);
	return cloned;
}

/** What the git extension would do after a clone, following `git.openAfterClone`. */
async function offerToOpen(repository: URI, services: ICloneServices): Promise<void> {
	const setting = services.configurationService.getValue<string>('git.openAfterClone');
	const hasFolders = services.workspaceContextService.getWorkspace().folders.length > 0;
	let action: 'open' | 'openNewWindow' | 'add' | undefined;
	if (setting === 'always' || (setting === 'whenNoFolderOpen' && !hasFolders)) {
		action = 'open';
	} else if (setting === 'alwaysNewWindow') {
		action = 'openNewWindow';
	} else {
		const buttons: { label: string; run: () => typeof action }[] = [
			{ label: localize({ key: 'githubRepos.openCloned', comment: ['&& denotes a mnemonic'] }, "&&Open"), run: () => 'open' },
			{ label: localize({ key: 'githubRepos.openClonedNewWindow', comment: ['&& denotes a mnemonic'] }, "Open in &&New Window"), run: () => 'openNewWindow' },
		];
		if (hasFolders) {
			buttons.push({ label: localize({ key: 'githubRepos.addCloned', comment: ['&& denotes a mnemonic'] }, "&&Add to Workspace"), run: () => 'add' });
		}
		const { result } = await services.dialogService.prompt({
			message: hasFolders
				? localize('githubRepos.openOrAdd', "Would you like to open the repository, or add it to the current workspace?")
				: localize('githubRepos.open', "Would you like to open the repository?"),
			buttons,
			cancelButton: true,
		});
		action = result;
	}
	if (action === 'open') {
		await services.commandService.executeCommand('vscode.openFolder', repository, { forceReuseWindow: true });
	} else if (action === 'openNewWindow') {
		await services.commandService.executeCommand('vscode.openFolder', repository, { forceNewWindow: true });
	} else if (action === 'add') {
		await services.workspaceEditingService.addFolders([{ uri: repository }]);
	}
}

/**
 * Makes the clone folder exist from the start, and the git extension's default clone
 * destination, so it is there to find and every clone lands in the same place.
 */
export class GithubCloneFolderContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.githubCloneFolder';

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IPathService private readonly pathService: IPathService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		void this.apply();
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CLONE_DIRECTORY_SETTING)) {
				void this.apply();
			}
		}));
	}

	private gitDefaults: IConfigurationDefaults | undefined;

	private async apply(): Promise<void> {
		try {
			const folder = await ensureCloneFolder(this.configurationService, this.pathService, this.fileService);
			const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
			if (this.gitDefaults) {
				registry.deregisterDefaultConfigurations([this.gitDefaults]);
			}
			this.gitDefaults = { overrides: { 'git.defaultCloneDirectory': folder.fsPath } };
			registry.registerDefaultConfigurations([this.gitDefaults]);
		} catch (err) {
			this.logService.warn('githubRepos: could not create the clone folder', err);
		}
	}
}
