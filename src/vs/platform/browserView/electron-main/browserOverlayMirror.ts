/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrowserWindow, WebContents, webContents as allWebContents, WebContentsView } from 'electron';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { IBrowserViewOverlayRect } from '../common/browserView.js';

/** How often a mirrored overlay is recaptured while shown, so hover states and progress stay live. */
const CAPTURE_INTERVAL_MS = 120;

const MIRROR_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
img { display: block; width: 100vw; height: 100vh; user-select: none; -webkit-user-drag: none; }
</style></head><body><img id="m" alt=""><script>
const send = e => console.log('__mirror__' + JSON.stringify(e));
const common = e => ({ x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey });
addEventListener('mousemove', e => send({ type: 'move', ...common(e) }));
addEventListener('mousedown', e => { e.preventDefault(); send({ type: 'down', clickCount: e.detail || 1, ...common(e) }); });
addEventListener('mouseup', e => send({ type: 'up', clickCount: e.detail || 1, ...common(e) }));
addEventListener('mouseleave', () => send({ type: 'leave' }));
addEventListener('wheel', e => { e.preventDefault(); send({ type: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY, ...common(e) }); }, { passive: false });
addEventListener('contextmenu', e => e.preventDefault());
</script></body></html>`;

interface IMirrorInput {
	type: 'move' | 'down' | 'up' | 'leave' | 'wheel';
	x?: number;
	y?: number;
	button?: number;
	clickCount?: number;
	deltaX?: number;
	deltaY?: number;
	shift?: boolean;
	ctrl?: boolean;
	alt?: boolean;
	meta?: boolean;
}

interface IMirror {
	readonly view: WebContentsView;
	/** Window coordinates in DIPs. */
	bounds: Electron.Rectangle;
	lastImage: string | undefined;
	ready: boolean;
}

/**
 * Shows workbench overlays (notifications, the notification center, hovers) on top of the
 * integrated browser's native views, while the pages stay live.
 *
 * A browser page is a native view drawn above the workbench, so workbench HTML over it can't
 * show. The workbench still renders that HTML underneath, though, so each overlay rectangle is
 * captured from the window's own web contents and shown in a small transparent view stacked
 * above the pages. Input on it (moves, clicks, the wheel) is forwarded to the workbench at the
 * same place, so the notification underneath reacts as if it were on top, and the mirror
 * recaptures to show that. Keyboard focus is handed back to the workbench.
 */
export class BrowserOverlayMirror extends Disposable {

	private readonly mirrors: IMirror[] = [];
	private timer: ReturnType<typeof setInterval> | undefined;
	/** Requested rectangles per owner (one browser view each); drawn as their union list. */
	private readonly requested = new Map<string, readonly IBrowserViewOverlayRect[]>();
	private zoomFactor = 1;
	/** What had keyboard focus when the mirrors last changed: it gets focus back from a mirror. */
	private focusOwner: WebContents | undefined;

	constructor(private readonly win: BrowserWindow) {
		super();
		this._register(toDisposable(() => {
			this.stopCapturing();
			for (const mirror of this.mirrors.splice(0)) {
				this.destroyMirror(mirror);
			}
		}));
	}

	/**
	 * Sets the overlay rectangles `owner` needs mirrored, in window CSS pixels, replacing its
	 * previous ones. An empty list clears them.
	 */
	update(owner: string, rects: readonly IBrowserViewOverlayRect[], zoomFactor: number): void {
		if (rects.length) {
			this.requested.set(owner, rects);
		} else {
			this.requested.delete(owner);
		}
		this.zoomFactor = zoomFactor || 1;

		const wanted: Electron.Rectangle[] = [];
		for (const list of this.requested.values()) {
			for (const rect of list) {
				const bounds = {
					x: Math.round(rect.x * this.zoomFactor),
					y: Math.round(rect.y * this.zoomFactor),
					width: Math.round(rect.width * this.zoomFactor),
					height: Math.round(rect.height * this.zoomFactor),
				};
				if (bounds.width > 0 && bounds.height > 0) {
					wanted.push(bounds);
				}
			}
		}

		// Adding, loading and restacking native views can take keyboard focus on Windows, which
		// left typing (copy, rename, ...) going nowhere while a toast or hover showed over a page.
		// Whatever had focus keeps it.
		const focused = allWebContents.getFocusedWebContents();

		// Reuse views for the new rectangles, create or drop the difference
		while (this.mirrors.length > wanted.length) {
			this.destroyMirror(this.mirrors.pop()!);
		}
		while (this.mirrors.length < wanted.length) {
			this.mirrors.push(this.createMirror());
		}
		wanted.forEach((bounds, i) => {
			const mirror = this.mirrors[i];
			const moved = mirror.bounds.x !== bounds.x || mirror.bounds.y !== bounds.y || mirror.bounds.width !== bounds.width || mirror.bounds.height !== bounds.height;
			mirror.bounds = bounds;
			mirror.view.setBounds(bounds);
			// Re-adding moves it to the top: above any browser view added since
			this.win.contentView.addChildView(mirror.view);
			if (moved) {
				mirror.lastImage = undefined;
				void this.capture(mirror);
			}
		});

		if (focused && !this.isMirror(focused)) {
			this.focusOwner = focused;
		}
		const now = allWebContents.getFocusedWebContents();
		if (now && this.isMirror(now)) {
			this.restoreFocus();
		}

		if (this.mirrors.length) {
			this.startCapturing();
		} else {
			this.stopCapturing();
		}
	}

	/** Gives keyboard focus back to whatever had it before a mirror took it (else the workbench). */
	private restoreFocus(): void {
		const owner = this.focusOwner;
		const target = owner && !owner.isDestroyed() ? owner : this.win.webContents;
		if (!target.isDestroyed()) {
			target.focus();
		}
	}

	private isMirror(contents: WebContents): boolean {
		return this.mirrors.some(mirror => mirror.view.webContents === contents);
	}

	private createMirror(): IMirror {
		const view = new WebContentsView({
			webPreferences: {
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				javascript: true,
				devTools: false,
				spellcheck: false,
			}
		});
		view.setBackgroundColor('#00000000');
		const mirror: IMirror = { view, bounds: { x: 0, y: 0, width: 0, height: 0 }, lastImage: undefined, ready: false };

		view.webContents.on('console-message', (_event, _level, message) => {
			if (message.startsWith('__mirror__')) {
				try {
					this.forwardInput(mirror, JSON.parse(message.slice('__mirror__'.length)));
				} catch {
					// Malformed; ignore
				}
			}
		});
		// Mirrors only ever show pictures, so they never keep keyboard focus (loading one can take
		// it after `update` returned)
		view.webContents.on('focus', () => {
			if (!this.win.isDestroyed()) {
				this.restoreFocus();
			}
		});
		view.webContents.on('did-finish-load', () => {
			mirror.ready = true;
			mirror.lastImage = undefined;
			void this.capture(mirror);
		});
		// The mirror page is fixed; nothing may navigate it
		view.webContents.on('will-navigate', e => e.preventDefault());
		view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
		void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(MIRROR_PAGE)}`);

		this.win.contentView.addChildView(view);
		return mirror;
	}

	private destroyMirror(mirror: IMirror): void {
		if (!this.win.isDestroyed()) {
			this.win.contentView.removeChildView(mirror.view);
		}
		if (mirror.view.webContents && !mirror.view.webContents.isDestroyed()) {
			mirror.view.webContents.close();
		}
	}

	private startCapturing(): void {
		if (!this.timer) {
			this.timer = setInterval(() => {
				for (const mirror of this.mirrors) {
					void this.capture(mirror);
				}
			}, CAPTURE_INTERVAL_MS);
		}
	}

	private stopCapturing(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	private async capture(mirror: IMirror): Promise<void> {
		if (!mirror.ready || this.win.isDestroyed() || !mirror.view.webContents || mirror.view.webContents.isDestroyed()) {
			return;
		}
		const bounds = mirror.bounds;
		// The workbench's own rendering: the browser views are separate layers above it, so the
		// overlay's pixels are there even where a page covers them on screen.
		const image = await this.win.webContents.capturePage(bounds).catch(() => undefined);
		// The mirror may have been dropped meanwhile, taking its web contents with it
		if (!image || mirror.bounds !== bounds || !mirror.view.webContents || mirror.view.webContents.isDestroyed()) {
			return; // moved meanwhile; the next capture has it
		}
		const url = image.toDataURL();
		if (url === mirror.lastImage) {
			return;
		}
		mirror.lastImage = url;
		await mirror.view.webContents.executeJavaScript(`document.getElementById('m').src = ${JSON.stringify(url)};`).catch(() => { /* reloading */ });
	}

	private forwardInput(mirror: IMirror, input: IMirrorInput): void {
		const target = this.win.webContents;
		if (target.isDestroyed()) {
			return;
		}
		// Mirror page coordinates are DIPs from the mirror's corner; the workbench wants DIPs
		// from its own
		const x = mirror.bounds.x + Math.round(input.x ?? 0);
		const y = mirror.bounds.y + Math.round(input.y ?? 0);
		const modifiers: Array<'shift' | 'control' | 'alt' | 'meta'> = [];
		if (input.shift) { modifiers.push('shift'); }
		if (input.ctrl) { modifiers.push('control'); }
		if (input.alt) { modifiers.push('alt'); }
		if (input.meta) { modifiers.push('meta'); }
		const button = input.button === 2 ? 'right' : input.button === 1 ? 'middle' : 'left';

		switch (input.type) {
			case 'move':
				target.sendInputEvent({ type: 'mouseMove', x, y, modifiers });
				break;
			case 'down':
				// Keep typing going to the workbench (e.g. Escape to close the center)
				this.focusOwner = target;
				target.focus();
				target.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: input.clickCount ?? 1, modifiers });
				break;
			case 'up':
				target.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: input.clickCount ?? 1, modifiers });
				break;
			case 'wheel':
				// DOM wheel deltas point the way the content scrolls; Chromium's the opposite
				target.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: -(input.deltaX ?? 0), deltaY: -(input.deltaY ?? 0), modifiers });
				break;
			case 'leave':
				target.sendInputEvent({ type: 'mouseLeave', x: mirror.bounds.x - 1, y: mirror.bounds.y - 1 });
				break;
		}
		// Show the reaction (hover highlight, pressed state) without waiting for the next tick
		setTimeout(() => void this.capture(mirror), 30);
	}
}
