/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { getGitApi, pickRepository, resolveRepoPaths, stripAiAttribution, summarizeChanges } from './git';
import { McpToolDefinition } from './server';

export function buildTools(): Map<string, McpToolDefinition> {
	const tools: McpToolDefinition[] = [
		gitStatusTool(),
		gitStageTool(),
		gitUnstageTool(),
		gitSetMessageTool(),
		gitCommitTool(),
		gitDiffTool(),
		gitLogTool(),
		gitBranchTool(),
		gitCheckoutTool(),
		gitFetchTool(),
		gitPullTool(),
		gitPushTool(),
		editorOpenFileTool(),
		editorRevealRangeTool(),
		editorSplitTool(),
		editorGetSelectionTool(),
		editorInsertTextTool(),
		browserOpenTool(),
		terminalRunTool(),
		workspaceListTool(),
		workspaceFindFilesTool(),
		fsReadFileTool(),
		fsWriteFileTool(),
		diagnosticsGetTool(),
		commandExecuteTool(),
		notificationShowTool(),
	];
	const map = new Map<string, McpToolDefinition>();
	for (const t of tools) { map.set(t.name, t); }
	return map;
}

const repoArg = {
	repository: {
		type: 'string',
		description: 'Optional repository hint: an absolute path, file URI, or repo root path. Defaults to the active editor\'s repo, else the first one.',
	},
} as const;

function gitStatusTool(): McpToolDefinition {
	return {
		name: 'git.status',
		description: 'Summarize the current repository state: branch, ahead/behind counts, and staged / unstaged / untracked / merge changes.',
		inputSchema: {
			type: 'object',
			properties: { ...repoArg },
			additionalProperties: false,
		},
		handler: async args => {
			const api = await getGitApi();
			const repo = pickRepository(api, typeof args.repository === 'string' ? args.repository : undefined);
			return summarizeChanges(repo);
		},
	};
}

function gitStageTool(): McpToolDefinition {
	return {
		name: 'git.stage',
		description: 'Stage one or more files in the source control panel (git add). Paths may be repo-relative or absolute. Pass {"all": true} to stage every change.',
		inputSchema: {
			type: 'object',
			properties: {
				...repoArg,
				paths: {
					type: 'array',
					items: { type: 'string' },
					description: 'Paths to stage. Required unless "all" is true.',
				},
				all: {
					type: 'boolean',
					description: 'Stage every unstaged change (working tree + untracked).',
				},
			},
			additionalProperties: false,
		},
		handler: async args => {
			const api = await getGitApi();
			const repo = pickRepository(api, typeof args.repository === 'string' ? args.repository : undefined);
			let paths: string[];
			if (args.all === true) {
				paths = [
					...repo.state.workingTreeChanges.map(c => c.uri.fsPath),
					...repo.state.untrackedChanges.map(c => c.uri.fsPath),
				];
			} else {
				const raw = Array.isArray(args.paths) ? (args.paths as unknown[]).map(String) : [];
				if (raw.length === 0) {
					throw new Error('Provide "paths" or set "all": true.');
				}
				paths = resolveRepoPaths(repo, raw);
			}
			if (paths.length === 0) {
				return { staged: 0, message: 'Nothing to stage.' };
			}
			await repo.add(paths);
			return { staged: paths.length, paths: paths.map(p => path.relative(repo.rootUri.fsPath, p)) };
		},
	};
}

function gitUnstageTool(): McpToolDefinition {
	return {
		name: 'git.unstage',
		description: 'Unstage one or more files (git reset HEAD -- <paths>). Paths may be repo-relative or absolute. Pass {"all": true} to unstage everything.',
		inputSchema: {
			type: 'object',
			properties: {
				...repoArg,
				paths: { type: 'array', items: { type: 'string' } },
				all: { type: 'boolean' },
			},
			additionalProperties: false,
		},
		handler: async args => {
			const api = await getGitApi();
			const repo = pickRepository(api, typeof args.repository === 'string' ? args.repository : undefined);
			let paths: string[];
			if (args.all === true) {
				paths = repo.state.indexChanges.map(c => c.uri.fsPath);
			} else {
				const raw = Array.isArray(args.paths) ? (args.paths as unknown[]).map(String) : [];
				if (raw.length === 0) {
					throw new Error('Provide "paths" or set "all": true.');
				}
				paths = resolveRepoPaths(repo, raw);
			}
			if (paths.length === 0) {
				return { unstaged: 0, message: 'Nothing to unstage.' };
			}
			await repo.revert(paths);
			return { unstaged: paths.length, paths: paths.map(p => path.relative(repo.rootUri.fsPath, p)) };
		},
	};
}

function gitSetMessageTool(): McpToolDefinition {
	return {
		name: 'git.setMessage',
		description: 'Set the text shown in the source control commit message box. AI attribution lines (Co-Authored-By: Claude, etc.) are stripped before writing.',
		inputSchema: {
			type: 'object',
			properties: {
				...repoArg,
				message: { type: 'string', description: 'The commit message to place in the input box.' },
			},
			required: ['message'],
			additionalProperties: false,
		},
		handler: async args => {
			const api = await getGitApi();
			const repo = pickRepository(api, typeof args.repository === 'string' ? args.repository : undefined);
			const cleaned = stripAiAttribution(String(args.message ?? ''));
			repo.inputBox.value = cleaned;
			return { message: cleaned };
		},
	};
}

function gitCommitTool(): McpToolDefinition {
	return {
		name: 'git.commit',
		description: 'Create a commit using the configured local git user. AI attribution lines (Co-Authored-By: Claude, GitHub Copilot, "Generated with Claude Code", etc.) are stripped from the message before commit. Falls back to the SCM message box if "message" is omitted.',
		inputSchema: {
			type: 'object',
			properties: {
				...repoArg,
				message: { type: 'string', description: 'Commit message. If omitted, uses the current SCM input box value.' },
				stageAll: { type: 'boolean', description: 'Stage tracked changes first (git commit -a). Default false.' },
				amend: { type: 'boolean', description: 'Amend the previous commit. Default false.' },
				signoff: { type: 'boolean' },
			},
			additionalProperties: false,
		},
		handler: async args => {
			const api = await getGitApi();
			const repo = pickRepository(api, typeof args.repository === 'string' ? args.repository : undefined);

			const rawMessage = typeof args.message === 'string' && args.message.trim().length > 0
				? args.message
				: repo.inputBox.value;
			if (!rawMessage || !rawMessage.trim()) {
				throw new Error('No commit message provided and the SCM message box is empty.');
			}
			const cleaned = stripAiAttribution(rawMessage).trim();
			if (!cleaned) {
				throw new Error('Commit message is empty after stripping AI attribution. Provide a real message.');
			}

			await repo.commit(cleaned, {
				all: args.stageAll === true ? 'tracked' : undefined,
				amend: args.amend === true ? true : undefined,
				signoff: args.signoff === true ? true : undefined,
				// Never pass useEditor: we want to forward our cleaned message verbatim.
				useEditor: false,
			});

			// Clear the input box on success so the user sees the empty state they'd expect.
			if (repo.inputBox.value === rawMessage || repo.inputBox.value === cleaned) {
				repo.inputBox.value = '';
			}

			const head = repo.state.HEAD;
			return {
				committed: true,
				message: cleaned,
				branch: head?.name,
				hash: head?.commit,
				note: 'Committed using the local git user (user.name / user.email). No AI attribution was added.',
			};
		},
	};
}

function editorOpenFileTool(): McpToolDefinition {
	return {
		name: 'editor.openFile',
		description: 'Open a file in an editor and optionally reveal a range. Path may be absolute or workspace-relative. Brings the editor to the foreground.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Absolute or workspace-relative path.' },
				uri: { type: 'string', description: 'Alternatively, a fully-qualified URI (file://, vscode-remote://...).' },
				startLine: { type: 'number', description: '1-based line to focus.' },
				endLine: { type: 'number', description: '1-based end line for the selection.' },
				preview: { type: 'boolean', description: 'Open in preview mode (single tab reused). Default true.' },
				viewColumn: { type: 'number', description: 'Target editor group (1, 2, 3, ...). Defaults to the active column.' },
			},
			additionalProperties: false,
		},
		handler: async args => {
			const uri = resolveTargetUri(args);
			const doc = await vscode.workspace.openTextDocument(uri);
			const options: vscode.TextDocumentShowOptions = {
				preview: args.preview === undefined ? true : Boolean(args.preview),
				viewColumn: typeof args.viewColumn === 'number' ? args.viewColumn as vscode.ViewColumn : undefined,
			};
			if (typeof args.startLine === 'number') {
				const start = Math.max(0, Math.floor(args.startLine) - 1);
				const end = typeof args.endLine === 'number' ? Math.max(start, Math.floor(args.endLine) - 1) : start;
				options.selection = new vscode.Range(start, 0, end, Number.MAX_SAFE_INTEGER);
			}
			const editor = await vscode.window.showTextDocument(doc, options);
			return { opened: uri.toString(), viewColumn: editor.viewColumn };
		},
	};
}

function editorRevealRangeTool(): McpToolDefinition {
	return {
		name: 'editor.revealRange',
		description: 'Reveal a line range in the active editor (no scrolling if already visible).',
		inputSchema: {
			type: 'object',
			properties: {
				startLine: { type: 'number', description: '1-based line.' },
				endLine: { type: 'number' },
				at: { type: 'string', enum: ['default', 'top', 'center', 'centerIfOutsideViewport'], description: 'Reveal strategy.' },
			},
			required: ['startLine'],
			additionalProperties: false,
		},
		handler: async args => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) { throw new Error('No active editor.'); }
			const start = Math.max(0, Math.floor(Number(args.startLine)) - 1);
			const end = typeof args.endLine === 'number' ? Math.max(start, Math.floor(args.endLine) - 1) : start;
			const range = new vscode.Range(start, 0, end, Number.MAX_SAFE_INTEGER);
			const at = String(args.at ?? 'default');
			const map: Record<string, vscode.TextEditorRevealType> = {
				default: vscode.TextEditorRevealType.Default,
				top: vscode.TextEditorRevealType.AtTop,
				center: vscode.TextEditorRevealType.InCenter,
				centerIfOutsideViewport: vscode.TextEditorRevealType.InCenterIfOutsideViewport,
			};
			editor.revealRange(range, map[at] ?? vscode.TextEditorRevealType.Default);
			editor.selection = new vscode.Selection(start, 0, end, 0);
			return { revealed: true, file: editor.document.uri.toString(), startLine: start + 1, endLine: end + 1 };
		},
	};
}

function editorSplitTool(): McpToolDefinition {
	return {
		name: 'editor.split',
		description: 'Split the active editor (right, down, up, left) or focus a specific editor group.',
		inputSchema: {
			type: 'object',
			properties: {
				direction: { type: 'string', enum: ['right', 'down', 'up', 'left'], description: 'Split direction. Default right.' },
				focusGroup: { type: 'number', description: 'Focus editor group N (1-based) instead of splitting.' },
			},
			additionalProperties: false,
		},
		handler: async args => {
			if (typeof args.focusGroup === 'number') {
				const cmd = `workbench.action.focusGroup-${Math.max(1, Math.floor(args.focusGroup))}`;
				try {
					await vscode.commands.executeCommand(cmd);
				} catch {
					await vscode.commands.executeCommand('workbench.action.focusNextGroup');
				}
				return { focusGroup: args.focusGroup };
			}
			const dir = String(args.direction ?? 'right');
			const splitCommand: Record<string, string> = {
				right: 'workbench.action.splitEditorRight',
				down: 'workbench.action.splitEditorDown',
				up: 'workbench.action.splitEditorUp',
				left: 'workbench.action.splitEditorLeft',
			};
			await vscode.commands.executeCommand(splitCommand[dir] ?? splitCommand.right);
			return { split: dir };
		},
	};
}

function browserOpenTool(): McpToolDefinition {
	return {
		name: 'browser.open',
		description: 'Open a URL in othcloud terminal\'s built-in Simple Browser (default) or in the OS default browser. Use this to show the user a live preview, docs, or a localhost dev server.',
		inputSchema: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'Absolute URL (http, https, vscode://, etc.).' },
				target: { type: 'string', enum: ['simple', 'external'], description: 'simple = built-in Simple Browser webview, external = OS default browser. Default simple.' },
				viewColumn: { type: 'number', description: 'For target=simple: editor group to open the webview in.' },
			},
			required: ['url'],
			additionalProperties: false,
		},
		handler: async args => {
			const url = String(args.url ?? '').trim();
			if (!url) { throw new Error('A url is required.'); }
			const target = String(args.target ?? 'simple');
			if (target === 'external') {
				const ok = await vscode.env.openExternal(vscode.Uri.parse(url));
				return { opened: url, target, success: ok };
			}
			await vscode.commands.executeCommand('simpleBrowser.api.open', vscode.Uri.parse(url), {
				viewColumn: typeof args.viewColumn === 'number' ? args.viewColumn : vscode.ViewColumn.Beside,
				preserveFocus: false,
			});
			return { opened: url, target: 'simple' };
		},
	};
}

function terminalRunTool(): McpToolDefinition {
	return {
		name: 'terminal.run',
		description: 'Send text to an integrated terminal so the user can see the command run. Creates a named terminal if one doesn\'t exist, or reuses it. This is for user-visible commands - it does NOT return command output.',
		inputSchema: {
			type: 'object',
			properties: {
				command: { type: 'string', description: 'The text to send. A trailing newline is added unless "execute" is false.' },
				name: { type: 'string', description: 'Terminal name. Reused if a terminal with this name already exists. Default "MCP".' },
				cwd: { type: 'string', description: 'Working directory for a newly created terminal. Ignored if the named terminal already exists.' },
				show: { type: 'boolean', description: 'Bring the terminal panel to the foreground. Default true.' },
				execute: { type: 'boolean', description: 'Append a newline so the shell runs the command. Default true.' },
			},
			required: ['command'],
			additionalProperties: false,
		},
		handler: async args => {
			const command = String(args.command ?? '');
			if (!command) { throw new Error('A command is required.'); }
			const name = typeof args.name === 'string' && args.name ? args.name : 'MCP';
			const show = args.show === undefined ? true : Boolean(args.show);
			const execute = args.execute === undefined ? true : Boolean(args.execute);

			let terminal = vscode.window.terminals.find(t => t.name === name);
			if (!terminal) {
				const opts: vscode.TerminalOptions = { name };
				if (typeof args.cwd === 'string' && args.cwd) {
					opts.cwd = args.cwd;
				}
				terminal = vscode.window.createTerminal(opts);
			}
			terminal.sendText(command, execute);
			if (show) { terminal.show(false); }
			return { terminal: name, sent: command, executed: execute };
		},
	};
}

function resolveTargetUri(args: Record<string, unknown>): vscode.Uri {
	const uriStr = typeof args.uri === 'string' ? args.uri : undefined;
	if (uriStr) {
		return vscode.Uri.parse(uriStr);
	}
	const p = typeof args.path === 'string' ? args.path : undefined;
	if (!p) {
		throw new Error('Provide "path" or "uri".');
	}
	if (path.isAbsolute(p)) {
		return vscode.Uri.file(p);
	}
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		throw new Error(`Cannot resolve relative path without a workspace: ${p}`);
	}
	return vscode.Uri.joinPath(folders[0].uri, p);
}

function resolvePathUri(p: string): vscode.Uri {
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)) {
		return vscode.Uri.parse(p);
	}
	if (path.isAbsolute(p)) {
		return vscode.Uri.file(p);
	}
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		throw new Error(`Cannot resolve relative path without a workspace: ${p}`);
	}
	return vscode.Uri.joinPath(folders[0].uri, p);
}

function gitDiffTool(): McpToolDefinition {
	return {
		name: 'git.diff',
		description: 'Return the unified diff for the working tree (default) or the staged index (cached: true). Optionally narrow to a single file path.',
		inputSchema: {
			type: 'object',
			properties: {
				...repoArg,
				cached: { type: 'boolean', description: 'Diff the staged index against HEAD instead of the working tree against the index. Default false.' },
				path: { type: 'string', description: 'Optional repo-relative or absolute path. When set, returns the per-file diff.' },
			},
			additionalProperties: false,
		},
		handler: async args => {
			const api = await getGitApi();
			const repo = pickRepository(api, typeof args.repository === 'string' ? args.repository : undefined);
			if (typeof args.path === 'string' && args.path.length > 0) {
				const [resolved] = resolveRepoPaths(repo, [args.path]);
				const diff = await repo.diffWithHEAD(resolved);
				return { path: path.relative(repo.rootUri.fsPath, resolved), diff };
			}
			const cached = args.cached === true;
			const diff = await repo.diff(cached);
			return { cached, diff };
		},
	};
}

function gitLogTool(): McpToolDefinition {
	return {
		name: 'git.log',
		description: 'Return the most recent commits on the current branch.',
		inputSchema: {
			type: 'object',
			properties: {
				...repoArg,
				maxEntries: { type: 'number', description: 'Max commits to return. Default 20.' },
				path: { type: 'string', description: 'Only include commits that touched this path.' },
				ref: { type: 'string', description: 'Start from this ref instead of HEAD.' },
			},
			additionalProperties: false,
		},
		handler: async args => {
			const api = await getGitApi();
			const repo = pickRepository(api, typeof args.repository === 'string' ? args.repository : undefined);
			const maxEntries = typeof args.maxEntries === 'number' ? Math.max(1, Math.floor(args.maxEntries)) : 20;
			const commits = await repo.log({
				maxEntries,
				path: typeof args.path === 'string' ? args.path : undefined,
				ref: typeof args.ref === 'string' ? args.ref : undefined,
			});
			return {
				commits: commits.map(c => ({
					hash: c.hash,
					message: c.message,
					author: c.authorName,
					email: c.authorEmail,
					date: c.authorDate?.toISOString(),
					parents: c.parents,
				})),
			};
		},
	};
}

function gitBranchTool(): McpToolDefinition {
	return {
		name: 'git.branch',
		description: 'List branches (local by default) and return the currently checked-out branch.',
		inputSchema: {
			type: 'object',
			properties: {
				...repoArg,
				remote: { type: 'boolean', description: 'Include remote-tracking branches. Default false.' },
				pattern: { type: 'string', description: 'Optional refname pattern filter.' },
				count: { type: 'number', description: 'Max branches to return. Default 100.' },
			},
			additionalProperties: false,
		},
		handler: async args => {
			const api = await getGitApi();
			const repo = pickRepository(api, typeof args.repository === 'string' ? args.repository : undefined);
			const branches = await repo.getBranches({
				remote: args.remote === true,
				pattern: typeof args.pattern === 'string' ? args.pattern : undefined,
				count: typeof args.count === 'number' ? Math.max(1, Math.floor(args.count)) : 100,
			});
			return {
				current: repo.state.HEAD?.name,
				branches: branches.map(b => ({ name: b.name, commit: b.commit, remote: b.remote })),
			};
		},
	};
}

function gitCheckoutTool(): McpToolDefinition {
	return {
		name: 'git.checkout',
		description: 'Check out an existing branch, tag, or commit. Pass {"createBranch": "feature/x"} to create + switch to a new branch from the current HEAD (or from "ref").',
		inputSchema: {
			type: 'object',
			properties: {
				...repoArg,
				treeish: { type: 'string', description: 'Branch/tag/commit to check out. Required unless createBranch is set.' },
				createBranch: { type: 'string', description: 'Create a new branch with this name and switch to it.' },
				ref: { type: 'string', description: 'Starting point for createBranch. Defaults to current HEAD.' },
			},
			additionalProperties: false,
		},
		handler: async args => {
			const api = await getGitApi();
			const repo = pickRepository(api, typeof args.repository === 'string' ? args.repository : undefined);
			if (typeof args.createBranch === 'string' && args.createBranch.length > 0) {
				await repo.createBranch(args.createBranch, true, typeof args.ref === 'string' ? args.ref : undefined);
				return { created: args.createBranch, head: repo.state.HEAD?.name };
			}
			if (typeof args.treeish !== 'string' || args.treeish.length === 0) {
				throw new Error('Provide "treeish" or "createBranch".');
			}
			await repo.checkout(args.treeish);
			return { checkedOut: args.treeish, head: repo.state.HEAD?.name };
		},
	};
}

function gitFetchTool(): McpToolDefinition {
	return {
		name: 'git.fetch',
		description: 'Fetch from a remote (default: the current branch\'s upstream remote, else all remotes) so ahead/behind counts are up to date.',
		inputSchema: {
			type: 'object',
			properties: {
				...repoArg,
				remote: { type: 'string', description: 'Remote to fetch from. Defaults to the upstream remote.' },
				prune: { type: 'boolean', description: 'Remove remote-tracking branches that no longer exist. Default false.' },
			},
			additionalProperties: false,
		},
		handler: async args => {
			const api = await getGitApi();
			const repo = pickRepository(api, typeof args.repository === 'string' ? args.repository : undefined);
			const remote = typeof args.remote === 'string' && args.remote.length > 0 ? args.remote : repo.state.HEAD?.upstream?.remote;
			await repo.fetch({ remote, all: remote === undefined, prune: args.prune === true });
			const head = repo.state.HEAD;
			return { fetched: remote ?? 'all', branch: head?.name, ahead: head?.ahead, behind: head?.behind };
		},
	};
}

function gitPullTool(): McpToolDefinition {
	return {
		name: 'git.pull',
		description: 'Pull the current branch from its upstream, using the git settings and credentials of othcloud terminal\'s Source Control view.',
		inputSchema: {
			type: 'object',
			properties: { ...repoArg },
			additionalProperties: false,
		},
		handler: async args => {
			const api = await getGitApi();
			const repo = pickRepository(api, typeof args.repository === 'string' ? args.repository : undefined);
			if (!repo.state.HEAD?.upstream) {
				throw new Error(`Branch ${repo.state.HEAD?.name ?? '(detached HEAD)'} has no upstream to pull from.`);
			}
			await repo.pull();
			const head = repo.state.HEAD;
			return { pulled: true, branch: head?.name, hash: head?.commit, ahead: head?.ahead, behind: head?.behind };
		},
	};
}

function gitPushTool(): McpToolDefinition {
	return {
		name: 'git.push',
		description: 'Push the current branch, using the GitHub account signed in to othcloud terminal. A branch without an upstream is published to "origin" (or the only remote) and its upstream is set. Plain force pushes are not offered; use forceWithLease to overwrite a remote branch you rewrote.',
		inputSchema: {
			type: 'object',
			properties: {
				...repoArg,
				remote: { type: 'string', description: 'Remote to push to. Defaults to the upstream remote, else "origin", else the only remote.' },
				branch: { type: 'string', description: 'Branch to push. Defaults to the current branch.' },
				forceWithLease: { type: 'boolean', description: 'Push with --force-with-lease. Default false.' },
			},
			additionalProperties: false,
		},
		handler: async args => {
			const api = await getGitApi();
			const repo = pickRepository(api, typeof args.repository === 'string' ? args.repository : undefined);
			const head = repo.state.HEAD;
			const branch = typeof args.branch === 'string' && args.branch.length > 0 ? args.branch : head?.name;
			if (!branch) {
				throw new Error('HEAD is detached; pass "branch" or check out a branch first.');
			}
			const upstream = branch === head?.name ? head?.upstream : undefined;
			let remote = typeof args.remote === 'string' && args.remote.length > 0 ? args.remote : upstream?.remote;
			if (!remote) {
				const remotes = repo.state.remotes;
				remote = remotes.find(r => r.name === 'origin')?.name ?? (remotes.length === 1 ? remotes[0].name : undefined);
			}
			if (!remote) {
				throw new Error(repo.state.remotes.length === 0 ? 'This repository has no remotes.' : 'Several remotes are configured; pass "remote".');
			}
			const setUpstream = !upstream;
			await repo.push(remote, branch, setUpstream, args.forceWithLease === true ? 1 : undefined);
			return { pushed: true, remote, branch, setUpstream, hash: repo.state.HEAD?.commit };
		},
	};
}

function editorGetSelectionTool(): McpToolDefinition {
	return {
		name: 'editor.getSelection',
		description: 'Return the active editor\'s current selection (text and range). If nothing is selected, returns the text of the current line.',
		inputSchema: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
		handler: async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) { throw new Error('No active editor.'); }
			const sel = editor.selection;
			const doc = editor.document;
			const isEmpty = sel.isEmpty;
			const range = isEmpty ? doc.lineAt(sel.active.line).range : new vscode.Range(sel.start, sel.end);
			return {
				uri: doc.uri.toString(),
				language: doc.languageId,
				text: doc.getText(range),
				startLine: range.start.line + 1,
				startColumn: range.start.character + 1,
				endLine: range.end.line + 1,
				endColumn: range.end.character + 1,
				isEmpty,
			};
		},
	};
}

function editorInsertTextTool(): McpToolDefinition {
	return {
		name: 'editor.insertText',
		description: 'Insert text at the active editor cursor, or replace the current selection. Edits go through the editor so undo/redo and dirty state behave normally.',
		inputSchema: {
			type: 'object',
			properties: {
				text: { type: 'string', description: 'Text to insert or replace with.' },
				replaceSelection: { type: 'boolean', description: 'If a selection exists, replace it. Default true.' },
				startLine: { type: 'number', description: '1-based start line for an explicit range replacement.' },
				startColumn: { type: 'number', description: '1-based start column for an explicit range replacement.' },
				endLine: { type: 'number', description: '1-based end line for an explicit range replacement.' },
				endColumn: { type: 'number', description: '1-based end column for an explicit range replacement.' },
			},
			required: ['text'],
			additionalProperties: false,
		},
		handler: async args => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) { throw new Error('No active editor.'); }
			const text = String(args.text ?? '');
			const replaceSelection = args.replaceSelection !== false;
			const hasExplicit = ['startLine', 'startColumn', 'endLine', 'endColumn'].some(k => typeof args[k] === 'number');
			let range: vscode.Range | undefined;
			if (hasExplicit) {
				const sL = Math.max(1, Math.floor(Number(args.startLine ?? 1))) - 1;
				const sC = Math.max(1, Math.floor(Number(args.startColumn ?? 1))) - 1;
				const eL = Math.max(sL + 1, Math.floor(Number(args.endLine ?? args.startLine ?? 1))) - 1;
				const eC = Math.max(1, Math.floor(Number(args.endColumn ?? sC + 1))) - 1;
				range = new vscode.Range(sL, sC, eL, eC);
			}
			const ok = await editor.edit(b => {
				if (range) {
					b.replace(range, text);
				} else if (replaceSelection && !editor.selection.isEmpty) {
					b.replace(editor.selection, text);
				} else {
					b.insert(editor.selection.active, text);
				}
			});
			return { applied: ok, uri: editor.document.uri.toString() };
		},
	};
}

function workspaceListTool(): McpToolDefinition {
	return {
		name: 'workspace.list',
		description: 'List the workspace folders currently open in this window.',
		inputSchema: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
		handler: async () => {
			const folders = vscode.workspace.workspaceFolders ?? [];
			return {
				name: vscode.workspace.name,
				folders: folders.map(f => ({
					name: f.name,
					index: f.index,
					uri: f.uri.toString(),
					path: f.uri.fsPath,
				})),
			};
		},
	};
}

function workspaceFindFilesTool(): McpToolDefinition {
	return {
		name: 'workspace.findFiles',
		description: 'Find workspace files by glob (e.g. "**/*.ts"). Honors files.exclude / search.exclude by default.',
		inputSchema: {
			type: 'object',
			properties: {
				include: { type: 'string', description: 'Glob pattern (relative to workspace).' },
				exclude: { type: 'string', description: 'Optional exclude glob.' },
				maxResults: { type: 'number', description: 'Default 200.' },
			},
			required: ['include'],
			additionalProperties: false,
		},
		handler: async args => {
			const include = String(args.include ?? '');
			if (!include) { throw new Error('"include" glob is required.'); }
			const exclude = typeof args.exclude === 'string' ? args.exclude : undefined;
			const maxResults = typeof args.maxResults === 'number' ? Math.max(1, Math.floor(args.maxResults)) : 200;
			const results = await vscode.workspace.findFiles(include, exclude, maxResults);
			return {
				count: results.length,
				files: results.map(u => ({ uri: u.toString(), path: u.fsPath })),
			};
		},
	};
}

function fsReadFileTool(): McpToolDefinition {
	return {
		name: 'fs.readFile',
		description: 'Read a UTF-8 text file. Path may be absolute, workspace-relative, or a fully-qualified URI.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path or URI to read.' },
				maxBytes: { type: 'number', description: 'Truncate after this many bytes. Default 1048576 (1 MiB).' },
			},
			required: ['path'],
			additionalProperties: false,
		},
		handler: async args => {
			const uri = resolvePathUri(String(args.path ?? ''));
			const maxBytes = typeof args.maxBytes === 'number' ? Math.max(1, Math.floor(args.maxBytes)) : 1024 * 1024;
			const data = await vscode.workspace.fs.readFile(uri);
			const truncated = data.byteLength > maxBytes;
			const slice = truncated ? data.subarray(0, maxBytes) : data;
			return {
				uri: uri.toString(),
				size: data.byteLength,
				truncated,
				content: Buffer.from(slice).toString('utf8'),
			};
		},
	};
}

function fsWriteFileTool(): McpToolDefinition {
	return {
		name: 'fs.writeFile',
		description: 'Write UTF-8 text to a file (creates parent directories as needed). Overwrites existing content; set createOnly to refuse when the file already exists.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path or URI to write.' },
				content: { type: 'string', description: 'UTF-8 text to write.' },
				createOnly: { type: 'boolean', description: 'If true, fail when the file already exists. Default false.' },
			},
			required: ['path', 'content'],
			additionalProperties: false,
		},
		handler: async args => {
			const uri = resolvePathUri(String(args.path ?? ''));
			const content = String(args.content ?? '');
			if (args.createOnly === true) {
				try {
					await vscode.workspace.fs.stat(uri);
					throw new Error(`File already exists: ${uri.toString()}`);
				} catch (err) {
					if (err instanceof Error && err.message.startsWith('File already exists')) { throw err; }
					// stat failed → file doesn't exist → fine, fall through to write
				}
			}
			await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
			return { written: uri.toString(), bytes: Buffer.byteLength(content, 'utf8') };
		},
	};
}

function diagnosticsGetTool(): McpToolDefinition {
	return {
		name: 'diagnostics.get',
		description: 'Return current problems (errors, warnings, info) for a file, or the whole workspace if no path is given.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Optional file path/URI to scope to.' },
				severity: { type: 'string', enum: ['error', 'warning', 'info', 'hint'], description: 'Minimum severity to include.' },
			},
			additionalProperties: false,
		},
		handler: async args => {
			const severityOrder: Record<string, number> = { error: 0, warning: 1, info: 2, hint: 3 };
			const minSeverity = typeof args.severity === 'string' ? severityOrder[args.severity] ?? 3 : 3;
			const severityName = (s: vscode.DiagnosticSeverity): string => ({
				[vscode.DiagnosticSeverity.Error]: 'error',
				[vscode.DiagnosticSeverity.Warning]: 'warning',
				[vscode.DiagnosticSeverity.Information]: 'info',
				[vscode.DiagnosticSeverity.Hint]: 'hint',
			}[s] ?? 'info');
			const formatDiag = (d: vscode.Diagnostic) => ({
				severity: severityName(d.severity),
				message: d.message,
				source: d.source,
				code: typeof d.code === 'object' && d.code ? d.code.value : d.code,
				startLine: d.range.start.line + 1,
				startColumn: d.range.start.character + 1,
				endLine: d.range.end.line + 1,
				endColumn: d.range.end.character + 1,
			});
			if (typeof args.path === 'string' && args.path.length > 0) {
				const uri = resolvePathUri(args.path);
				const diags = vscode.languages.getDiagnostics(uri)
					.filter(d => d.severity <= minSeverity);
				return { uri: uri.toString(), diagnostics: diags.map(formatDiag) };
			}
			const all = vscode.languages.getDiagnostics();
			const files = all
				.map(([uri, diags]) => ({
					uri: uri.toString(),
					path: uri.fsPath,
					diagnostics: diags.filter(d => d.severity <= minSeverity).map(formatDiag),
				}))
				.filter(f => f.diagnostics.length > 0);
			return { files };
		},
	};
}

function commandExecuteTool(): McpToolDefinition {
	return {
		name: 'command.execute',
		description: 'Run any othcloud terminal command (e.g. "workbench.action.files.save", "editor.action.formatDocument"). Use vscode.commands.getCommands to discover IDs. Result is JSON-serialized when present.',
		inputSchema: {
			type: 'object',
			properties: {
				command: { type: 'string', description: 'Command id.' },
				args: { type: 'array', items: {}, description: 'Optional positional arguments.' },
			},
			required: ['command'],
			additionalProperties: false,
		},
		handler: async args => {
			const command = String(args.command ?? '');
			if (!command) { throw new Error('A command id is required.'); }
			const argv = Array.isArray(args.args) ? args.args as unknown[] : [];
			const result = await vscode.commands.executeCommand(command, ...argv);
			return { command, result };
		},
	};
}

function notificationShowTool(): McpToolDefinition {
	return {
		name: 'notification.show',
		description: 'Show a toast notification to the user. Optional buttons return the label the user picked, or null if dismissed.',
		inputSchema: {
			type: 'object',
			properties: {
				message: { type: 'string', description: 'Notification text.' },
				level: { type: 'string', enum: ['info', 'warning', 'error'], description: 'Default "info".' },
				buttons: { type: 'array', items: { type: 'string' }, description: 'Up to 3 button labels. Returns the chosen label.' },
				modal: { type: 'boolean', description: 'Show as a blocking modal dialog. Default false.' },
			},
			required: ['message'],
			additionalProperties: false,
		},
		handler: async args => {
			const message = String(args.message ?? '');
			if (!message) { throw new Error('A message is required.'); }
			const level = String(args.level ?? 'info');
			const buttons = Array.isArray(args.buttons) ? (args.buttons as unknown[]).map(String).slice(0, 3) : [];
			const opts: vscode.MessageOptions = { modal: args.modal === true };
			let picked: string | undefined;
			if (level === 'error') {
				picked = await vscode.window.showErrorMessage(message, opts, ...buttons);
			} else if (level === 'warning') {
				picked = await vscode.window.showWarningMessage(message, opts, ...buttons);
			} else {
				picked = await vscode.window.showInformationMessage(message, opts, ...buttons);
			}
			return { shown: true, picked: picked ?? null };
		},
	};
}
