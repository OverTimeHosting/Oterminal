/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** Environment variables every OTerminal terminal gets, read by the project `.mcp.json` entry. */
export const URL_ENV = 'OTERMINAL_MCP_URL';
/** Path of a file holding this window's `{"Authorization": "Bearer …"}` headers. */
export const HEADERS_ENV = 'OTERMINAL_MCP_HEADERS';

/**
 * Where the window holding the default port also writes its headers, for Claude Code started
 * outside OTerminal (which has no {@link HEADERS_ENV}). Relative to the home directory.
 */
export const SHARED_HEADERS_FILE = '.oterminal/mcp-headers.json';

export type ProjectConfigMode = 'update' | 'create' | 'off';

/**
 * The `.mcp.json` entry for this server. It holds neither the address nor the token, so it is
 * right in every terminal and safe to commit:
 * - the URL comes from {@link URL_ENV} inside OTerminal (each window exports its own
 *   server's), and is the default port elsewhere;
 * - the token comes from a `headersHelper` that prints a private headers file: this window's
 *   ({@link HEADERS_ENV}) inside OTerminal, the default port's ({@link SHARED_HEADERS_FILE})
 *   elsewhere, e.g. Claude Code started in another terminal app. POSIX shells only.
 */
export function projectServerEntry(defaultUrl: string) {
	return {
		type: 'sse',
		url: `\${${URL_ENV}:-${defaultUrl}}`,
		headersHelper: `cat "\${${HEADERS_ENV}:-$HOME/${SHARED_HEADERS_FILE}}"`,
	};
}

/**
 * Brings each workspace folder's `.mcp.json` entry for this server up to date: rewritten in
 * place when present (other servers and keys are left alone), and in `create` mode added to
 * folders that are git repositories. Only writes when something changes.
 */
export async function syncProjectConfigs(serverName: string, defaultUrl: string, mode: ProjectConfigMode, output: vscode.OutputChannel): Promise<void> {
	if (mode === 'off') {
		return;
	}
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		if (folder.uri.scheme !== 'file') {
			continue;
		}
		try {
			await syncFolder(folder.uri.fsPath, serverName, defaultUrl, mode, output);
		} catch (err) {
			output.appendLine(`[mcp] couldn't update ${path.join(folder.uri.fsPath, '.mcp.json')}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

async function syncFolder(folder: string, serverName: string, defaultUrl: string, mode: ProjectConfigMode, output: vscode.OutputChannel): Promise<void> {
	const file = path.join(folder, '.mcp.json');
	let text: string | undefined;
	try {
		text = await fs.readFile(file, 'utf8');
	} catch {
		text = undefined;
	}

	let config: { mcpServers?: Record<string, unknown>;[key: string]: unknown };
	if (text === undefined) {
		if (mode !== 'create' || !(await exists(path.join(folder, '.git')))) {
			return;
		}
		config = { mcpServers: {} };
	} else {
		try {
			config = JSON.parse(text);
		} catch {
			output.appendLine(`[mcp] ${file} isn't valid JSON; left as is`);
			return;
		}
		if (!config || typeof config !== 'object') {
			return;
		}
		if (!Object.prototype.hasOwnProperty.call(config.mcpServers ?? {}, serverName) && mode !== 'create') {
			return; // this repo doesn't use the server
		}
	}

	config.mcpServers = { ...(config.mcpServers ?? {}), [serverName]: projectServerEntry(defaultUrl) };
	const next = JSON.stringify(config, null, 2) + '\n';
	if (next === text) {
		return;
	}
	await fs.writeFile(file, next, 'utf8');
	output.appendLine(`[mcp] ${text === undefined ? 'created' : 'updated'} ${file}`);
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}
