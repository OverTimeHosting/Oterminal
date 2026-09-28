/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as net from 'net';
import * as tls from 'tls';
import * as vscode from 'vscode';

/**
 * Resolves `othcloud-dev+<applicationId>` remote authorities: OTHCloud dev
 * environments opened as remote windows.
 *
 * A dev environment runs this editor's server build in a container on the
 * application's server, reachable only through othcloud.xyz's `/_editor/<id>/`
 * proxy. The workbench (`othcloudDevEnvironments.ts`) makes sure it is running
 * and hands over the proxy path, the server's connection token and a
 * short-lived ticket for that socket. This extension opens the socket and gives
 * VS Code a raw byte stream (a managed authority):
 *
 * - VS Code writes a WebSocket upgrade request (`GET ws://localhost/?...&skipWebSocketFrames=true`)
 *   into the stream. It is replaced with one addressed to the proxy path and
 *   carrying the ticket, keeping VS Code's query (its reconnection token and
 *   the request to skip WebSocket framing).
 * - The proxy authenticates it, swaps in the server's cookie and relays the
 *   upgrade to the editor server, which answers `101` and from then on speaks
 *   the remote protocol directly. Anything other than `101` fails the attempt.
 *
 * Each connection (and each reconnection) asks for a fresh ticket, since a
 * ticket only lives a few minutes.
 */

const AUTHORITY_PREFIX = 'othcloud-dev';
const RESOLVE_CONNECTION_COMMAND = '_othcloud.devEnvironment.resolveConnection';
const HEADER_END = Buffer.from('\r\n\r\n');

interface IDevEnvConnection {
	readonly baseUrl: string;
	readonly path: string;
	readonly connectionToken: string;
	readonly ticket: string;
}

let log: vscode.LogOutputChannel;

export function activate(context: vscode.ExtensionContext): void {
	log = vscode.window.createOutputChannel(vscode.l10n.t('OTHCloud Remote'), { log: true });
	context.subscriptions.push(log);

	context.subscriptions.push(vscode.workspace.registerRemoteAuthorityResolver(AUTHORITY_PREFIX, {
		async resolve(authority: string): Promise<vscode.ResolverResult> {
			const applicationId = authority.slice(AUTHORITY_PREFIX.length + 1);
			log.info(`Resolving dev environment ${applicationId}`);

			let pending: IDevEnvConnection | undefined = await fetchConnection(applicationId);
			const connectionToken = pending.connectionToken;
			return new vscode.ManagedResolvedAuthority(async () => {
				// The first connection uses the details fetched while resolving; every
				// later one (the extension host, reconnects) gets a fresh ticket.
				const connection = pending ?? await fetchConnection(applicationId);
				pending = undefined;
				return openConnection(connection);
			}, connectionToken);
		},
	}));
}

async function fetchConnection(applicationId: string): Promise<IDevEnvConnection> {
	try {
		const connection = await vscode.commands.executeCommand<IDevEnvConnection>(RESOLVE_CONNECTION_COMMAND, applicationId);
		if (!connection?.path || !connection.ticket) {
			throw new Error(vscode.l10n.t('OTHCloud did not return connection details.'));
		}
		return connection;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log.error(`Could not get connection details for ${applicationId}: ${message}`);
		throw vscode.RemoteAuthorityResolverError.NotAvailable(message);
	}
}

async function openConnection(connection: IDevEnvConnection): Promise<vscode.ManagedMessagePassing> {
	const url = new URL(connection.path, connection.baseUrl);
	const secure = url.protocol === 'https:';
	const port = Number(url.port) || (secure ? 443 : 80);

	const socket: net.Socket = secure
		? tls.connect({ host: url.hostname, port, servername: url.hostname, ALPNProtocols: ['http/1.1'] })
		: net.connect({ host: url.hostname, port });
	socket.setNoDelay(true);
	socket.setKeepAlive(true, 30_000);

	await new Promise<void>((resolve, reject) => {
		socket.once(secure ? 'secureConnect' : 'connect', () => resolve());
		socket.once('error', reject);
	});
	log.info(`Connected to ${url.host}`);

	const onDidReceiveMessage = new vscode.EventEmitter<Uint8Array>();
	const onDidClose = new vscode.EventEmitter<Error | undefined>();
	const onDidEnd = new vscode.EventEmitter<void>();

	// VS Code -> proxy: rewrite VS Code's upgrade request, then pass bytes through
	let requestBuffer: Buffer | undefined = Buffer.alloc(0);
	const send = (data: Uint8Array) => {
		if (!requestBuffer) {
			socket.write(data);
			return;
		}
		requestBuffer = Buffer.concat([requestBuffer, data]);
		const end = requestBuffer.indexOf(HEADER_END);
		if (end === -1) {
			return;
		}
		const head = requestBuffer.subarray(0, end).toString('latin1');
		const rest = requestBuffer.subarray(end + HEADER_END.length);
		requestBuffer = undefined;
		socket.write(rewriteUpgradeRequest(head, url, connection.ticket));
		if (rest.byteLength) {
			socket.write(rest);
		}
	};

	// proxy -> VS Code: check the upgrade was accepted, then pass bytes through
	let responseBuffer: Buffer | undefined = Buffer.alloc(0);
	socket.on('data', (data: Buffer) => {
		if (!responseBuffer) {
			onDidReceiveMessage.fire(data);
			return;
		}
		responseBuffer = Buffer.concat([responseBuffer, data]);
		const end = responseBuffer.indexOf(HEADER_END);
		if (end === -1) {
			return;
		}
		const statusLine = responseBuffer.subarray(0, responseBuffer.indexOf('\r\n')).toString('latin1');
		if (!/^HTTP\/1\.1 101\b/.test(statusLine)) {
			log.error(`OTHCloud refused the connection: ${statusLine}`);
			responseBuffer = undefined;
			onDidClose.fire(new Error(vscode.l10n.t('OTHCloud refused the connection ({0}).', statusLine)));
			socket.destroy();
			return;
		}
		// VS Code reads (and discards) the response headers itself
		const all = responseBuffer;
		responseBuffer = undefined;
		onDidReceiveMessage.fire(all);
	});

	socket.on('error', err => {
		log.warn(`Connection error: ${err.message}`);
		onDidClose.fire(err);
	});
	socket.on('end', () => onDidEnd.fire());
	socket.on('close', hadError => {
		if (!hadError) {
			onDidClose.fire(undefined);
		}
	});

	return {
		onDidReceiveMessage: onDidReceiveMessage.event,
		onDidClose: onDidClose.event,
		onDidEnd: onDidEnd.event,
		send,
		end: () => socket.end(),
	};
}

/**
 * VS Code's request is `GET ws://localhost/?<query> HTTP/1.1` plus upgrade
 * headers. Keep its query and WebSocket key; address it to the proxy path and
 * add the ticket.
 */
function rewriteUpgradeRequest(head: string, url: URL, ticket: string): string {
	const lines = head.split('\r\n');
	const target = /^GET (\S+) HTTP\/1\.1$/.exec(lines[0])?.[1] ?? '/';
	const query = new URL(target, 'ws://localhost').search;
	const key = lines.find(line => /^sec-websocket-key:/i.test(line))?.split(':')[1]?.trim()
		?? Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))).toString('base64');

	return [
		`GET ${url.pathname}${query} HTTP/1.1`,
		`Host: ${url.host}`,
		'Connection: Upgrade',
		'Upgrade: websocket',
		'Sec-WebSocket-Version: 13',
		`Sec-WebSocket-Key: ${key}`,
		`Authorization: Bearer ${ticket}`,
		'User-Agent: OTerminal-Remote',
		'',
		'',
	].join('\r\n');
}
