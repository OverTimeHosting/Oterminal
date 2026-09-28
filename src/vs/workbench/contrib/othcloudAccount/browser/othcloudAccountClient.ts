/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { env } from '../../../../base/common/process.js';
import { IOthcloudUser } from '../common/othcloudAccountService.js';

// Pairing contract is documented in PAIRING.md at the repo root.
// Dev builds (`yarn watch` / running out of sources, where `VSCODE_DEV` is set)
// hit the local Next.js dev server; packaged builds talk to production.
const OTHCLOUD_DEV_BASE_URL = 'http://localhost:3001';
const OTHCLOUD_PROD_BASE_URL = 'https://othcloud.xyz';

/**
 * Where othcloud.xyz is, as far as this window is concerned.
 *
 * A guess, and only a guess, until something better-informed overrides it.
 * `env` is empty in the WEB build (`base/common/process` hardcodes `{}` there),
 * so the `VSCODE_DEV` check can only ever land on production - which is the
 * wrong answer for every panel that is not literally othcloud.xyz, including
 * the localhost one this is developed against.
 *
 * The web build gets the right value from the panel: it is served from the
 * panel's own origin, so it is told to use relative URLs and the browser
 * resolves them to whatever host the customer actually reached. See
 * {@link setOthcloudBaseUrl}.
 */
let othcloudBaseUrl = env['VSCODE_DEV']
	// Dev builds only: point at another local panel (or a mock) without editing code.
	? (env['OTHCLOUD_DEV_BASE_URL'] || OTHCLOUD_DEV_BASE_URL)
	: OTHCLOUD_PROD_BASE_URL;

/**
 * Point the client at a different othcloud.xyz.
 *
 * The empty string is meaningful and is what the web editor passes: it makes
 * every request relative, i.e. same-origin with the workbench, which is the
 * panel serving it.
 */
export function setOthcloudBaseUrl(baseUrl: string): void {
	othcloudBaseUrl = baseUrl;
}

export function getOthcloudBaseUrl(): string {
	return othcloudBaseUrl;
}

export interface IPairTokenResponse {
	readonly token: string;
	readonly user: IOthcloudUser;
}

export interface IOthcloudServiceRow {
	readonly id: string;
	readonly name: string;
	readonly status?: string;
	readonly meta?: Readonly<Record<string, string>>;
	/**
	 * Relative path on othcloud.xyz that the desktop sidebar opens when this
	 * row is clicked. The desktop prefixes {@link getOthcloudBaseUrl}. May be
	 * undefined for rows that have no dedicated management page yet.
	 */
	readonly url?: string;
	/** Nested rows shown when this row is expanded in the sidebar. */
	readonly children?: readonly IOthcloudServiceRow[];
}

export interface IOthcloudServices {
	readonly projects: readonly IOthcloudServiceRow[];
	/**
	 * Applications, each of which can run a dev environment that opens as a remote
	 * window. Missing from servers that predate remote editing.
	 */
	readonly applications?: readonly IOthcloudServiceRow[];
	/** Hosted game servers. Missing from servers that predate the Game Servers section. */
	readonly gameServers?: readonly IOthcloudServiceRow[];
}

/** Platform a synced terminal profile applies to; `all` means every OS. */
export type OthcloudTerminalProfilePlatform = 'all' | 'linux' | 'osx' | 'windows';

/**
 * A terminal profile stored on othcloud.xyz for the signed-in user. Mirrors
 * the `desktop_terminal_profile` row; the desktop writes these into
 * `terminal.integrated.profiles.<platform>` so they show up wherever the
 * built-in profiles do (the "+" dropdown, the New Terminal submenu, ...).
 */
export interface IOthcloudTerminalProfile {
	readonly id: string;
	readonly name: string;
	readonly platform: OthcloudTerminalProfilePlatform;
	readonly path: string;
	readonly args?: readonly string[] | null;
	readonly env?: Readonly<Record<string, string | null>> | null;
	/** Codicon id, e.g. `terminal-bash` or `sparkle`. */
	readonly icon?: string | null;
	/** Theme color id, e.g. `terminal.ansiBlue`. */
	readonly color?: string | null;
	readonly updatedAt?: string;
}

export type IOthcloudTerminalProfileInput = Omit<IOthcloudTerminalProfile, 'id' | 'updatedAt'>;

export interface IOthcloudTerminalProfiles {
	readonly profiles: readonly IOthcloudTerminalProfile[];
}

/** A dev environment as `/api/desktop/dev-environments/<id>` reports it. */
export type IOthcloudDevEnvStatus = {
	readonly name: string;
	readonly toolchain: string;
} & (
		| { readonly state: 'running'; readonly version: string | null; readonly installedVersions: readonly string[] }
		| { readonly state: 'stopped'; readonly installedVersions: readonly string[] }
		| { readonly state: 'unavailable'; readonly reason: string }
	);

/** What a remote window needs to reach a running dev environment. */
export interface IOthcloudDevEnvConnection {
	/** Path of the editor socket on othcloud.xyz, e.g. `/_editor/<applicationId>/`. */
	readonly path: string;
	/** The editor server's connection token, sent in the remote handshake. */
	readonly connectionToken: string;
	/** Short-lived bearer for opening that socket and nothing else. */
	readonly ticket: string;
	readonly ticketExpiresAt: string;
	readonly version: string | null;
	/** Folder to open, inside the environment. */
	readonly folder: string;
}

/** A game server as `/api/desktop/game-servers/<id>/details` reports it. */
export interface IOthcloudGameServerDetails {
	readonly name: string;
	readonly gameType: string | null;
	readonly version: string | null;
	readonly address: string | null;
	readonly runtime: 'otwings' | 'pterodactyl' | 'docker';
	/** `running`, `starting`, `stopping`, `offline` or `error`. */
	readonly state: string;
	readonly suspended: { readonly since: string; readonly reason: string | null } | null;
	readonly limits: { readonly memory: string | null; readonly cpu: string | null };
	readonly resources: {
		readonly cpuAbsolute: number;
		readonly memoryBytes: number;
		readonly memoryLimitBytes: number;
		readonly diskBytes: number;
		readonly networkRxBytes: number;
		readonly networkTxBytes: number;
		/** Milliseconds. */
		readonly uptime: number;
	} | null;
	readonly players: { readonly online: number; readonly max: number; readonly names: readonly string[] } | null;
	readonly canManageFiles: boolean;
}

export type OthcloudPowerSignal = 'start' | 'stop' | 'restart' | 'kill';

/** An entry of a game server's file listing. */
export interface IOthcloudGameFileEntry {
	readonly name: string;
	readonly directory: boolean;
	readonly file: boolean;
	readonly symlink: boolean;
	readonly size: number;
	readonly modified: string;
}

export type OthcloudGameFileOp =
	| { op: 'list'; path: string }
	| { op: 'read'; path: string }
	| { op: 'write'; path: string; content: string }
	| { op: 'mkdir'; root: string; name: string }
	| { op: 'delete'; root: string; name: string }
	| { op: 'rename'; root: string; from: string; to: string };

export class OthcloudAccountApiError extends Error {
	constructor(public readonly status: number, message: string) {
		super(message);
		this.name = 'OthcloudAccountApiError';
	}
}

async function requestJson<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, token?: string, body?: unknown): Promise<T> {
	const headers: Record<string, string> = {};
	if (token) {
		headers['Authorization'] = `Bearer ${token}`;
	}
	if (body !== undefined) {
		headers['Content-Type'] = 'application/json';
	}
	const res = await fetch(`${getOthcloudBaseUrl()}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	const parsed = text ? safeJson(text) : undefined;
	if (!res.ok) {
		const message = (parsed && typeof (parsed as { error?: unknown }).error === 'string')
			? (parsed as { error: string }).error
			: `HTTP ${res.status}`;
		throw new OthcloudAccountApiError(res.status, message);
	}
	return parsed as T;
}

function postJson<T>(path: string, body: unknown): Promise<T> {
	return requestJson<T>('POST', path, undefined, body);
}

function getJson<T>(path: string, token: string): Promise<T> {
	return requestJson<T>('GET', path, token);
}

function safeJson(text: string): unknown {
	try { return JSON.parse(text); } catch { return undefined; }
}

export const OthcloudAccountClient = {
	/**
	 * Exchanges a short-lived pairing code (handed over via the
	 * `othcloud-terminal://auth?code=…` deep link) for a long-lived API token
	 * and the signed-in user profile. The code is single-use server-side.
	 */
	async exchangeCode(code: string): Promise<IPairTokenResponse> {
		return postJson<IPairTokenResponse>('/api/desktop/token', { code });
	},

	/**
	 * Re-validates a stored token; if this 401s the caller should sign the
	 * user out and re-prompt via the deep-link flow.
	 */
	async me(token: string): Promise<IOthcloudUser> {
		return getJson<IOthcloudUser>('/api/desktop/me', token);
	},

	/**
	 * Fetches the user's projects and game servers in a single round trip.
	 * Throws {@link OthcloudAccountApiError} on non-2xx; the caller treats
	 * 401 as "token revoked → sign out".
	 */
	async listServices(token: string): Promise<IOthcloudServices> {
		return getJson<IOthcloudServices>('/api/desktop/services', token);
	},

	/**
	 * Terminal profiles the user keeps on othcloud.xyz. Applied to the local
	 * terminal settings by `OthcloudTerminalProfilesContribution`.
	 */
	async listTerminalProfiles(token: string): Promise<IOthcloudTerminalProfiles> {
		return getJson<IOthcloudTerminalProfiles>('/api/desktop/profiles', token);
	},

	/** Creates or replaces (by name + platform) a terminal profile on othcloud.xyz. */
	async saveTerminalProfile(token: string, profile: IOthcloudTerminalProfileInput): Promise<IOthcloudTerminalProfile> {
		return requestJson<IOthcloudTerminalProfile>('POST', '/api/desktop/profiles', token, profile);
	},

	async deleteTerminalProfile(token: string, id: string): Promise<void> {
		await requestJson<unknown>('DELETE', `/api/desktop/profiles/${encodeURIComponent(id)}`, token);
	},

	async devEnvironmentStatus(token: string, applicationId: string): Promise<IOthcloudDevEnvStatus> {
		return getJson<IOthcloudDevEnvStatus>(`/api/desktop/dev-environments/${encodeURIComponent(applicationId)}`, token);
	},

	/** Starts the environment; `version` asks for that OTerminal release (see the endpoint). */
	async startDevEnvironment(token: string, applicationId: string, options: { version?: string; recreate?: boolean }): Promise<IOthcloudDevEnvStatus> {
		return requestJson<IOthcloudDevEnvStatus>('POST', `/api/desktop/dev-environments/${encodeURIComponent(applicationId)}/start`, token, options);
	},

	async stopDevEnvironment(token: string, applicationId: string): Promise<void> {
		await requestJson<unknown>('POST', `/api/desktop/dev-environments/${encodeURIComponent(applicationId)}/stop`, token, {});
	},

	async gameServerDetails(token: string, composeId: string): Promise<IOthcloudGameServerDetails> {
		return getJson<IOthcloudGameServerDetails>(`/api/desktop/game-servers/${encodeURIComponent(composeId)}/details`, token);
	},

	async gameServerPower(token: string, composeId: string, signal: OthcloudPowerSignal): Promise<void> {
		await requestJson<unknown>('POST', `/api/desktop/game-servers/${encodeURIComponent(composeId)}/power`, token, { signal });
	},

	async gameServerConsole(token: string, composeId: string, tail: number): Promise<{ logs: string; found: boolean }> {
		return getJson<{ logs: string; found: boolean }>(`/api/desktop/game-servers/${encodeURIComponent(composeId)}/console?tail=${tail}`, token);
	},

	async gameServerCommand(token: string, composeId: string, command: string): Promise<void> {
		await requestJson<unknown>('POST', `/api/desktop/game-servers/${encodeURIComponent(composeId)}/command`, token, { command });
	},

	async gameServerFiles<T>(token: string, composeId: string, op: OthcloudGameFileOp): Promise<T> {
		return requestJson<T>('POST', `/api/desktop/game-servers/${encodeURIComponent(composeId)}/files`, token, op);
	},

	/** 409 (`not_running`) unless the environment is running. */
	async connectDevEnvironment(token: string, applicationId: string): Promise<IOthcloudDevEnvConnection> {
		return requestJson<IOthcloudDevEnvConnection>('POST', `/api/desktop/dev-environments/${encodeURIComponent(applicationId)}/connect`, token, {});
	},
};
