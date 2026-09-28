/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as http from 'http';
import * as vscode from 'vscode';
import { JsonRpcRequest, JsonRpcResponse, RpcError, RpcErrorCode, makeError, makeSuccess } from './rpc';
import { safeEquals } from './secret';

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export interface McpToolHandler {
	(args: Record<string, unknown>, cancel: vscode.CancellationToken): Promise<unknown>;
}

export interface McpToolDefinition {
	name: string;
	description: string;
	inputSchema: {
		type: 'object';
		properties: Record<string, unknown>;
		required?: string[];
		additionalProperties?: boolean;
	};
	handler: McpToolHandler;
}

interface Session {
	id: string;
	res: http.ServerResponse;
	cancel: vscode.CancellationTokenSource;
}

interface ServerOptions {
	host: string;
	port: number;
	token: string;
	allowedOrigins: ReadonlySet<string>;
	tools: ReadonlyMap<string, McpToolDefinition>;
	serverName: string;
	serverVersion: string;
	output: vscode.OutputChannel;
}

export interface RunningServer {
	address: string;
	port: number;
	close(): Promise<void>;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
	const sessions = new Map<string, Session>();
	const server = http.createServer((req, res) => {
		void handleRequest(req, res, opts, sessions).catch(err => {
			opts.output.appendLine(`[mcp] unhandled error: ${err?.stack ?? err}`);
			if (!res.headersSent) {
				res.writeHead(500, { 'Content-Type': 'text/plain' });
				res.end('Internal Server Error');
			}
		});
	});

	server.on('clientError', (_err, socket) => {
		try { socket.destroy(); } catch { /* ignore */ }
	});

	await new Promise<void>((resolve, reject) => {
		const onErr = (err: Error) => { server.off('listening', onOk); reject(err); };
		const onOk = () => { server.off('error', onErr); resolve(); };
		server.once('error', onErr);
		server.once('listening', onOk);
		server.listen(opts.port, opts.host);
	});

	const addr = server.address();
	if (!addr || typeof addr === 'string') {
		throw new Error('failed to read server address');
	}
	const port = addr.port;
	const address = `http://${opts.host}:${port}`;
	opts.output.appendLine(`[mcp] listening on ${address}`);

	return {
		address,
		port,
		close: () => new Promise<void>(resolve => {
			for (const s of sessions.values()) {
				try { s.cancel.cancel(); s.cancel.dispose(); s.res.end(); } catch { /* ignore */ }
			}
			sessions.clear();
			server.close(() => resolve());
		}),
	};
}

function isLoopbackHost(host: string): boolean {
	if (!host) { return false; }
	// Strip optional port. Host header for IPv6 looks like [::1]:1234.
	const stripped = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
	return stripped === '127.0.0.1' || stripped === 'localhost' || stripped === '::1';
}

function originAllowed(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
	if (!origin) {
		// Many MCP clients (including Claude Code) don't send an Origin header.
		// We rely on Authorization + loopback bind for trust in that case.
		return true;
	}
	if (allowed.has(origin)) { return true; }
	try {
		const u = new URL(origin);
		if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]' || u.hostname === '::1') {
			return true;
		}
	} catch {
		return false;
	}
	return false;
}

function authorized(req: http.IncomingMessage, token: string): boolean {
	const header = req.headers['authorization'];
	if (!header || typeof header !== 'string') { return false; }
	const m = /^Bearer\s+(.+)$/i.exec(header.trim());
	if (!m) { return false; }
	return safeEquals(m[1].trim(), token);
}

async function handleRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	opts: ServerOptions,
	sessions: Map<string, Session>,
): Promise<void> {
	const hostHeader = (req.headers.host ?? '').toString();
	if (!isLoopbackHost(hostHeader)) {
		res.writeHead(421, { 'Content-Type': 'text/plain' });
		res.end('Misdirected Request');
		return;
	}
	if (!originAllowed(req.headers.origin as string | undefined, opts.allowedOrigins)) {
		res.writeHead(403, { 'Content-Type': 'text/plain' });
		res.end('Forbidden origin');
		return;
	}

	const url = new URL(req.url ?? '/', `http://${hostHeader}`);

	if (req.method === 'GET' && url.pathname === '/sse') {
		if (!authorized(req, opts.token)) {
			res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="othcloud-mcp"' });
			res.end();
			return;
		}
		openSseSession(req, res, opts, sessions);
		return;
	}

	if (req.method === 'POST' && url.pathname === '/messages') {
		if (!authorized(req, opts.token)) {
			res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="othcloud-mcp"' });
			res.end();
			return;
		}
		await handleMessage(req, res, url, opts, sessions);
		return;
	}

	if (req.method === 'GET' && url.pathname === '/healthz') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ ok: true, name: opts.serverName, version: opts.serverVersion }));
		return;
	}

	res.writeHead(404, { 'Content-Type': 'text/plain' });
	res.end('Not Found');
}

function openSseSession(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	opts: ServerOptions,
	sessions: Map<string, Session>,
): void {
	const id = crypto.randomUUID();
	const cancel = new vscode.CancellationTokenSource();
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache, no-transform',
		'Connection': 'keep-alive',
		'X-Accel-Buffering': 'no',
	});
	// Per the MCP SSE transport, the first event tells the client where to POST.
	const endpoint = `/messages?sessionId=${encodeURIComponent(id)}`;
	res.write(`event: endpoint\ndata: ${endpoint}\n\n`);

	const session: Session = { id, res, cancel };
	sessions.set(id, session);
	opts.output.appendLine(`[mcp] session opened: ${id}`);

	const keepAlive = setInterval(() => {
		try { res.write(`: keep-alive ${Date.now()}\n\n`); } catch { /* ignore */ }
	}, 25000);

	const cleanup = () => {
		clearInterval(keepAlive);
		if (sessions.get(id) === session) {
			sessions.delete(id);
		}
		try { cancel.cancel(); cancel.dispose(); } catch { /* ignore */ }
		opts.output.appendLine(`[mcp] session closed: ${id}`);
	};
	req.on('close', cleanup);
	req.on('end', cleanup);
}

async function handleMessage(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	url: URL,
	opts: ServerOptions,
	sessions: Map<string, Session>,
): Promise<void> {
	const sessionId = url.searchParams.get('sessionId');
	if (!sessionId || !sessions.has(sessionId)) {
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		res.end('Unknown session');
		return;
	}

	const body = await readBody(req, 1024 * 1024);
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		res.writeHead(400, { 'Content-Type': 'text/plain' });
		res.end('Invalid JSON');
		return;
	}
	// Acknowledge the POST; the real response is delivered over the SSE stream.
	res.writeHead(202, { 'Content-Type': 'text/plain' });
	res.end('Accepted');

	const session = sessions.get(sessionId);
	if (!session) { return; }

	const messages = Array.isArray(parsed) ? parsed : [parsed];
	for (const msg of messages) {
		void dispatch(msg as JsonRpcRequest, session, opts).catch(err => {
			opts.output.appendLine(`[mcp] dispatch error: ${err?.stack ?? err}`);
		});
	}
}

async function dispatch(req: JsonRpcRequest, session: Session, opts: ServerOptions): Promise<void> {
	const isNotification = req.id === undefined || req.id === null;
	const id = req.id ?? null;

	try {
		if (typeof req.method !== 'string') {
			throw new RpcError(RpcErrorCode.InvalidRequest, 'method is required');
		}
		const result = await route(req.method, req.params, session, opts);
		if (!isNotification) {
			sendEvent(session, makeSuccess(id, result));
		}
	} catch (err) {
		if (isNotification) { return; }
		if (err instanceof RpcError) {
			sendEvent(session, makeError(id, err.code, err.message, err.data));
		} else {
			const message = err instanceof Error ? err.message : String(err);
			sendEvent(session, makeError(id, RpcErrorCode.InternalError, message));
		}
	}
}

async function route(method: string, params: unknown, session: Session, opts: ServerOptions): Promise<unknown> {
	switch (method) {
		case 'initialize':
			return {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: opts.serverName, version: opts.serverVersion },
			};
		case 'notifications/initialized':
		case 'notifications/cancelled':
		case 'ping':
			return {};
		case 'tools/list':
			return {
				tools: Array.from(opts.tools.values()).map(t => ({
					name: t.name,
					description: t.description,
					inputSchema: t.inputSchema,
				})),
			};
		case 'tools/call': {
			const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
			if (typeof p.name !== 'string') {
				throw new RpcError(RpcErrorCode.InvalidParams, 'tools/call requires a name string');
			}
			const tool = opts.tools.get(p.name);
			if (!tool) {
				throw new RpcError(RpcErrorCode.MethodNotFound, `Unknown tool: ${p.name}`);
			}
			const args = (p.arguments && typeof p.arguments === 'object' ? p.arguments : {}) as Record<string, unknown>;
			try {
				const result = await tool.handler(args, session.cancel.token);
				return toToolResult(result);
			} catch (err) {
				return {
					content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
					isError: true,
				};
			}
		}
		default:
			throw new RpcError(RpcErrorCode.MethodNotFound, `Unknown method: ${method}`);
	}
}

function toToolResult(value: unknown): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
	if (value && typeof value === 'object' && Array.isArray((value as { content?: unknown }).content)) {
		return value as { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
	}
	const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
	return { content: [{ type: 'text', text }] };
}

function sendEvent(session: Session, message: JsonRpcResponse): void {
	try {
		session.res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
	} catch {
		// session likely closed; ignore
	}
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error('Body too large'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}
