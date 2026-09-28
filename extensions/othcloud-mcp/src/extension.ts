/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { RunningServer, startServer } from './server';
import { getOrCreateToken, rotateToken } from './secret';
import { buildTools } from './tools';
import * as os from 'os';
import { HEADERS_ENV, ProjectConfigMode, SHARED_HEADERS_FILE, syncProjectConfigs, URL_ENV } from './projectConfig';

const EXT_NAME = 'othcloud-mcp';
const EXT_VERSION = '1.0.0';
const CONFIG_SECTION = 'othcloud.mcp';
const STICKY_PORT_KEY = 'othcloud.mcp.stickyPort';
const MCP_SERVER_NAME = 'oterminal';
/**
 * The port every window tries first, so the server's address stays the same. Only one window
 * can have it; the others fall back to a free port, and their terminals are pointed at theirs.
 */
const DEFAULT_PORT = 47820;

/**
 * Appended to the system prompt of every Claude Code session the terminal launches
 * (see the workbench's othcloudClaudeLaunch.ts), so git work goes through this server.
 */
const CLAUDE_INSTRUCTIONS = [
	`You are running inside OTerminal, which provides the "${MCP_SERVER_NAME}" MCP server.`,
	`For git work, always use its git tools (git.status, git.diff, git.log, git.stage, git.unstage, git.commit, git.branch, git.checkout, git.fetch, git.pull, git.push) instead of running git in the shell.`,
	`They act on the repositories open in OTerminal, so the user sees every change in the Source Control view, and pushes use the GitHub account signed in to OTerminal.`,
	`Pass "repository" (the repository root path) whenever more than one repository is open.`,
	`Only fall back to the git CLI for operations these tools do not cover, such as rebase, stash or tags.`,
].join(' ');

/** What the workbench needs to start Claude Code connected to this server. */
interface ClaudeLaunchConfig {
	/** Claude Code `--mcp-config` file describing this server, readable only by the user. */
	configPath: string;
	/** Text for Claude Code's `--append-system-prompt`. */
	instructions: string;
}

interface ServerState {
	running?: RunningServer;
	token: string;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const output = vscode.window.createOutputChannel('OTHCloud MCP');
	context.subscriptions.push(output);

	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
	statusBar.command = 'othcloud.mcp.showStatus';
	statusBar.text = '$(plug) MCP';
	statusBar.tooltip = 'OTHCloud MCP server';
	statusBar.show();
	context.subscriptions.push(statusBar);

	const state: ServerState = { token: await getOrCreateToken(context) };

	// This window's server, for the project `.mcp.json` entries (see projectConfig.ts). Not
	// persisted: a restored terminal must not get a previous session's address.
	context.environmentVariableCollection.persistent = false;
	context.environmentVariableCollection.description = 'OTHCloud MCP server address and token, for Claude Code';

	const projectConfigMode = () => vscode.workspace.getConfiguration(CONFIG_SECTION).get<ProjectConfigMode>('projectConfig', 'update');
	const defaultUrl = () => {
		const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const host = cfg.get<string>('host', '127.0.0.1') || '127.0.0.1';
		const port = cfg.get<number>('port', DEFAULT_PORT) || DEFAULT_PORT;
		return `http://${host}:${port}/sse`;
	};
	const syncProjects = () => syncProjectConfigs(MCP_SERVER_NAME, defaultUrl(), projectConfigMode(), output);

	const start = async (): Promise<void> => {
		await stop();
		const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
		if (cfg.get<boolean>('enabled', true) === false) {
			output.appendLine('[mcp] disabled by configuration');
			statusBar.text = '$(circle-slash) MCP off';
			statusBar.tooltip = 'OTHCloud MCP server is disabled (othcloud.mcp.enabled).';
			return;
		}
		const host = cfg.get<string>('host', '127.0.0.1') || '127.0.0.1';
		const configuredPort = cfg.get<number>('port', DEFAULT_PORT) ?? DEFAULT_PORT;
		const allowedOrigins = new Set<string>(cfg.get<string[]>('allowedOrigins', []) ?? []);

		// Sticky port: when no explicit port is configured (port = 0), reuse the
		// port we picked last time so MCP client configs don't break across restarts.
		const stickyPort = context.globalState.get<number>(STICKY_PORT_KEY);
		const portsToTry: number[] = [];
		if (configuredPort > 0) {
			// Taken (usually by another OTerminal window): any free port, for this window only
			portsToTry.push(configuredPort, 0);
		} else {
			if (typeof stickyPort === 'number' && stickyPort > 0 && stickyPort < 65536) {
				portsToTry.push(stickyPort);
			}
			portsToTry.push(0);
		}

		let lastErr: Error | undefined;
		for (const tryPort of portsToTry) {
			try {
				state.running = await startServer({
					host,
					port: tryPort,
					token: state.token,
					allowedOrigins,
					tools: buildTools(),
					serverName: EXT_NAME,
					serverVersion: EXT_VERSION,
					output,
				});
				lastErr = undefined;
				break;
			} catch (err) {
				lastErr = err instanceof Error ? err : new Error(String(err));
				output.appendLine(`[mcp] port ${tryPort} unavailable: ${lastErr.message}`);
				state.running = undefined;
			}
		}

		if (state.running) {
			if (configuredPort === 0) {
				// Remember the bound port for next time so the client config stays valid.
				await context.globalState.update(STICKY_PORT_KEY, state.running.port);
			}
			if (configuredPort > 0 && state.running.port !== configuredPort) {
				output.appendLine(`[mcp] port ${configuredPort} is in use (another OTerminal window?); this window uses ${state.running.port}`);
			}
			statusBar.text = `$(plug) MCP :${state.running.port}`;
			statusBar.tooltip = `OTHCloud MCP server listening on ${state.running.address}/sse`;
			const headersFile = await writeHeaders(context.globalStorageUri.fsPath, state.token, state.running.port === configuredPort, output);
			context.environmentVariableCollection.replace(URL_ENV, `${state.running.address}/sse`);
			if (headersFile) {
				context.environmentVariableCollection.replace(HEADERS_ENV, headersFile);
			}
			void syncProjects();
		} else {
			const msg = lastErr?.message ?? 'unknown error';
			output.appendLine(`[mcp] failed to start: ${msg}`);
			statusBar.text = '$(error) MCP';
			statusBar.tooltip = `OTHCloud MCP server failed to start: ${msg}`;
			void vscode.window.showErrorMessage(`OTHCloud MCP failed to start: ${msg}`);
		}
	};

	const stop = async (): Promise<void> => {
		if (state.running) {
			await state.running.close();
			state.running = undefined;
		}
	};

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration(`${CONFIG_SECTION}.projectConfig`)) {
			void syncProjects();
		} else if (e.affectsConfiguration(CONFIG_SECTION)) {
			void start();
		}
	}));

	// A repository opened into this window gets its `.mcp.json` brought up to date too
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void syncProjects()));

	context.subscriptions.push(vscode.commands.registerCommand('othcloud.mcp.showStatus', async () => {
		if (!state.running) {
			const pick = await vscode.window.showInformationMessage('OTHCloud MCP is not running.', 'Start', 'Open Logs');
			if (pick === 'Start') { await start(); }
			if (pick === 'Open Logs') { output.show(); }
			return;
		}
		const pick = await vscode.window.showInformationMessage(
			`OTHCloud MCP listening on ${state.running.address}/sse`,
			'Copy Config', 'Open Logs', 'Restart', 'Revoke Token',
		);
		if (pick === 'Copy Config') { await vscode.commands.executeCommand('othcloud.mcp.copyConfig'); }
		if (pick === 'Open Logs') { output.show(); }
		if (pick === 'Restart') { await start(); }
		if (pick === 'Revoke Token') { await vscode.commands.executeCommand('othcloud.mcp.revokeToken'); }
	}));

	context.subscriptions.push(vscode.commands.registerCommand('othcloud.mcp.copyConfig', async () => {
		if (!state.running) {
			void vscode.window.showWarningMessage('OTHCloud MCP is not running.');
			return;
		}
		const config = {
			mcpServers: {
				[MCP_SERVER_NAME]: {
					type: 'sse',
					url: `${state.running.address}/sse`,
					headers: { Authorization: `Bearer ${state.token}` },
				},
			},
		};
		await vscode.env.clipboard.writeText(JSON.stringify(config, null, 2));
		void vscode.window.showInformationMessage('Claude Code MCP config copied to clipboard.');
	}));

	// Called by the workbench whenever it launches Claude Code in a terminal.
	context.subscriptions.push(vscode.commands.registerCommand('othcloud.mcp.claudeLaunchConfig', async (): Promise<ClaudeLaunchConfig | undefined> => {
		if (!state.running) {
			await start();
		}
		if (!state.running) {
			return undefined;
		}
		const config = {
			mcpServers: {
				[MCP_SERVER_NAME]: {
					type: 'sse',
					url: `${state.running.address}/sse`,
					headers: { Authorization: `Bearer ${state.token}` },
				},
			},
		};
		const dir = context.globalStorageUri.fsPath;
		const configPath = path.join(dir, 'claude-mcp.json');
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
		// writeFile only applies the mode when it creates the file
		await fs.chmod(configPath, 0o600);
		return { configPath, instructions: CLAUDE_INSTRUCTIONS };
	}));

	context.subscriptions.push(vscode.commands.registerCommand('othcloud.mcp.restart', async () => {
		await start();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('othcloud.mcp.revokeToken', async () => {
		const confirm = await vscode.window.showWarningMessage(
			'Revoke the current MCP token? Any connected clients will need a new token.',
			{ modal: true }, 'Revoke',
		);
		if (confirm !== 'Revoke') { return; }
		state.token = await rotateToken(context);
		await start();
		void vscode.window.showInformationMessage('OTHCloud MCP token rotated. Use "Copy Config" to share the new token.');
	}));

	context.subscriptions.push({ dispose: () => { void stop(); } });

	await start();
}

/**
 * Writes this window's MCP headers where the project `.mcp.json` entry's `headersHelper`
 * reads them (see projectConfig.ts), readable by the user only. The window holding the
 * default port also writes the shared file that terminals outside OTerminal fall back to.
 * Returns this window's file.
 */
async function writeHeaders(storageDir: string, token: string, ownsDefaultPort: boolean, output: vscode.OutputChannel): Promise<string | undefined> {
	const content = JSON.stringify({ Authorization: `Bearer ${token}` }) + '\n';
	const write = async (file: string) => {
		await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		await fs.writeFile(file, content, { mode: 0o600 });
		await fs.chmod(file, 0o600); // writeFile only applies the mode when it creates the file
	};
	try {
		const own = path.join(storageDir, 'mcp-headers.json');
		await write(own);
		if (ownsDefaultPort) {
			await write(path.join(os.homedir(), SHARED_HEADERS_FILE));
		}
		return own;
	} catch (err) {
		output.appendLine(`[mcp] couldn't write the MCP headers file: ${err instanceof Error ? err.message : String(err)}`);
		return undefined;
	}
}

export function deactivate(): Thenable<void> | undefined {
	return undefined;
}
