/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { posix } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { createFileSystemProviderError, FileChangeType, FileSystemProviderCapabilities, FileSystemProviderErrorCode, FileType, IFileChange, IFileDeleteOptions, IFileOverwriteOptions, IFileService, IFileSystemProviderWithFileReadWriteCapability, IFileWriteOptions, IStat, IWatchOptions } from '../../../../platform/files/common/files.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IOthcloudAccountService } from '../common/othcloudAccountService.js';
import { IOthcloudGameFileEntry, OthcloudAccountApiError, OthcloudAccountClient, OthcloudGameFileOp } from './othcloudAccountClient.js';

/**
 * A game server's files as a file system: `othcloud-game://<composeId>/<path>`.
 *
 * Backed by `/api/desktop/game-servers/<id>/files`, which drives the game's
 * node agent the same way the dashboard's Files tab does. Registering it as a
 * real provider means a game's files open in normal editor tabs, with syntax
 * highlighting, search and save, instead of a bespoke editor.
 *
 * Text only for now: the agent's read endpoint returns text, so binary files
 * (worlds, jars, images) are not safe to open or save through here.
 */
export const OTHCLOUD_GAME_FILES_SCHEME = 'othcloud-game';

export function gameFileUri(composeId: string, path: string): URI {
	return URI.from({ scheme: OTHCLOUD_GAME_FILES_SCHEME, authority: composeId, path: path.startsWith('/') ? path : '/' + path });
}

export class OthcloudGameFileSystemProvider extends Disposable implements IFileSystemProviderWithFileReadWriteCapability {

	readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;
	readonly onDidChangeCapabilities = Event.None;

	private readonly _onDidChangeFile = this._register(new Emitter<readonly IFileChange[]>());
	readonly onDidChangeFile = this._onDidChangeFile.event;

	private readonly encoder = new TextEncoder();
	private readonly decoder = new TextDecoder();

	constructor(private readonly accountService: IOthcloudAccountService) {
		super();
	}

	watch(_resource: URI, _opts: IWatchOptions): IDisposable {
		return Disposable.None; // the agent has no change feed; the Files tab refreshes on demand
	}

	async stat(resource: URI): Promise<IStat> {
		if (resource.path === '/' || resource.path === '') {
			return { type: FileType.Directory, ctime: 0, mtime: 0, size: 0 };
		}
		const parent = posix.dirname(resource.path);
		const name = posix.basename(resource.path);
		const entry = (await this.list(resource.authority, parent)).find(e => e.name === name);
		if (!entry) {
			throw createFileSystemProviderError(localize('othcloud.gameFiles.notFound', "{0} not found", resource.path), FileSystemProviderErrorCode.FileNotFound);
		}
		const mtime = Date.parse(entry.modified) || 0;
		return {
			type: entry.directory ? FileType.Directory : FileType.File,
			ctime: mtime,
			mtime,
			size: entry.size,
		};
	}

	async readdir(resource: URI): Promise<[string, FileType][]> {
		const entries = await this.list(resource.authority, resource.path || '/');
		return entries.map(e => [e.name, e.directory ? FileType.Directory : FileType.File]);
	}

	async readFile(resource: URI): Promise<Uint8Array> {
		const { content } = await this.call<{ content: string }>(resource.authority, { op: 'read', path: resource.path });
		return this.encoder.encode(content ?? '');
	}

	async writeFile(resource: URI, content: Uint8Array, _opts: IFileWriteOptions): Promise<void> {
		await this.call(resource.authority, { op: 'write', path: resource.path, content: this.decoder.decode(content) });
		this._onDidChangeFile.fire([{ type: FileChangeType.UPDATED, resource }]);
	}

	async mkdir(resource: URI): Promise<void> {
		await this.call(resource.authority, { op: 'mkdir', root: posix.dirname(resource.path), name: posix.basename(resource.path) });
		this._onDidChangeFile.fire([{ type: FileChangeType.ADDED, resource }]);
	}

	async delete(resource: URI, _opts: IFileDeleteOptions): Promise<void> {
		await this.call(resource.authority, { op: 'delete', root: posix.dirname(resource.path), name: posix.basename(resource.path) });
		this._onDidChangeFile.fire([{ type: FileChangeType.DELETED, resource }]);
	}

	async rename(from: URI, to: URI, _opts: IFileOverwriteOptions): Promise<void> {
		if (from.authority !== to.authority) {
			throw createFileSystemProviderError(localize('othcloud.gameFiles.crossServer', "Files can't be moved between servers"), FileSystemProviderErrorCode.NoPermissions);
		}
		// The agent renames relative to a root; paths from the root keep this general
		await this.call(from.authority, { op: 'rename', root: '/', from: from.path.slice(1), to: to.path.slice(1) });
		this._onDidChangeFile.fire([{ type: FileChangeType.DELETED, resource: from }, { type: FileChangeType.ADDED, resource: to }]);
	}

	private list(composeId: string, path: string): Promise<IOthcloudGameFileEntry[]> {
		return this.call<IOthcloudGameFileEntry[]>(composeId, { op: 'list', path: path || '/' });
	}

	private async call<T>(composeId: string, op: OthcloudGameFileOp): Promise<T> {
		const token = await this.accountService.getToken();
		if (!token) {
			throw createFileSystemProviderError(localize('othcloud.gameFiles.signIn', "Sign in to OTHCloud to open this server's files"), FileSystemProviderErrorCode.NoPermissions);
		}
		try {
			return await OthcloudAccountClient.gameServerFiles<T>(token, composeId, op);
		} catch (err) {
			if (err instanceof OthcloudAccountApiError) {
				const code = err.status === 404 ? FileSystemProviderErrorCode.FileNotFound
					: err.status === 403 || err.status === 401 ? FileSystemProviderErrorCode.NoPermissions
						: FileSystemProviderErrorCode.Unknown;
				throw createFileSystemProviderError(err.message, code);
			}
			throw createFileSystemProviderError(localize('othcloud.gameFiles.unreachable', "Can't reach OTHCloud"), FileSystemProviderErrorCode.Unavailable);
		}
	}
}

export class OthcloudGameFileSystemContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.othcloudGameFileSystem';

	constructor(
		@IFileService fileService: IFileService,
		@IOthcloudAccountService accountService: IOthcloudAccountService,
	) {
		super();
		const provider = this._register(new OthcloudGameFileSystemProvider(accountService));
		this._register(fileService.registerProvider(OTHCLOUD_GAME_FILES_SCHEME, provider));
	}
}
