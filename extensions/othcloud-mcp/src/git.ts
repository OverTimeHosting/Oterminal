/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import type { API as GitAPI, GitExtension, Repository, Status } from './git-api';

/**
 * Anything that even resembles an AI attribution line. We strip these out of every
 * commit message we forward to git, regardless of who put them there, so commits
 * always show up authored by the local git user with a message they wrote.
 */
const AI_ATTRIBUTION_PATTERNS: ReadonlyArray<RegExp> = [
	/^\s*co-authored-by:\s*claude\b.*$/gim,
	/^\s*co-authored-by:\s*.*<noreply@anthropic\.com>.*$/gim,
	/^\s*co-authored-by:\s*.*\bopenai\b.*$/gim,
	/^\s*co-authored-by:\s*.*<noreply@openai\.com>.*$/gim,
	/^\s*co-authored-by:\s*github\s+copilot\b.*$/gim,
	/^\s*generated[- ]with[: ].*claude.*$/gim,
	/^\s*generated[- ]with[: ].*claude code.*$/gim,
	// allow-any-unicode-next-line
	/^\s*🤖\s*generated with.*$/gim,
];

export function stripAiAttribution(message: string): string {
	let out = message;
	for (const re of AI_ATTRIBUTION_PATTERNS) {
		out = out.replace(re, '');
	}
	// Collapse trailing blank lines that the strip may have left behind.
	out = out.replace(/\n{3,}/g, '\n\n').replace(/\s+$/g, '');
	return out;
}

export async function getGitApi(): Promise<GitAPI> {
	const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!ext) {
		throw new Error('Built-in git extension is not installed.');
	}
	if (!ext.isActive) {
		await ext.activate();
	}
	const gitExt = ext.exports;
	if (!gitExt.enabled) {
		throw new Error('Built-in git extension is disabled.');
	}
	return gitExt.getAPI(1);
}

export function pickRepository(api: GitAPI, hint?: string): Repository {
	if (api.repositories.length === 0) {
		throw new Error('No git repository found in this workspace.');
	}
	if (!hint) {
		// Prefer the repo of the active editor, else the first one.
		const active = vscode.window.activeTextEditor?.document.uri;
		if (active) {
			const r = api.getRepository(active);
			if (r) { return r; }
		}
		return api.repositories[0];
	}
	const hintUri = toUriOrUndefined(hint);
	if (hintUri) {
		const r = api.getRepository(hintUri);
		if (r) { return r; }
	}
	const normalized = path.resolve(hint);
	for (const r of api.repositories) {
		if (path.resolve(r.rootUri.fsPath) === normalized) { return r; }
	}
	throw new Error(`No git repository matched: ${hint}`);
}

function toUriOrUndefined(input: string): vscode.Uri | undefined {
	try {
		if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) {
			return vscode.Uri.parse(input);
		}
		return vscode.Uri.file(path.resolve(input));
	} catch {
		return undefined;
	}
}

/**
 * Resolve a list of user-supplied paths to absolute fs paths inside the repo.
 * Accepts paths relative to the repo root, relative to the first workspace folder,
 * or absolute. Rejects anything that resolves outside the repository.
 */
export function resolveRepoPaths(repo: Repository, inputs: ReadonlyArray<string>): string[] {
	const root = path.resolve(repo.rootUri.fsPath);
	const out: string[] = [];
	for (const raw of inputs) {
		if (typeof raw !== 'string' || raw.length === 0) {
			throw new Error('Each path must be a non-empty string.');
		}
		const candidates = [raw, path.join(root, raw)];
		let resolved: string | undefined;
		for (const c of candidates) {
			const abs = path.resolve(c);
			if (abs === root || abs.startsWith(root + path.sep)) {
				resolved = abs;
				break;
			}
		}
		if (!resolved) {
			throw new Error(`Path is outside the repository: ${raw}`);
		}
		out.push(resolved);
	}
	return out;
}

export interface ChangeSummary {
	uri: string;
	relativePath: string;
	status: string;
}

export function summarizeChanges(repo: Repository): {
	branch: string | undefined;
	ahead: number | undefined;
	behind: number | undefined;
	staged: ChangeSummary[];
	unstaged: ChangeSummary[];
	untracked: ChangeSummary[];
	merge: ChangeSummary[];
} {
	const root = repo.rootUri.fsPath;
	const map = (uri: vscode.Uri, status: Status) => ({
		uri: uri.toString(),
		relativePath: path.relative(root, uri.fsPath).split(path.sep).join('/'),
		status: statusName(status),
	});
	return {
		branch: repo.state.HEAD?.name,
		ahead: repo.state.HEAD?.ahead,
		behind: repo.state.HEAD?.behind,
		staged: repo.state.indexChanges.map(c => map(c.uri, c.status)),
		unstaged: repo.state.workingTreeChanges.map(c => map(c.uri, c.status)),
		untracked: repo.state.untrackedChanges.map(c => map(c.uri, c.status)),
		merge: repo.state.mergeChanges.map(c => map(c.uri, c.status)),
	};
}

function statusName(status: Status): string {
	// Mirror the git extension's Status enum without importing it at runtime.
	const names: Record<number, string> = {
		0: 'INDEX_MODIFIED',
		1: 'INDEX_ADDED',
		2: 'INDEX_DELETED',
		3: 'INDEX_RENAMED',
		4: 'INDEX_COPIED',
		5: 'MODIFIED',
		6: 'DELETED',
		7: 'UNTRACKED',
		8: 'IGNORED',
		9: 'INTENT_TO_ADD',
		10: 'INTENT_TO_RENAME',
		11: 'TYPE_CHANGED',
		12: 'ADDED_BY_US',
		13: 'ADDED_BY_THEM',
		14: 'DELETED_BY_US',
		15: 'DELETED_BY_THEM',
		16: 'BOTH_ADDED',
		17: 'BOTH_DELETED',
		18: 'BOTH_MODIFIED',
	};
	return names[status as number] ?? `STATUS_${status}`;
}
