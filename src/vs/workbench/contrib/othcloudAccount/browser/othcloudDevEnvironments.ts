/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IOthcloudAccountService } from '../common/othcloudAccountService.js';
import { getOthcloudBaseUrl, IOthcloudDevEnvConnection, IOthcloudDevEnvStatus, OthcloudAccountApiError, OthcloudAccountClient } from './othcloudAccountClient.js';

/**
 * Dev environments opened as remote windows.
 *
 * An OTHCloud application can run a dev environment: a container on its server
 * running this editor's server build on the application's workspace. The web
 * dashboard shows it in an iframe; here it opens as a real remote window, the
 * way VS Code's own remotes do. The pieces:
 *
 * - othcloud.xyz starts and stops the environment and, for a running one, hands
 *   out its connection token plus a short-lived ticket for its editor socket
 *   (`/api/desktop/dev-environments/<id>/*`).
 * - The built-in `othcloud-remote` extension resolves `othcloud-dev+<id>`
 *   authorities: it asks {@link RESOLVE_CONNECTION_COMMAND} for those details
 *   and opens the socket through othcloud.xyz's `/_editor/<id>/` proxy.
 * - The commands below are what the OTHCloud panel calls.
 */

export const DEV_ENV_AUTHORITY_PREFIX = 'othcloud-dev';
/** Internal: the resolver extension's way in. Not in the command palette. */
export const RESOLVE_CONNECTION_COMMAND = '_othcloud.devEnvironment.resolveConnection';
export const OPEN_REMOTE_COMMAND = 'othcloud.devEnvironment.openRemote';
export const START_COMMAND = 'othcloud.devEnvironment.start';
export const STOP_COMMAND = 'othcloud.devEnvironment.stop';

export function devEnvRemoteAuthority(applicationId: string): string {
	return `${DEV_ENV_AUTHORITY_PREFIX}+${applicationId}`;
}

/** What the resolver extension gets back from {@link RESOLVE_CONNECTION_COMMAND}. */
export interface IDevEnvResolvedConnection extends IOthcloudDevEnvConnection {
	/** Origin of othcloud.xyz, e.g. `https://othcloud.xyz`; `path` is relative to it. */
	readonly baseUrl: string;
}

class DevEnvError extends Error { }
/** The user said no to a prompt; nothing to report. */
class CancelledDevEnv extends Error { }

/**
 * The release the environment has to run for this window to connect, or
 * `undefined` when any will do. A built client refuses a remote server built
 * from another commit; a dev build has no commit and connects to anything.
 */
function requiredVersion(productService: IProductService): string | undefined {
	return productService.commit ? productService.version : undefined;
}

async function tokenOrThrow(accountService: IOthcloudAccountService): Promise<string> {
	const token = await accountService.getToken();
	if (!token) {
		throw new DevEnvError(localize('othcloud.devEnv.signIn', "Sign in to OTHCloud to open dev environments."));
	}
	return token;
}

function describe(err: unknown): string {
	if (err instanceof DevEnvError) {
		return err.message;
	}
	if (err instanceof OthcloudAccountApiError) {
		if (err.status === 401) {
			return localize('othcloud.devEnv.signedOut', "Your OTHCloud sign-in has expired. Sign in again and retry.");
		}
		if (err.status === 403) {
			return localize('othcloud.devEnv.forbidden', "You don't have access to this application's dev environment.");
		}
		if (err.status === 404) {
			return localize('othcloud.devEnv.notFound', "This application no longer exists on OTHCloud, or this version of othcloud.xyz doesn't support remote editing yet.");
		}
		return localize('othcloud.devEnv.apiError', "OTHCloud couldn't do that ({0}).", err.message);
	}
	if (err instanceof TypeError) {
		return localize('othcloud.devEnv.unreachable', "Can't reach OTHCloud. Check your connection and try again.");
	}
	return String((err as Error)?.message ?? err);
}

/**
 * Makes sure the environment is running on a release this window can connect
 * to, starting it if needed.
 *
 * When it is already running on another release, restarting it would drop
 * anyone using it in the browser, so an interactive caller asks first; the
 * resolver (which has no good way to ask mid-connect) fails with an
 * explanation instead.
 */
async function ensureRunning(accessor: ServicesAccessor, applicationId: string, name: string | undefined, interactive: boolean): Promise<void> {
	const accountService = accessor.get(IOthcloudAccountService);
	const productService = accessor.get(IProductService);
	const progressService = accessor.get(IProgressService);
	const dialogService = accessor.get(IDialogService);

	const token = await tokenOrThrow(accountService);
	const version = requiredVersion(productService);
	const label = name ?? applicationId;

	const status = await OthcloudAccountClient.devEnvironmentStatus(token, applicationId);
	if (status.state === 'unavailable') {
		throw new DevEnvError(status.reason);
	}

	let recreate = false;
	if (status.state === 'running') {
		if (!version || !status.version || status.version === version) {
			return;
		}
		if (!interactive) {
			throw new DevEnvError(localize('othcloud.devEnv.versionMismatch',
				"The dev environment runs OTerminal {0}, but this is {1}. Open it from the OTHCloud panel to restart it on your version.", status.version, version));
		}
		const { confirmed } = await dialogService.confirm({
			message: localize('othcloud.devEnv.restartTitle', "Restart {0}'s dev environment?", label),
			detail: localize('othcloud.devEnv.restartDetail',
				"It is running OTerminal {0} and this is {1}, and a remote window needs both to match. Restarting disconnects anyone using it in the browser. Your files are kept.", status.version, version),
			primaryButton: localize({ key: 'othcloud.devEnv.restart', comment: ['&& denotes a mnemonic'] }, "&&Restart"),
		});
		if (!confirmed) {
			throw new CancelledDevEnv();
		}
		recreate = true;
	}

	const started = await progressService.withProgress({
		location: ProgressLocation.Notification,
		title: recreate
			? localize('othcloud.devEnv.restarting', "Restarting {0}'s dev environment...", label)
			: localize('othcloud.devEnv.starting', "Starting {0}'s dev environment...", label),
	}, () => OthcloudAccountClient.startDevEnvironment(token, applicationId, { version, recreate }));

	if (started.state === 'unavailable') {
		throw new DevEnvError(started.reason);
	}
	if (started.state !== 'running') {
		throw new DevEnvError(localize('othcloud.devEnv.didNotStart', "The dev environment didn't start. Try again, or open it on othcloud.xyz to see why."));
	}
}


CommandsRegistry.registerCommand(RESOLVE_CONNECTION_COMMAND, async (accessor, applicationId: unknown): Promise<IDevEnvResolvedConnection> => {
	if (typeof applicationId !== 'string' || !applicationId) {
		throw new Error('applicationId required');
	}
	const accountService = accessor.get(IOthcloudAccountService);
	try {
		await ensureRunning(accessor, applicationId, undefined, false);
		const token = await tokenOrThrow(accountService);
		const connection = await OthcloudAccountClient.connectDevEnvironment(token, applicationId);
		return { ...connection, baseUrl: getOthcloudBaseUrl() };
	} catch (err) {
		throw new Error(describe(err));
	}
});

CommandsRegistry.registerCommand(OPEN_REMOTE_COMMAND, async (accessor, applicationId: unknown, name?: unknown): Promise<void> => {
	if (typeof applicationId !== 'string' || !applicationId) {
		return;
	}
	const hostService = accessor.get(IHostService);
	const notificationService = accessor.get(INotificationService);
	try {
		await ensureRunning(accessor, applicationId, typeof name === 'string' ? name : undefined, true);
	} catch (err) {
		if (!(err instanceof CancelledDevEnv)) {
			notificationService.error(describe(err));
		}
		return;
	}
	const folderUri = URI.from({ scheme: Schemas.vscodeRemote, authority: devEnvRemoteAuthority(applicationId), path: '/workspace' });
	await hostService.openWindow([{ folderUri }], { forceNewWindow: true });
});

CommandsRegistry.registerCommand(START_COMMAND, async (accessor, applicationId: unknown, name?: unknown): Promise<IOthcloudDevEnvStatus | undefined> => {
	if (typeof applicationId !== 'string' || !applicationId) {
		return undefined;
	}
	const accountService = accessor.get(IOthcloudAccountService);
	const notificationService = accessor.get(INotificationService);
	try {
		await ensureRunning(accessor, applicationId, typeof name === 'string' ? name : undefined, true);
		return await OthcloudAccountClient.devEnvironmentStatus(await tokenOrThrow(accountService), applicationId);
	} catch (err) {
		if (!(err instanceof CancelledDevEnv)) {
			notificationService.error(describe(err));
		}
		return undefined;
	}
});

CommandsRegistry.registerCommand(STOP_COMMAND, async (accessor, applicationId: unknown, name?: unknown): Promise<boolean> => {
	if (typeof applicationId !== 'string' || !applicationId) {
		return false;
	}
	const accountService = accessor.get(IOthcloudAccountService);
	const dialogService = accessor.get(IDialogService);
	const notificationService = accessor.get(INotificationService);
	const label = typeof name === 'string' ? name : applicationId;
	const { confirmed } = await dialogService.confirm({
		message: localize('othcloud.devEnv.stopTitle', "Stop {0}'s dev environment?", label),
		detail: localize('othcloud.devEnv.stopDetail', "Anyone connected to it, here or in the browser, is disconnected. Your files are kept."),
		primaryButton: localize({ key: 'othcloud.devEnv.stop', comment: ['&& denotes a mnemonic'] }, "&&Stop"),
	});
	if (!confirmed) {
		return false;
	}
	try {
		await OthcloudAccountClient.stopDevEnvironment(await tokenOrThrow(accountService), applicationId);
		return true;
	} catch (err) {
		notificationService.error(describe(err));
		return false;
	}
});
