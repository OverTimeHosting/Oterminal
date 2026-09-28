/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/othcloudService.css';
import { $, addDisposableListener, append, clearNode, Dimension, EventType } from '../../../../base/browser/dom.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { posix } from '../../../../base/common/path.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { FileType, IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { BrowserViewUri } from '../../../../platform/browserView/common/browserViewUri.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IOthcloudAccountService } from '../common/othcloudAccountService.js';
import { getOthcloudBaseUrl, IOthcloudDevEnvStatus, IOthcloudGameServerDetails, IOthcloudServiceRow, OthcloudAccountApiError, OthcloudAccountClient, OthcloudPowerSignal } from './othcloudAccountClient.js';
import { OPEN_REMOTE_COMMAND, START_COMMAND, STOP_COMMAND } from './othcloudDevEnvironments.js';
import { gameFileUri } from './othcloudGameFileSystem.js';
import { OthcloudServiceInput, OthcloudServiceKind } from './othcloudServiceInput.js';

type SectionId = 'overview' | 'logs' | 'files' | 'settings';

interface ISectionTab {
	readonly id: SectionId;
	readonly label: string;
	readonly icon: ThemeIcon;
}

interface IServiceAction {
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly primary?: boolean;
	readonly danger?: boolean;
	/** Shown but not clickable, with this reason as the tooltip. */
	readonly unavailable?: string;
	readonly run?: () => Promise<unknown> | void;
}

type StatusCategory = 'ok' | 'busy' | 'error' | 'off';

type Loaded =
	| { readonly kind: 'loading' }
	| { readonly kind: 'error'; readonly message: string }
	| {
		readonly kind: 'loaded';
		readonly row: IOthcloudServiceRow;
		readonly devEnv?: IOthcloudDevEnvStatus;
		readonly game?: IOthcloudGameServerDetails;
		/** The server predates the game server endpoints: only the listing's summary is known. */
		readonly gameApiMissing?: boolean;
	};

/** How often the live parts refresh while visible. */
const DETAILS_POLL_MS = 5000;
const CONSOLE_POLL_MS = 2000;
const CONSOLE_LINES = 300;

const ANSI_ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

/**
 * Console output as a terminal would show it. The node streams raw terminal
 * output: colour codes, carriage returns that redraw the line, and the server's
 * `>....` input prompt between messages.
 */
function cleanConsole(raw: string): string {
	return raw
		.replace(ANSI_ESCAPES, '')
		.split('\n')
		// a carriage return redraws the line: only what comes after the last one shows
		.map(line => line.slice(line.lastIndexOf('\r') + 1))
		.filter(line => !/^>[\s.]*$/.test(line))
		.join('\n');
}

function toAbsoluteOthcloudUrl(path: string): string {
	return path.startsWith('http://') || path.startsWith('https://')
		? path
		: getOthcloudBaseUrl() + (path.startsWith('/') ? path : '/' + path);
}

function formatBytes(bytes: number): string {
	if (!bytes) {
		return '0 B';
	}
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatUptime(ms: number): string {
	const minutes = Math.floor(ms / 60000);
	if (minutes < 1) {
		return localize('othcloud.service.uptime.justNow', "just started");
	}
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;
	return days ? `${days}d ${hours}h` : hours ? `${hours}h ${mins}m` : `${mins}m`;
}

function gameStateCategory(state: string): StatusCategory {
	switch (state) {
		case 'running': return 'ok';
		case 'starting':
		case 'stopping': return 'busy';
		case 'error': return 'error';
		default: return 'off';
	}
}

function gameStateLabel(state: string): string {
	switch (state) {
		case 'running': return localize('othcloud.service.state.running', "Online");
		case 'starting': return localize('othcloud.service.state.starting', "Starting");
		case 'stopping': return localize('othcloud.service.state.stopping', "Stopping");
		case 'error': return localize('othcloud.service.state.error', "Error");
		default: return localize('othcloud.service.state.offline', "Offline");
	}
}

/**
 * The native tab for one OTHCloud service: a header with the service's state
 * and actions, then sections. A game server's overview is its live console and
 * vitals; its files open as a real file system (see othcloudGameFileSystem.ts).
 */
export class OthcloudServiceEditor extends EditorPane {

	static readonly ID = 'workbench.editor.othcloudService';

	private root!: HTMLElement;
	private serviceInput: OthcloudServiceInput | undefined;
	private state: Loaded = { kind: 'loading' };
	private section: SectionId = 'overview';
	private loadSeq = 0;
	private paneVisible = false;

	/** Pending power action, shown in the header until the next refresh confirms it. */
	private pendingPower: OthcloudPowerSignal | undefined;

	// Parts refreshed in place by the polls, so typing and scrolling survive them
	private headerEl: HTMLElement | undefined;
	private statsEl: HTMLElement | undefined;
	private consoleOutput: HTMLElement | undefined;
	private consoleText = '';

	// Files section
	private filesPath = '/';
	private filesEl: HTMLElement | undefined;

	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly detailsTimer = this._register(new IntervalTimer());
	private readonly consoleTimer = this._register(new IntervalTimer());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IOthcloudAccountService private readonly accountService: IOthcloudAccountService,
		@ICommandService private readonly commandService: ICommandService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(OthcloudServiceEditor.ID, group, telemetryService, themeService, storageService);
		this._register(this.accountService.onDidChangeAuth(() => void this.load()));
	}

	protected createEditor(parent: HTMLElement): void {
		this.root = append(parent, $('.othcloud-service-editor'));
		this.root.tabIndex = -1;
	}

	override async setInput(input: OthcloudServiceInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (this.serviceInput !== input) {
			this.serviceInput = input;
			this.section = 'overview';
			this.filesPath = '/';
			this.consoleText = '';
			this.pendingPower = undefined;
			this.state = { kind: 'loading' };
		}
		this.render();
		await this.load();
	}

	override clearInput(): void {
		this.serviceInput = undefined;
		this.loadSeq++;
		this.stopPolling();
		super.clearInput();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		this.paneVisible = visible;
		if (visible) {
			this.startPolling();
		} else {
			this.stopPolling();
		}
	}

	override focus(): void {
		super.focus();
		this.root?.focus();
	}

	override layout(_dimension: Dimension): void {
		// Regular flow layout that scrolls itself.
	}

	private get kind(): OthcloudServiceKind {
		return this.serviceInput?.kind ?? 'application';
	}

	//#region Data

	private async load(): Promise<void> {
		const input = this.serviceInput;
		if (!input) {
			return;
		}
		const seq = ++this.loadSeq;
		const token = await this.accountService.getToken();
		if (!token) {
			this.state = { kind: 'error', message: localize('othcloud.service.signIn', "Sign in to OTHCloud to see this service.") };
			this.render();
			return;
		}
		try {
			let next: Loaded;
			if (input.kind === 'gameServer') {
				next = await this.loadGameServer(token, input.serviceId);
			} else {
				const services = await OthcloudAccountClient.listServices(token);
				const row = services.applications?.find(r => r.id === input.serviceId);
				if (!row) {
					throw new Error(localize('othcloud.service.gone', "This service no longer exists, or you no longer have access to it."));
				}
				const devEnv = await OthcloudAccountClient.devEnvironmentStatus(token, row.id).catch(() => undefined);
				next = { kind: 'loaded', row, devEnv };
			}
			if (seq !== this.loadSeq) {
				return;
			}
			if (next.kind === 'loaded') {
				input.setName(next.row.name);
			}
			this.state = next;
		} catch (err) {
			if (seq !== this.loadSeq) {
				return;
			}
			this.state = { kind: 'error', message: this.describe(err) };
		}
		this.render();
		this.startPolling();
	}

	private async loadGameServer(token: string, composeId: string): Promise<Loaded> {
		try {
			const game = await OthcloudAccountClient.gameServerDetails(token, composeId);
			const row: IOthcloudServiceRow = {
				id: composeId,
				name: game.name,
				status: game.state,
				meta: { ...(game.gameType ? { type: game.gameType } : {}), ...(game.address ? { address: game.address } : {}) },
				url: `/dashboard/games/${composeId}`,
			};
			return { kind: 'loaded', row, game };
		} catch (err) {
			if (!(err instanceof OthcloudAccountApiError && err.status === 404)) {
				throw err;
			}
			// A 404 is either "not yours" or an othcloud.xyz without these endpoints;
			// the listing tells the two apart.
			const services = await OthcloudAccountClient.listServices(token);
			const row = services.gameServers?.find(r => r.id === composeId);
			if (!row) {
				throw new Error(localize('othcloud.service.gone', "This service no longer exists, or you no longer have access to it."));
			}
			return { kind: 'loaded', row, gameApiMissing: true };
		}
	}

	/** Refreshes a game server's details without re-rendering the whole tab. */
	private async refreshGameDetails(): Promise<void> {
		const input = this.serviceInput;
		const state = this.state;
		if (!input || input.kind !== 'gameServer' || state.kind !== 'loaded' || state.gameApiMissing) {
			return;
		}
		const token = await this.accountService.getToken();
		if (!token) {
			return;
		}
		try {
			const game = await OthcloudAccountClient.gameServerDetails(token, input.serviceId);
			if (this.serviceInput !== input) {
				return;
			}
			if (this.pendingPower && this.powerSettled(this.pendingPower, game.state)) {
				this.pendingPower = undefined;
			}
			this.state = { ...state, game, row: { ...state.row, status: game.state } };
			this.renderHeaderInPlace();
			this.renderStatsInPlace();
		} catch {
			// Keep showing the last good state; the next poll retries
		}
	}

	private async refreshConsole(): Promise<void> {
		const input = this.serviceInput;
		if (!input || input.kind !== 'gameServer' || !this.consoleOutput) {
			return;
		}
		const token = await this.accountService.getToken();
		if (!token) {
			return;
		}
		try {
			const { logs } = await OthcloudAccountClient.gameServerConsole(token, input.serviceId, CONSOLE_LINES);
			if (this.serviceInput !== input) {
				return;
			}
			this.setConsoleText(cleanConsole(logs ?? ''));
		} catch {
			// The next poll retries
		}
	}

	private startPolling(): void {
		const state = this.state;
		if (!this.paneVisible || this.kind !== 'gameServer' || state.kind !== 'loaded' || state.gameApiMissing) {
			this.stopPolling();
			return;
		}
		this.detailsTimer.cancelAndSet(() => void this.refreshGameDetails(), DETAILS_POLL_MS, mainWindow);
		if (this.section === 'overview') {
			this.consoleTimer.cancelAndSet(() => void this.refreshConsole(), CONSOLE_POLL_MS, mainWindow);
			void this.refreshConsole();
		} else {
			this.consoleTimer.cancel();
		}
	}

	private stopPolling(): void {
		this.detailsTimer.cancel();
		this.consoleTimer.cancel();
	}

	private powerSettled(signal: OthcloudPowerSignal, state: string): boolean {
		switch (signal) {
			case 'start':
			case 'restart': return state === 'running';
			default: return state === 'offline';
		}
	}

	private async power(signal: OthcloudPowerSignal): Promise<void> {
		const input = this.serviceInput;
		const token = await this.accountService.getToken();
		if (!input || !token) {
			return;
		}
		if (signal === 'kill') {
			const { confirmed } = await this.dialogService.confirm({
				message: localize('othcloud.service.killTitle', "Force stop {0}?", input.getName()),
				detail: localize('othcloud.service.killDetail', "The server is stopped immediately, without saving. Use this only if it won't stop normally."),
				primaryButton: localize({ key: 'othcloud.service.kill', comment: ['&& denotes a mnemonic'] }, "&&Force Stop"),
			});
			if (!confirmed) {
				return;
			}
		}
		this.pendingPower = signal;
		this.renderHeaderInPlace();
		try {
			await OthcloudAccountClient.gameServerPower(token, input.serviceId, signal);
		} catch (err) {
			this.pendingPower = undefined;
			this.notificationService.error(this.describe(err));
		}
		this.renderHeaderInPlace();
		void this.refreshGameDetails();
		void this.refreshConsole();
	}

	private async sendCommand(command: string): Promise<boolean> {
		const input = this.serviceInput;
		const token = await this.accountService.getToken();
		if (!input || !token || !command.trim()) {
			return false;
		}
		try {
			await OthcloudAccountClient.gameServerCommand(token, input.serviceId, command);
			setTimeout(() => void this.refreshConsole(), 400);
			return true;
		} catch (err) {
			this.notificationService.error(this.describe(err));
			return false;
		}
	}

	private describe(err: unknown): string {
		if (err instanceof TypeError) {
			return localize('othcloud.service.unreachable', "Can't reach OTHCloud. Check your connection and try again.");
		}
		return String((err as Error)?.message ?? err);
	}

	//#endregion

	//#region Rendering

	private render(): void {
		if (!this.root) {
			return;
		}
		this.renderDisposables.clear();
		clearNode(this.root);
		this.headerEl = this.statsEl = this.consoleOutput = this.filesEl = undefined;
		this.root.classList.toggle('game', this.kind === 'gameServer');

		const state = this.state;
		if (state.kind === 'loading') {
			const loading = append(this.root, $('.othcloud-service-message'));
			append(loading, $('span' + ThemeIcon.asCSSSelector(ThemeIcon.modify(Codicon.loading, 'spin'))));
			append(loading, $('span', {}, localize('othcloud.service.loading', "Loading...")));
			return;
		}
		if (state.kind === 'error') {
			const error = append(this.root, $('.othcloud-service-message.error'));
			append(error, $('span' + ThemeIcon.asCSSSelector(Codicon.warning)));
			append(error, $('span', {}, state.message));
			const retry = append(error, $('button.othcloud-service-button')) as HTMLButtonElement;
			retry.textContent = localize('othcloud.service.retry', "Try Again");
			retry.onclick = () => void this.load();
			return;
		}

		this.headerEl = append(this.root, $('.othcloud-service-header'));
		this.renderHeaderInPlace();
		if (state.gameApiMissing) {
			const banner = append(this.root, $('.othcloud-service-banner'));
			append(banner, $('span' + ThemeIcon.asCSSSelector(Codicon.info)));
			append(banner, $('span', {}, localize('othcloud.service.updateOthcloud', "The console, controls and files need a newer othcloud.xyz. Until it is updated, manage this server on OTHCloud.")));
		}
		this.renderTabs();
		const body = append(this.root, $('.othcloud-service-body'));
		switch (this.section) {
			case 'overview':
				if (this.kind === 'gameServer') {
					this.renderGameOverview(body, state);
				} else {
					this.renderAppOverview(body, state.row, state.devEnv);
				}
				break;
			case 'files':
				if (this.kind === 'gameServer' && state.game?.canManageFiles) {
					this.filesEl = append(body, $('.othcloud-service-files'));
					void this.renderFiles();
				} else {
					this.renderMessage(body, Codicon.files, this.kind === 'gameServer'
						? localize('othcloud.service.filesUnsupported', "Files for this kind of server are on OTHCloud for now.")
						: localize('othcloud.service.appFilesSoon', "Browse an application's files by opening its dev environment remotely. A files view here is coming."));
				}
				break;
			default:
				this.renderMessage(body, Codicon.tools, localize('othcloud.service.comingSoon', "This part of the service view is being built."));
		}
	}

	private renderHeaderInPlace(): void {
		const header = this.headerEl;
		const state = this.state;
		if (!header || state.kind !== 'loaded') {
			return;
		}
		clearNode(header);
		const { row, devEnv, game } = state;

		const icon = append(header, $('.othcloud-service-header-icon'));
		append(icon, $('span' + ThemeIcon.asCSSSelector(this.kind === 'gameServer' ? Codicon.game : Codicon.server)));

		const titles = append(header, $('.othcloud-service-titles'));
		const titleRow = append(titles, $('.othcloud-service-title-row'));
		append(titleRow, $('h1.othcloud-service-name', {}, row.name));
		const status = this.statusOf(row, devEnv, game);
		if (status) {
			const pill = append(titleRow, $(`span.othcloud-service-status.s-${status.category}`));
			append(pill, $('span.othcloud-service-status-dot'));
			append(pill, $('span', {}, status.label));
		}

		const subtitle = append(titles, $('.othcloud-service-subtitle'));
		const type = this.kind === 'gameServer' ? (game?.gameType ?? row.meta?.type) : row.meta?.toolchain;
		if (type) {
			append(subtitle, $('span.othcloud-service-chip', {}, type));
		}
		if (game?.version) {
			append(subtitle, $('span.othcloud-service-chip.plain', {}, game.version));
		}
		const address = game?.address ?? row.meta?.address;
		if (address) {
			const chip = append(subtitle, $('button.othcloud-service-chip.address')) as HTMLButtonElement;
			append(chip, $('span', {}, address));
			append(chip, $('span' + ThemeIcon.asCSSSelector(Codicon.copy)));
			chip.title = localize('othcloud.service.copyAddress', "Copy server address");
			chip.onclick = () => {
				void this.clipboardService.writeText(address);
				chip.classList.add('copied');
				setTimeout(() => chip.classList.remove('copied'), 1200);
			};
		} else if (row.meta?.project) {
			append(subtitle, $('span.othcloud-service-muted', {}, row.meta.project));
		}
		if (game?.suspended) {
			append(subtitle, $('span.othcloud-service-chip.warn', {}, game.suspended.reason === 'unpaid'
				? localize('othcloud.service.suspendedUnpaid', "Suspended: unpaid")
				: localize('othcloud.service.suspended', "Suspended")));
		}

		const actions = append(header, $('.othcloud-service-actions'));
		for (const action of this.actionsFor(state)) {
			const button = append(actions, $('button.othcloud-service-button')) as HTMLButtonElement;
			button.classList.toggle('primary', !!action.primary);
			button.classList.toggle('danger', !!action.danger);
			append(button, $('span' + ThemeIcon.asCSSSelector(action.icon)));
			append(button, $('span', {}, action.label));
			if (action.unavailable || !action.run) {
				button.disabled = true;
				button.title = action.unavailable ?? '';
			} else {
				const run = action.run;
				button.onclick = async () => {
					button.disabled = true;
					try {
						await run();
					} finally {
						button.disabled = false;
					}
				};
			}
		}
	}

	private renderTabs(): void {
		const tabs = append(this.root, $('.othcloud-service-tabs'));
		tabs.setAttribute('role', 'tablist');
		for (const tab of this.sectionTabs()) {
			const button = append(tabs, $('button.othcloud-service-tab')) as HTMLButtonElement;
			button.setAttribute('role', 'tab');
			button.setAttribute('aria-selected', String(tab.id === this.section));
			button.classList.toggle('active', tab.id === this.section);
			append(button, $('span' + ThemeIcon.asCSSSelector(tab.icon)));
			append(button, $('span', {}, tab.label));
			button.onclick = () => {
				this.section = tab.id;
				this.render();
				this.startPolling();
			};
		}
	}

	private renderMessage(body: HTMLElement, icon: ThemeIcon, text: string): void {
		const empty = append(body, $('.othcloud-service-message'));
		append(empty, $('span' + ThemeIcon.asCSSSelector(icon)));
		append(empty, $('span', {}, text));
	}

	private renderGameOverview(body: HTMLElement, state: Extract<Loaded, { kind: 'loaded' }>): void {
		if (state.gameApiMissing) {
			this.renderMessage(body, Codicon.terminal, localize('othcloud.service.consoleNeedsUpdate', "The live console appears here once othcloud.xyz is updated."));
			return;
		}
		this.statsEl = append(body, $('.othcloud-service-stats'));
		this.renderStatsInPlace();

		const consoleBox = append(body, $('.othcloud-service-console'));
		const consoleHead = append(consoleBox, $('.othcloud-service-console-head'));
		append(consoleHead, $('span' + ThemeIcon.asCSSSelector(Codicon.terminal)));
		append(consoleHead, $('span', {}, localize('othcloud.service.console', "Console")));
		const copy = append(consoleHead, $('button.othcloud-service-icon-button')) as HTMLButtonElement;
		append(copy, $('span' + ThemeIcon.asCSSSelector(Codicon.copy)));
		copy.title = localize('othcloud.service.copyConsole', "Copy console output");
		copy.onclick = () => void this.clipboardService.writeText(this.consoleText);

		this.consoleOutput = append(consoleBox, $('pre.othcloud-service-console-output'));
		this.consoleOutput.setAttribute('role', 'log');
		this.consoleOutput.setAttribute('aria-live', 'polite');
		this.consoleOutput.textContent = this.consoleText || localize('othcloud.service.consoleEmpty', "No console output yet.");
		this.consoleOutput.scrollTop = this.consoleOutput.scrollHeight;

		const inputRow = append(consoleBox, $('.othcloud-service-console-input'));
		append(inputRow, $('span.othcloud-service-console-prompt', {}, '>'));
		const input = append(inputRow, $('input')) as HTMLInputElement;
		input.type = 'text';
		input.spellcheck = false;
		input.placeholder = localize('othcloud.service.commandPlaceholder', "Type a command and press Enter");
		input.setAttribute('aria-label', localize('othcloud.service.commandAria', "Server console command"));
		const history: string[] = [];
		let historyIndex = -1;
		this.renderDisposables.add(addDisposableListener(input, EventType.KEY_DOWN, async (e: KeyboardEvent) => {
			if (e.key === 'Enter' && input.value.trim()) {
				const command = input.value.trim();
				input.disabled = true;
				const sent = await this.sendCommand(command);
				input.disabled = false;
				input.focus();
				if (sent) {
					history.unshift(command);
					historyIndex = -1;
					input.value = '';
				}
			} else if (e.key === 'ArrowUp' && history.length) {
				historyIndex = Math.min(historyIndex + 1, history.length - 1);
				input.value = history[historyIndex];
				e.preventDefault();
			} else if (e.key === 'ArrowDown') {
				historyIndex = Math.max(historyIndex - 1, -1);
				input.value = historyIndex >= 0 ? history[historyIndex] : '';
				e.preventDefault();
			}
		}));
	}

	private setConsoleText(text: string): void {
		if (text === this.consoleText) {
			return;
		}
		this.consoleText = text;
		const output = this.consoleOutput;
		if (!output) {
			return;
		}
		// Follow new output only when already at the bottom, so reading back isn't interrupted
		const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 24;
		output.textContent = text || localize('othcloud.service.consoleEmpty', "No console output yet.");
		if (atBottom) {
			output.scrollTop = output.scrollHeight;
		}
	}

	private renderStatsInPlace(): void {
		const stats = this.statsEl;
		const state = this.state;
		if (!stats || state.kind !== 'loaded') {
			return;
		}
		clearNode(stats);
		const game = state.game;
		const tile = (icon: ThemeIcon, label: string, value: string, detail?: string, fraction?: number) => {
			const el = append(stats, $('.othcloud-service-stat'));
			const head = append(el, $('.othcloud-service-stat-label'));
			append(head, $('span' + ThemeIcon.asCSSSelector(icon)));
			append(head, $('span', {}, label));
			append(el, $('.othcloud-service-stat-value', {}, value));
			if (fraction !== undefined) {
				const bar = append(el, $('.othcloud-service-stat-bar'));
				append(bar, $('span')).style.width = `${Math.round(Math.min(Math.max(fraction, 0), 1) * 100)}%`;
			}
			if (detail) {
				append(el, $('.othcloud-service-stat-detail', {}, detail));
			}
		};
		const r = game?.resources;
		const online = game?.state === 'running';
		const dash = '-';
		tile(Codicon.pulse, localize('othcloud.service.cpu', "CPU"), r && online ? `${r.cpuAbsolute.toFixed(0)}%` : dash);
		tile(Codicon.serverProcess, localize('othcloud.service.memory', "Memory"),
			r && online ? formatBytes(r.memoryBytes) : dash,
			r?.memoryLimitBytes ? localize('othcloud.service.of', "of {0}", formatBytes(r.memoryLimitBytes)) : undefined,
			r?.memoryLimitBytes && online ? r.memoryBytes / r.memoryLimitBytes : undefined);
		tile(Codicon.database, localize('othcloud.service.disk', "Disk"), r ? formatBytes(r.diskBytes) : dash);
		tile(Codicon.clock, localize('othcloud.service.uptime', "Uptime"), r && online ? formatUptime(r.uptime) : dash);
		const players = game?.players;
		tile(Codicon.person, localize('othcloud.service.players', "Players"),
			players && online ? `${players.online} / ${players.max}` : dash,
			players && online && players.names.length ? players.names.slice(0, 6).join(', ') + (players.names.length > 6 ? '...' : '') : undefined);
	}

	private renderAppOverview(body: HTMLElement, row: IOthcloudServiceRow, devEnv: IOthcloudDevEnvStatus | undefined): void {
		const grid = append(body, $('.othcloud-service-cards'));
		const card = (title: string, icon: ThemeIcon) => {
			const el = append(grid, $('.othcloud-service-card'));
			const head = append(el, $('.othcloud-service-card-title'));
			append(head, $('span' + ThemeIcon.asCSSSelector(icon)));
			append(head, $('span', {}, title));
			return append(el, $('dl.othcloud-service-fields'));
		};
		const field = (list: HTMLElement, label: string, value: string | undefined) => {
			append(list, $('dt', {}, label));
			append(list, $('dd', {}, value || localize('othcloud.service.none', "None")));
		};
		const app = card(localize('othcloud.service.application', "Application"), Codicon.server);
		field(app, localize('othcloud.service.project', "Project"), row.meta?.project);
		field(app, localize('othcloud.service.toolchain', "Toolchain"), row.meta?.toolchain);
		const dev = card(localize('othcloud.service.devEnvironment', "Dev environment"), Codicon.remote);
		field(dev, localize('othcloud.service.status', "Status"), devEnv ? this.devEnvLabel(devEnv) : undefined);
		if (devEnv?.state === 'running') {
			field(dev, localize('othcloud.service.editorVersion', "Editor version"), devEnv.version ?? undefined);
		}
		if (devEnv?.state === 'unavailable') {
			field(dev, localize('othcloud.service.reason', "Why"), devEnv.reason);
		}
		append(dev, $('dd.othcloud-service-hint', {}, localize('othcloud.service.devHint', "Open Remotely edits this application's workspace in a remote window, with a terminal and its toolchain.")));
	}

	//#endregion

	//#region Files

	private async renderFiles(): Promise<void> {
		const el = this.filesEl;
		const input = this.serviceInput;
		if (!el || !input) {
			return;
		}
		const path = this.filesPath;
		clearNode(el);

		const toolbar = append(el, $('.othcloud-service-files-toolbar'));
		const crumbs = append(toolbar, $('.othcloud-service-crumbs'));
		const segments = path.split('/').filter(Boolean);
		const crumb = (label: string, target: string) => {
			const button = append(crumbs, $('button.othcloud-service-crumb', {}, label)) as HTMLButtonElement;
			button.onclick = () => this.navigateFiles(target);
		};
		crumb(localize('othcloud.service.filesRoot', "Server"), '/');
		segments.forEach((segment, i) => {
			append(crumbs, $('span.othcloud-service-crumb-sep', {}, '/'));
			crumb(segment, '/' + segments.slice(0, i + 1).join('/'));
		});
		const tools = append(toolbar, $('.othcloud-service-files-tools'));
		const tool = (icon: ThemeIcon, label: string, run: () => void) => {
			const button = append(tools, $('button.othcloud-service-icon-button')) as HTMLButtonElement;
			append(button, $('span' + ThemeIcon.asCSSSelector(icon)));
			button.title = label;
			button.setAttribute('aria-label', label);
			button.onclick = run;
		};
		tool(Codicon.newFile, localize('othcloud.service.newFile', "New File"), () => void this.createEntry(false));
		tool(Codicon.newFolder, localize('othcloud.service.newFolder', "New Folder"), () => void this.createEntry(true));
		tool(Codicon.refresh, localize('othcloud.service.refreshFiles', "Refresh"), () => void this.renderFiles());

		const list = append(el, $('.othcloud-service-file-list'));
		const loading = append(list, $('.othcloud-service-file-empty'));
		append(loading, $('span' + ThemeIcon.asCSSSelector(ThemeIcon.modify(Codicon.loading, 'spin'))));

		let entries: [string, FileType][];
		try {
			entries = (await this.fileService.resolve(gameFileUri(input.serviceId, path))).children?.map(c => [c.name, c.isDirectory ? FileType.Directory : FileType.File] as [string, FileType]) ?? [];
		} catch (err) {
			if (this.filesEl !== el || this.filesPath !== path) {
				return;
			}
			clearNode(list);
			append(list, $('.othcloud-service-file-empty.error', {}, this.describe(err)));
			return;
		}
		if (this.filesEl !== el || this.filesPath !== path) {
			return; // navigated elsewhere meanwhile
		}
		clearNode(list);
		entries.sort((a, b) => (b[1] === FileType.Directory ? 1 : 0) - (a[1] === FileType.Directory ? 1 : 0) || a[0].localeCompare(b[0]));
		if (path !== '/') {
			const up = append(list, $('button.othcloud-service-file.up')) as HTMLButtonElement;
			append(up, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowUp)));
			append(up, $('span.othcloud-service-file-name', {}, '..'));
			up.onclick = () => this.navigateFiles(posix.dirname(path));
		}
		if (!entries.length) {
			append(list, $('.othcloud-service-file-empty', {}, localize('othcloud.service.emptyFolder', "This folder is empty.")));
		}
		for (const [name, type] of entries) {
			const isDir = type === FileType.Directory;
			const full = posix.join(path, name);
			const rowEl = append(list, $('.othcloud-service-file'));
			rowEl.tabIndex = 0;
			rowEl.setAttribute('role', 'button');
			append(rowEl, $('span' + ThemeIcon.asCSSSelector(isDir ? Codicon.folder : Codicon.file)));
			append(rowEl, $('span.othcloud-service-file-name', {}, name));
			const rowActions = append(rowEl, $('.othcloud-service-file-actions'));
			const rowAction = (icon: ThemeIcon, label: string, run: () => void) => {
				const button = append(rowActions, $('button.othcloud-service-icon-button')) as HTMLButtonElement;
				append(button, $('span' + ThemeIcon.asCSSSelector(icon)));
				button.title = label;
				button.setAttribute('aria-label', label);
				button.onclick = e => {
					e.stopPropagation();
					run();
				};
			};
			rowAction(Codicon.edit, localize('othcloud.service.rename', "Rename"), () => void this.renameEntry(full, name));
			rowAction(Codicon.trash, localize('othcloud.service.delete', "Delete"), () => void this.deleteEntry(full, name, isDir));
			const open = () => isDir ? this.navigateFiles(full) : void this.editorService.openEditor({ resource: gameFileUri(input.serviceId, full), options: { pinned: true } });
			rowEl.onclick = open;
			rowEl.onkeydown = e => {
				if (e.key === 'Enter') {
					open();
				}
			};
		}
	}

	private navigateFiles(path: string): void {
		this.filesPath = path || '/';
		void this.renderFiles();
	}

	private async createEntry(folder: boolean): Promise<void> {
		const input = this.serviceInput;
		if (!input) {
			return;
		}
		const name = await this.quickInputService.input({
			prompt: folder ? localize('othcloud.service.newFolderPrompt', "Name of the new folder") : localize('othcloud.service.newFilePrompt', "Name of the new file"),
			validateInput: async value => /[/\\]/.test(value) ? localize('othcloud.service.nameNoSlash', "Names can't contain slashes") : undefined,
		});
		if (!name) {
			return;
		}
		const resource = gameFileUri(input.serviceId, posix.join(this.filesPath, name));
		try {
			if (folder) {
				await this.fileService.createFolder(resource);
			} else {
				await this.fileService.writeFile(resource, VSBuffer.fromString(''));
				await this.editorService.openEditor({ resource, options: { pinned: true } });
			}
		} catch (err) {
			this.notificationService.error(this.describe(err));
		}
		void this.renderFiles();
	}

	private async renameEntry(full: string, name: string): Promise<void> {
		const input = this.serviceInput;
		if (!input) {
			return;
		}
		const newName = await this.quickInputService.input({
			value: name,
			prompt: localize('othcloud.service.renamePrompt', "New name for {0}", name),
			validateInput: async value => /[/\\]/.test(value) ? localize('othcloud.service.nameNoSlash', "Names can't contain slashes") : undefined,
		});
		if (!newName || newName === name) {
			return;
		}
		try {
			await this.fileService.move(gameFileUri(input.serviceId, full), gameFileUri(input.serviceId, posix.join(posix.dirname(full), newName)));
		} catch (err) {
			this.notificationService.error(this.describe(err));
		}
		void this.renderFiles();
	}

	private async deleteEntry(full: string, name: string, isDir: boolean): Promise<void> {
		const input = this.serviceInput;
		if (!input) {
			return;
		}
		const { confirmed } = await this.dialogService.confirm({
			message: isDir
				? localize('othcloud.service.deleteFolderTitle', "Delete the folder {0} and everything in it?", name)
				: localize('othcloud.service.deleteFileTitle', "Delete {0}?", name),
			detail: localize('othcloud.service.deleteDetail', "This deletes it from the server. It can't be undone here."),
			primaryButton: localize({ key: 'othcloud.service.deleteButton', comment: ['&& denotes a mnemonic'] }, "&&Delete"),
		});
		if (!confirmed) {
			return;
		}
		try {
			await this.fileService.del(gameFileUri(input.serviceId, full), { recursive: true });
		} catch (err) {
			this.notificationService.error(this.describe(err));
		}
		void this.renderFiles();
	}

	//#endregion

	private sectionTabs(): ISectionTab[] {
		return this.kind === 'gameServer'
			? [
				{ id: 'overview', label: localize('othcloud.service.tab.overview', "Overview"), icon: Codicon.dashboard },
				{ id: 'files', label: localize('othcloud.service.tab.files', "Files"), icon: Codicon.files },
				{ id: 'settings', label: localize('othcloud.service.tab.settings', "Settings"), icon: Codicon.settingsGear },
			]
			: [
				{ id: 'overview', label: localize('othcloud.service.tab.overview', "Overview"), icon: Codicon.dashboard },
				{ id: 'logs', label: localize('othcloud.service.tab.logs', "Logs"), icon: Codicon.output },
				{ id: 'files', label: localize('othcloud.service.tab.files', "Files"), icon: Codicon.files },
				{ id: 'settings', label: localize('othcloud.service.tab.settings', "Settings"), icon: Codicon.settingsGear },
			];
	}

	private actionsFor(state: Extract<Loaded, { kind: 'loaded' }>): IServiceAction[] {
		const { row, devEnv, game } = state;
		const openOnOthcloud: IServiceAction | undefined = row.url ? {
			label: localize('othcloud.service.openOnOthcloud', "Open on OTHCloud"),
			icon: Codicon.linkExternal,
			run: () => this.openOnOthcloud(row.url!),
		} : undefined;

		if (this.kind === 'gameServer') {
			if (!game) {
				return openOnOthcloud ? [openOnOthcloud] : [];
			}
			const busy = this.pendingPower !== undefined;
			const pendingLabel = this.pendingPower === 'start' ? localize('othcloud.service.starting', "Starting...")
				: this.pendingPower === 'restart' ? localize('othcloud.service.restarting', "Restarting...")
					: localize('othcloud.service.stopping', "Stopping...");
			const state = game.state;
			const suspended = game.suspended ? localize('othcloud.service.suspendedHint', "This server is suspended. Settle it on OTHCloud to start it again.") : undefined;
			const actions: IServiceAction[] = [];
			if (busy) {
				actions.push({ label: pendingLabel, icon: ThemeIcon.modify(Codicon.loading, 'spin'), primary: true, unavailable: pendingLabel });
			} else if (state === 'running') {
				actions.push({ label: localize('othcloud.service.restart', "Restart"), icon: Codicon.debugRestart, run: () => this.power('restart'), unavailable: suspended });
				actions.push({ label: localize('othcloud.service.stop', "Stop"), icon: Codicon.debugStop, danger: true, run: () => this.power('stop') });
			} else if (state === 'starting' || state === 'stopping') {
				actions.push({ label: localize('othcloud.service.stop', "Stop"), icon: Codicon.debugStop, danger: true, run: () => this.power('stop') });
				if (game.runtime === 'otwings') {
					actions.push({ label: localize('othcloud.service.forceStop', "Force Stop"), icon: Codicon.close, danger: true, run: () => this.power('kill') });
				}
			} else {
				actions.push({ label: localize('othcloud.service.start', "Start"), icon: Codicon.debugStart, primary: true, run: () => this.power('start'), unavailable: suspended });
			}
			if (openOnOthcloud) {
				actions.push(openOnOthcloud);
			}
			return actions;
		}

		const running = devEnv?.state === 'running';
		return [
			{ label: localize('othcloud.service.openRemote', "Open Remotely"), icon: Codicon.remote, primary: true, run: () => this.commandService.executeCommand(OPEN_REMOTE_COMMAND, row.id, row.name) },
			running
				? { label: localize('othcloud.service.stopDevEnv', "Stop Dev Environment"), icon: Codicon.debugStop, run: async () => { await this.commandService.executeCommand(STOP_COMMAND, row.id, row.name); await this.load(); } }
				: { label: localize('othcloud.service.startDevEnv', "Start Dev Environment"), icon: Codicon.debugStart, run: async () => { await this.commandService.executeCommand(START_COMMAND, row.id, row.name); await this.load(); } },
			{ label: localize('othcloud.service.deploy', "Deploy"), icon: Codicon.rocket, unavailable: localize('othcloud.service.soon', "Coming soon to OTerminal") },
			...(openOnOthcloud ? [openOnOthcloud] : []),
		];
	}

	private statusOf(row: IOthcloudServiceRow, devEnv: IOthcloudDevEnvStatus | undefined, game: IOthcloudGameServerDetails | undefined): { label: string; category: StatusCategory } | undefined {
		if (this.kind === 'application') {
			if (!devEnv) {
				return undefined;
			}
			return { label: this.devEnvLabel(devEnv), category: devEnv.state === 'running' ? 'ok' : devEnv.state === 'unavailable' ? 'error' : 'off' };
		}
		if (game) {
			return { label: gameStateLabel(game.state), category: gameStateCategory(game.state) };
		}
		if (!row.status) {
			return undefined;
		}
		const s = row.status.toLowerCase();
		const category: StatusCategory = /^(running|deployed|online|active)$/.test(s) ? 'ok'
			: /^(deploying|starting|restarting|pending)$/.test(s) ? 'busy'
				: /^(failed|error|crashed)$/.test(s) ? 'error' : 'off';
		return { label: row.status, category };
	}

	private devEnvLabel(devEnv: IOthcloudDevEnvStatus): string {
		switch (devEnv.state) {
			case 'running': return localize('othcloud.service.devEnv.running', "Dev environment running");
			case 'stopped': return localize('othcloud.service.devEnv.stopped', "Dev environment stopped");
			default: return localize('othcloud.service.devEnv.unavailable', "Dev environment unavailable");
		}
	}

	private async openOnOthcloud(path: string): Promise<void> {
		const absolute = toAbsoluteOthcloudUrl(path);
		try {
			await this.editorService.openEditor({ resource: BrowserViewUri.forUrl(absolute, undefined, { hideChrome: true }), options: { pinned: true } });
		} catch {
			await this.openerService.open(URI.parse(absolute), { openExternal: true });
		}
	}
}
