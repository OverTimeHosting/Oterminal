/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';

const enum OpCode {
	Handshake = 0,
	Frame = 1,
	Close = 2,
	Ping = 3,
	Pong = 4,
}

interface Activity {
	details?: string;
	state?: string;
	timestamps?: { start?: number; end?: number };
	assets?: {
		large_image?: string;
		large_text?: string;
		small_image?: string;
		small_text?: string;
	};
}

type Status =
	| { kind: 'idle' }
	| { kind: 'connecting'; clientId: string }
	| { kind: 'connected'; clientId: string; since: number }
	| { kind: 'disconnected'; reason: string }
	| { kind: 'disabled' };

class DiscordRpc {
	private socket: net.Socket | undefined;
	private buffer = Buffer.alloc(0);
	private connected = false;

	constructor(private readonly clientId: string) { }

	async connect(): Promise<boolean> {
		for (let id = 0; id < 10; id++) {
			const pipe = this.pipePath(id);
			try {
				await this.tryConnect(pipe);
				return true;
			} catch {
				// try next pipe id
			}
		}
		return false;
	}

	private pipePath(id: number): string {
		if (process.platform === 'win32') {
			return `\\\\?\\pipe\\discord-ipc-${id}`;
		}
		const tmp = process.env['XDG_RUNTIME_DIR']
			|| process.env['TMPDIR']
			|| process.env['TMP']
			|| process.env['TEMP']
			|| '/tmp';
		return path.join(tmp, `discord-ipc-${id}`);
	}

	private tryConnect(pipe: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const socket = net.createConnection(pipe);
			const onError = (err: Error) => {
				socket.removeAllListeners();
				socket.destroy();
				reject(err);
			};
			socket.once('error', onError);
			socket.once('connect', () => {
				socket.removeListener('error', onError);
				this.socket = socket;
				this.connected = true;
				socket.on('data', chunk => this.onData(chunk));
				socket.on('close', () => this.onClose());
				socket.on('error', () => this.onClose());
				this.send(OpCode.Handshake, { v: 1, client_id: this.clientId });
				resolve();
			});
		});
	}

	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (this.buffer.length >= 8) {
			const op = this.buffer.readInt32LE(0);
			const len = this.buffer.readInt32LE(4);
			if (this.buffer.length < 8 + len) {
				break;
			}
			const payload = this.buffer.subarray(8, 8 + len).toString('utf8');
			this.buffer = this.buffer.subarray(8 + len);
			if (op === OpCode.Ping) {
				try {
					this.send(OpCode.Pong, JSON.parse(payload));
				} catch {
					// ignore malformed ping
				}
			}
		}
	}

	private onClose(): void {
		if (this.socket) {
			this.socket.destroy();
			this.socket = undefined;
		}
		this.connected = false;
	}

	private send(op: OpCode, payload: object): void {
		if (!this.socket) {
			return;
		}
		const data = Buffer.from(JSON.stringify(payload));
		const header = Buffer.alloc(8);
		header.writeInt32LE(op, 0);
		header.writeInt32LE(data.length, 4);
		this.socket.write(Buffer.concat([header, data]));
	}

	setActivity(activity: Activity | null): void {
		if (!this.connected) {
			return;
		}
		this.send(OpCode.Frame, {
			cmd: 'SET_ACTIVITY',
			args: {
				pid: process.pid,
				activity: activity ?? undefined,
			},
			nonce: crypto.randomUUID(),
		});
	}

	dispose(): void {
		if (this.connected && this.socket) {
			try {
				this.send(OpCode.Frame, {
					cmd: 'SET_ACTIVITY',
					args: { pid: process.pid },
					nonce: crypto.randomUUID(),
				});
			} catch {
				// best effort clear
			}
		}
		this.onClose();
	}
}

const RECONNECT_DELAY_MS = 20000;
// Hardcoded - the OTHCloud Discord application. Not user-configurable.
const DISCORD_APPLICATION_ID = '1348861044604534835';

let rpc: DiscordRpc | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let sessionStart = Math.floor(Date.now() / 1000);
let outputChannel: vscode.OutputChannel | undefined;
let status: Status = { kind: 'idle' };

function log(message: string): void {
	outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function setStatus(next: Status): void {
	status = next;
	log(`status -> ${describeStatus(next)}`);
}

function describeStatus(s: Status): string {
	switch (s.kind) {
		case 'idle': return 'idle';
		case 'connecting': return `connecting (client_id=${s.clientId})`;
		case 'connected': return `connected (client_id=${s.clientId}, since=${new Date(s.since * 1000).toISOString()})`;
		case 'disconnected': return `disconnected (${s.reason})`;
		case 'disabled': return 'disabled by setting';
	}
}

function getConfig(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('othcloud.discord');
}

/**
 * Tiny template renderer - replaces `{placeholder}` tokens with values, drops
 * empty surrounding separators so a missing placeholder doesn't leave " •  •"
 * gunk in the rendered string.
 */
function render(template: string, values: Record<string, string>): string {
	const filled = template.replace(/\{(\w+)\}/g, (_match, key: string) => values[key] ?? '');
	return filled
		// allow-any-unicode-next-line
		.replace(/\s*[•·\-—]\s*(?=$|\s*[•·\-—])/g, '')  // collapse "X •  • Y" → "X • Y"
		// allow-any-unicode-next-line
		.replace(/^\s*[•·\-—]\s*/, '')                    // leading separator
		// allow-any-unicode-next-line
		.replace(/\s*[•·\-—]\s*$/, '')                    // trailing separator
		.replace(/\s+/g, ' ')
		.trim();
}

function buildActivity(): Activity | null {
	const config = getConfig();
	const appName = config.get<string>('applicationName', 'OTerminal');
	const largeImage = config.get<string>('largeImage', 'othcloud-logo') || undefined;
	const largeImageText = config.get<string>('largeImageText', '') || appName;
	const smallImage = config.get<string>('smallImage', '') || undefined;
	const smallImageText = config.get<string>('smallImageText', '') || undefined;
	const idleText = config.get<string>('idleText', 'Idle');
	const detailsTemplate = config.get<string>('detailsTemplate', 'Editing {file}');
	const stateTemplate = config.get<string>('stateTemplate', 'Workspace: {workspace} • {language}');
	// allow-any-unicode-next-line
	const idleDetailsTemplate = config.get<string>('idleDetailsTemplate', '{app} — {idle}');
	const showFileName = config.get<boolean>('showFileName', true);
	const showWorkspace = config.get<boolean>('showWorkspace', true);

	const editor = vscode.window.activeTextEditor;
	const folders = vscode.workspace.workspaceFolders;
	const workspaceName = (showWorkspace && folders && folders.length > 0) ? folders[0].name : '';
	const fileName = (showFileName && editor) ? (path.basename(editor.document.fileName) || editor.document.uri.path) : '';
	const languageId = editor?.document.languageId ?? '';

	const values: Record<string, string> = {
		file: fileName,
		language: languageId,
		workspace: workspaceName,
		app: appName,
		idle: idleText,
	};

	let details: string;
	let state: string | undefined;

	if (editor) {
		details = render(detailsTemplate, values);
		state = render(stateTemplate, values);
		if (!state) {
			state = undefined;
		}
	} else {
		details = render(idleDetailsTemplate, values);
	}

	// Discord requires `details` to be a non-empty string when set. Fall back
	// to the app name so we never push an invalid activity.
	if (!details) {
		details = appName;
	}

	const assets: NonNullable<Activity['assets']> = {};
	if (largeImage) {
		assets.large_image = largeImage;
		assets.large_text = largeImageText;
	}
	if (smallImage) {
		assets.small_image = smallImage;
		if (smallImageText) {
			assets.small_text = smallImageText;
		}
	}

	return {
		details,
		state,
		timestamps: { start: sessionStart },
		assets: Object.keys(assets).length > 0 ? assets : undefined,
	};
}

function pushPresence(): void {
	if (!rpc) {
		return;
	}
	try {
		rpc.setActivity(buildActivity());
	} catch (err) {
		log(`setActivity failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function scheduleReconnect(): void {
	if (reconnectTimer) {
		return;
	}
	reconnectTimer = setTimeout(() => {
		reconnectTimer = undefined;
		void connect();
	}, RECONNECT_DELAY_MS);
}

async function connect(): Promise<void> {
	disconnect();

	const config = getConfig();
	if (!config.get<boolean>('enabled', true)) {
		setStatus({ kind: 'disabled' });
		log('Disabled via setting; not connecting.');
		return;
	}

	const clientId = DISCORD_APPLICATION_ID;

	setStatus({ kind: 'connecting', clientId });
	const client = new DiscordRpc(clientId);
	rpc = client;
	log(`Connecting to Discord with application id ${clientId}...`);
	const ok = await client.connect();
	if (!ok || rpc !== client) {
		setStatus({ kind: 'disconnected', reason: 'Discord client not running or unreachable' });
		log('Discord client not available. Will retry.');
		if (rpc === client) {
			rpc = undefined;
		}
		scheduleReconnect();
		return;
	}
	sessionStart = Math.floor(Date.now() / 1000);
	setStatus({ kind: 'connected', clientId, since: sessionStart });
	log('Connected to Discord. Pushing initial presence.');
	pushPresence();
}

function disconnect(): void {
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = undefined;
	}
	if (rpc) {
		rpc.dispose();
		rpc = undefined;
	}
}

function showStatusCommand(): void {
	if (outputChannel) {
		outputChannel.show(true);
	}
	void vscode.window.showInformationMessage(`Discord presence: ${describeStatus(status)}`);
}

export function activate(context: vscode.ExtensionContext): void {
	outputChannel = vscode.window.createOutputChannel('OTHCloud Discord Presence');
	context.subscriptions.push(outputChannel);

	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => pushPresence()));
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => pushPresence()));
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('othcloud.discord')) {
			void connect();
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('othcloud.discord.showStatus', () => showStatusCommand()));
	context.subscriptions.push(vscode.commands.registerCommand('othcloud.discord.reconnect', () => void connect()));

	context.subscriptions.push({ dispose: () => disconnect() });

	void connect();
}

export function deactivate(): void {
	disconnect();
	outputChannel?.dispose();
	outputChannel = undefined;
}
