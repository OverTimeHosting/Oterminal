/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { equals } from '../../../../base/common/objects.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITerminalExecutable, ITerminalProfile, TerminalSettingPrefix } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ITerminalProfileService } from '../../terminal/common/terminal.js';
import { IOthcloudAccountService, OthcloudIsSignedInContext } from '../common/othcloudAccountService.js';
import { IOthcloudTerminalProfile, IOthcloudTerminalProfileInput, OthcloudAccountApiError, OthcloudAccountClient, OthcloudTerminalProfilePlatform } from './othcloudAccountClient.js';

/**
 * Names of the profiles the last sync wrote into the user settings. Kept so a
 * profile removed on othcloud.xyz (or a sign-out) also removes it locally,
 * without ever touching profiles the user defined themselves.
 */
const STORAGE_SYNCED_NAMES_KEY = 'othcloud.terminalProfiles.syncedNames';

export const SYNC_TERMINAL_PROFILES_COMMAND = 'othcloud.terminalProfiles.sync';
export const UPLOAD_TERMINAL_PROFILE_COMMAND = 'othcloud.terminalProfiles.upload';
export const REMOVE_TERMINAL_PROFILE_COMMAND = 'othcloud.terminalProfiles.remove';

const IOthcloudTerminalProfilesSync = createDecorator<IOthcloudTerminalProfilesSync>('othcloudTerminalProfilesSync');

interface IOthcloudTerminalProfilesSync {
	readonly _serviceBrand: undefined;
	/** Fetches the user's profiles from othcloud.xyz and applies them to the terminal settings. */
	sync(): Promise<readonly IOthcloudTerminalProfile[]>;
	/** Profile names (for this platform) written by the last sync. */
	getSyncedNames(): ReadonlySet<string>;
	/** The profiles returned by the last successful fetch, for all platforms. */
	getRemoteProfiles(): readonly IOthcloudTerminalProfile[];
}

/**
 * Keeps the user's othcloud.xyz terminal profiles in the local
 * `terminal.integrated.profiles.<platform>` setting: synced on start-up and
 * whenever the account changes, and cleared again on sign-out.
 */
export class OthcloudTerminalProfilesContribution extends Disposable implements IWorkbenchContribution, IOthcloudTerminalProfilesSync {
	static readonly ID = 'workbench.contrib.othcloudTerminalProfiles';

	declare readonly _serviceBrand: undefined;

	private _remoteProfiles: readonly IOthcloudTerminalProfile[] = [];
	private _pending: Promise<readonly IOthcloudTerminalProfile[]> | undefined;

	constructor(
		@IOthcloudAccountService private readonly _accountService: IOthcloudAccountService,
		@ITerminalProfileService private readonly _terminalProfileService: ITerminalProfileService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IStorageService private readonly _storageService: IStorageService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		OthcloudTerminalProfilesContribution._instance = this;
		this._register(this._accountService.onDidChangeAuth(() => this._onAuthChanged()));
		this._onAuthChanged();
	}

	// The actions below resolve the contribution through this rather than a
	// registered service: it is only ever instantiated once, by the workbench.
	private static _instance: OthcloudTerminalProfilesContribution | undefined;
	static get(): OthcloudTerminalProfilesContribution | undefined {
		return OthcloudTerminalProfilesContribution._instance;
	}

	getRemoteProfiles(): readonly IOthcloudTerminalProfile[] {
		return this._remoteProfiles;
	}

	getSyncedNames(): ReadonlySet<string> {
		return new Set(this._readSyncedNames());
	}

	sync(): Promise<readonly IOthcloudTerminalProfile[]> {
		if (!this._pending) {
			this._pending = this._syncNow().finally(() => { this._pending = undefined; });
		}
		return this._pending;
	}

	private _onAuthChanged(): void {
		if (this._accountService.isSignedIn()) {
			this.sync().catch(err => this._logService.warn('[othcloud] terminal profile sync failed', err));
		} else {
			this._remoteProfiles = [];
			this._apply([]).catch(err => this._logService.warn('[othcloud] clearing synced terminal profiles failed', err));
		}
	}

	private async _syncNow(): Promise<readonly IOthcloudTerminalProfile[]> {
		const token = await this._accountService.getToken();
		if (!token) {
			return [];
		}
		try {
			const { profiles } = await OthcloudAccountClient.listTerminalProfiles(token);
			this._remoteProfiles = profiles;
			await this._apply(profiles);
			return profiles;
		} catch (err) {
			if (err instanceof OthcloudAccountApiError && err.status === 401) {
				void this._accountService.signOut();
				return [];
			}
			throw err;
		}
	}

	/**
	 * Writes the remote profiles for this platform into the user's profile
	 * setting, dropping the ones a previous sync added that are gone now.
	 */
	private async _apply(remote: readonly IOthcloudTerminalProfile[]): Promise<void> {
		const platform = await this._terminalProfileService.getPlatformKey() as OthcloudTerminalProfilePlatform;
		const settingKey = `${TerminalSettingPrefix.Profiles}${platform}`;
		const forPlatform = remote.filter(p => p.platform === 'all' || p.platform === platform);

		const userValue = this._configurationService.inspect<Record<string, unknown>>(settingKey).userValue ?? {};
		const next: Record<string, unknown> = { ...userValue };
		const nextNames = new Set(forPlatform.map(p => p.name));
		for (const name of this._readSyncedNames()) {
			if (!nextNames.has(name)) {
				delete next[name];
			}
		}
		for (const profile of forPlatform) {
			next[profile.name] = toTerminalExecutable(profile);
		}

		if (!equals(next, userValue)) {
			await this._configurationService.updateValue(settingKey, next, ConfigurationTarget.USER);
		}
		this._writeSyncedNames([...nextNames]);
	}

	private _readSyncedNames(): string[] {
		const raw = this._storageService.get(STORAGE_SYNCED_NAMES_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return [];
		}
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : [];
		} catch {
			return [];
		}
	}

	private _writeSyncedNames(names: string[]): void {
		if (names.length === 0) {
			this._storageService.remove(STORAGE_SYNCED_NAMES_KEY, StorageScope.APPLICATION);
		} else {
			this._storageService.store(STORAGE_SYNCED_NAMES_KEY, JSON.stringify(names), StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
	}
}

function toTerminalExecutable(profile: IOthcloudTerminalProfile): ITerminalExecutable {
	const executable: ITerminalExecutable = { path: profile.path };
	if (profile.args && profile.args.length > 0) {
		executable.args = [...profile.args];
	}
	if (profile.env && Object.keys(profile.env).length > 0) {
		executable.env = { ...profile.env };
	}
	if (profile.icon) {
		executable.icon = profile.icon;
	}
	if (profile.color) {
		executable.color = profile.color;
	}
	return executable;
}

function toProfileInput(profile: ITerminalProfile, platform: OthcloudTerminalProfilePlatform): IOthcloudTerminalProfileInput {
	const args = profile.args === undefined ? undefined : (typeof profile.args === 'string' ? [profile.args] : [...profile.args]);
	const env: Record<string, string | null> = {};
	for (const [key, value] of Object.entries(profile.env ?? {})) {
		if (typeof value === 'string' || value === null) {
			env[key] = value;
		}
	}
	return {
		name: profile.profileName,
		platform,
		path: profile.path,
		args: args && args.length > 0 ? args : undefined,
		env: Object.keys(env).length > 0 ? env : undefined,
		icon: ThemeIcon.isThemeIcon(profile.icon) ? profile.icon.id : undefined,
		color: profile.color,
	};
}

const CATEGORY = localize2('othcloud.account.category', 'OTHCloud');

registerAction2(class SyncTerminalProfilesAction extends Action2 {
	constructor() {
		super({
			id: SYNC_TERMINAL_PROFILES_COMMAND,
			title: localize2('othcloud.terminalProfiles.sync', 'Sync Terminal Profiles from OTHCloud'),
			category: CATEGORY,
			icon: Codicon.sync,
			f1: true,
			precondition: OthcloudIsSignedInContext,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const notificationService = accessor.get(INotificationService);
		const sync = OthcloudTerminalProfilesContribution.get();
		if (!sync) {
			return;
		}
		try {
			const profiles = await sync.sync();
			const count = sync.getSyncedNames().size;
			notificationService.info(count === 0
				? localize('othcloud.terminalProfiles.synced.none', "No terminal profiles are stored on OTHCloud for this platform ({0} in total).", profiles.length)
				: localize('othcloud.terminalProfiles.synced', "Synced {0} terminal profile(s) from OTHCloud.", count));
		} catch (err) {
			notificationService.notify({ severity: Severity.Error, message: localize('othcloud.terminalProfiles.syncFailed', "Could not sync terminal profiles from OTHCloud: {0}", String((err as Error).message ?? err)) });
		}
	}
});

registerAction2(class UploadTerminalProfileAction extends Action2 {
	constructor() {
		super({
			id: UPLOAD_TERMINAL_PROFILE_COMMAND,
			title: localize2('othcloud.terminalProfiles.upload', 'Save Terminal Profile to OTHCloud...'),
			category: CATEGORY,
			icon: Codicon.cloudUpload,
			f1: true,
			precondition: OthcloudIsSignedInContext,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);
		const accountService = accessor.get(IOthcloudAccountService);
		const terminalProfileService = accessor.get(ITerminalProfileService);
		const sync = OthcloudTerminalProfilesContribution.get();
		const token = await accountService.getToken();
		if (!sync || !token) {
			return;
		}

		const synced = sync.getSyncedNames();
		const platform = await terminalProfileService.getPlatformKey() as OthcloudTerminalProfilePlatform;
		const candidates = terminalProfileService.availableProfiles.filter(p => !p.isAutoDetected && !synced.has(p.profileName));
		if (candidates.length === 0) {
			notificationService.info(localize('othcloud.terminalProfiles.noLocal', "Every configured terminal profile is already stored on OTHCloud. Add one under `terminal.integrated.profiles.{0}` first.", platform));
			return;
		}

		type Item = IQuickPickItem & { profile: ITerminalProfile };
		const items: Item[] = candidates.map(profile => ({
			label: profile.profileName,
			description: profile.path,
			detail: Array.isArray(profile.args) && profile.args.length > 0 ? profile.args.join(' ') : undefined,
			profile,
		}));
		const picked = await quickInputService.pick(items, {
			placeHolder: localize('othcloud.terminalProfiles.pickLocal', "Select a terminal profile to store on OTHCloud"),
			matchOnDescription: true,
		});
		if (!picked) {
			return;
		}

		const scope = await quickInputService.pick<IQuickPickItem & { platform: OthcloudTerminalProfilePlatform }>([
			{ label: localize('othcloud.terminalProfiles.thisPlatform', "Only this platform ({0})", platform), platform },
			{ label: localize('othcloud.terminalProfiles.allPlatforms', "All platforms"), platform: 'all' },
		], { placeHolder: localize('othcloud.terminalProfiles.pickPlatform', "Where should this profile apply after signing in?") });
		if (!scope) {
			return;
		}

		try {
			await OthcloudAccountClient.saveTerminalProfile(token, toProfileInput(picked.profile, scope.platform));
			await sync.sync();
			notificationService.info(localize('othcloud.terminalProfiles.uploaded', "Saved terminal profile \"{0}\" to OTHCloud.", picked.profile.profileName));
		} catch (err) {
			notificationService.notify({ severity: Severity.Error, message: localize('othcloud.terminalProfiles.uploadFailed', "Could not save the terminal profile to OTHCloud: {0}", String((err as Error).message ?? err)) });
		}
	}
});

registerAction2(class RemoveTerminalProfileAction extends Action2 {
	constructor() {
		super({
			id: REMOVE_TERMINAL_PROFILE_COMMAND,
			title: localize2('othcloud.terminalProfiles.remove', 'Remove Terminal Profile from OTHCloud...'),
			category: CATEGORY,
			icon: Codicon.trash,
			f1: true,
			precondition: OthcloudIsSignedInContext,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);
		const accountService = accessor.get(IOthcloudAccountService);
		const sync = OthcloudTerminalProfilesContribution.get();
		const token = await accountService.getToken();
		if (!sync || !token) {
			return;
		}

		let remote = sync.getRemoteProfiles();
		if (remote.length === 0) {
			remote = await sync.sync();
		}
		if (remote.length === 0) {
			notificationService.info(localize('othcloud.terminalProfiles.noneRemote', "There are no terminal profiles stored on OTHCloud."));
			return;
		}

		type Item = IQuickPickItem & { profile: IOthcloudTerminalProfile };
		const items: Item[] = remote.map(profile => ({
			label: profile.name,
			description: profile.platform === 'all' ? profile.path : `${profile.path} (${profile.platform})`,
			profile,
		}));
		const picked = await quickInputService.pick(items, {
			placeHolder: localize('othcloud.terminalProfiles.pickRemote', "Select a terminal profile to remove from OTHCloud"),
			matchOnDescription: true,
		});
		if (!picked) {
			return;
		}

		try {
			await OthcloudAccountClient.deleteTerminalProfile(token, picked.profile.id);
			await sync.sync();
			notificationService.info(localize('othcloud.terminalProfiles.removed', "Removed terminal profile \"{0}\" from OTHCloud.", picked.profile.name));
		} catch (err) {
			notificationService.notify({ severity: Severity.Error, message: localize('othcloud.terminalProfiles.removeFailed', "Could not remove the terminal profile from OTHCloud: {0}", String((err as Error).message ?? err)) });
		}
	}
});
