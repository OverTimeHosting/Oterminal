/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../base/common/async.js';
import { Schemas } from '../../../../base/common/network.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

/** Contributed by the othcloud-mcp extension; see extensions/othcloud-mcp/src/extension.ts. */
const CLAUDE_LAUNCH_CONFIG_COMMAND = 'othcloud.mcp.claudeLaunchConfig';

/** How long a Claude terminal waits for the MCP server before launching without it. */
const LAUNCH_CONFIG_TIMEOUT_MS = 5000;

/** Claude Code subcommands, which do not take the session flags added here. */
const CLAUDE_SUBCOMMANDS = new Set(['mcp', 'config', 'doctor', 'update', 'install', 'migrate-installer', 'setup-token', 'plugin']);

interface IClaudeLaunchConfig {
	readonly configPath: string;
	readonly instructions: string;
}

/**
 * OTerminal: every terminal that runs Claude Code directly (a synced
 * `claude` profile, a local one, or an extension-created terminal) is started
 * connected to the othcloud-mcp server, told to use its git tools for commits
 * and pushes, and given every other workspace folder with `--add-dir`, so a
 * multi-root workspace puts all of its projects in front of Claude at once.
 *
 * Only the launch arguments change; if the MCP server is unavailable Claude
 * still starts, with just the workspace folders added.
 */
export async function applyOthcloudClaudeLaunch(
	shellLaunchConfig: IShellLaunchConfig,
	commandService: ICommandService,
	workspaceContextService: IWorkspaceContextService,
	logService: ILogService,
): Promise<void> {
	if (!isClaudeExecutable(shellLaunchConfig.executable) || typeof shellLaunchConfig.args === 'string') {
		return;
	}
	const userArgs = shellLaunchConfig.args ?? [];
	if (userArgs.length > 0 && CLAUDE_SUBCOMMANDS.has(userArgs[0])) {
		return;
	}

	let launchConfig: IClaudeLaunchConfig | undefined;
	try {
		launchConfig = await raceTimeout(
			commandService.executeCommand<IClaudeLaunchConfig | undefined>(CLAUDE_LAUNCH_CONFIG_COMMAND),
			LAUNCH_CONFIG_TIMEOUT_MS,
			() => logService.warn('[othcloud] MCP server did not answer in time, launching Claude without it'),
		);
	} catch (err) {
		logService.warn('[othcloud] MCP server unavailable, launching Claude without it', err);
	}

	// Both flags are variadic, so each list is closed by the next flag and the
	// profile's own arguments stay last, where a prompt argument belongs.
	const args: string[] = [];
	if (launchConfig) {
		args.push('--mcp-config', launchConfig.configPath);
	}
	const extraFolders = otherWorkspaceFolders(shellLaunchConfig.cwd, workspaceContextService);
	if (extraFolders.length > 0) {
		args.push('--add-dir', ...extraFolders);
	}
	const rest = [...userArgs];
	if (launchConfig) {
		// Claude Code keeps only one --append-system-prompt, so merge with the profile's
		const existing = rest.indexOf('--append-system-prompt');
		if (existing !== -1 && existing + 1 < rest.length) {
			rest[existing + 1] = `${launchConfig.instructions}\n\n${rest[existing + 1]}`;
		} else {
			args.push('--append-system-prompt', launchConfig.instructions);
		}
	}
	if (args.length === 0) {
		return;
	}
	shellLaunchConfig.args = [...args, ...rest];
}

function isClaudeExecutable(executable: string | undefined): boolean {
	if (!executable) {
		return false;
	}
	const base = executable.split(/[\\/]/).pop()!.toLowerCase();
	const name = isWindows ? base.replace(/\.(exe|cmd|bat|ps1)$/, '') : base;
	return name === 'claude';
}

/** Local workspace folders other than the one the terminal starts in. */
function otherWorkspaceFolders(cwd: string | URI | undefined, workspaceContextService: IWorkspaceContextService): string[] {
	const folders = workspaceContextService.getWorkspace().folders.filter(f => f.uri.scheme === Schemas.file);
	if (folders.length < 2) {
		return [];
	}
	const cwdPath = cwd === undefined ? folders[0].uri.fsPath : URI.isUri(cwd) ? cwd.fsPath : cwd;
	const same = (a: string, b: string) => isWindows ? a.toLowerCase() === b.toLowerCase() : a === b;
	const trim = (p: string) => p.replace(/[\\/]+$/, '');
	return folders.map(f => f.uri.fsPath).filter(p => !same(trim(p), trim(cwdPath)));
}
