/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, Dimension } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ExtensionsMarketplaceEditorInput } from './extensionsMarketplaceEditorInput.js';
import { ExtensionsViewPaneContainer } from './extensionsViewlet.js';

/**
 * OTerminal: editor pane that hosts the Extensions marketplace UI in an editor tab.
 * Modeled after Settings/Process Explorer so it can be moved to a floating auxiliary window.
 *
 * Notes:
 *   ExtensionsViewPaneContainer is normally hosted by a CompositePart, which manages the lifecycle
 *   ordering: create → setVisible → views registered → layout. When we host it directly here, the
 *   editor framework calls layout() before the views finish wiring up, and ViewPaneContainer.
 *   restoreViewSizes asserts on a missing pane. We swallow those early layout errors and let the
 *   pane catch up on its own ResizeObserver tick.
 */
export class ExtensionsMarketplaceEditor extends EditorPane {

	static readonly ID: string = 'workbench.editor.extensionsMarketplace';

	private container: HTMLElement | undefined;
	private vpcHost: HTMLElement | undefined;
	private viewPaneContainer: ExtensionsViewPaneContainer | undefined;
	private currentDimension: Dimension | undefined;
	private layoutReady = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(ExtensionsMarketplaceEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = $('.extensions-marketplace-editor');
		this.container.style.height = '100%';
		this.container.style.width = '100%';
		this.container.style.position = 'relative';
		parent.appendChild(this.container);

		this.vpcHost = $('div');
		this.vpcHost.style.position = 'absolute';
		this.vpcHost.style.inset = '0';
		this.vpcHost.style.overflow = 'hidden';
		this.container.appendChild(this.vpcHost);

		try {
			this.viewPaneContainer = this._register(this.instantiationService.createInstance(ExtensionsViewPaneContainer));
			this.viewPaneContainer.create(this.vpcHost);
			this.viewPaneContainer.setVisible(true);

			// Wait one tick for views to register, then it's safe to layout.
			queueMicrotask(() => {
				this.layoutReady = true;
				if (this.currentDimension) {
					this.safeLayout(this.currentDimension);
				}
			});
		} catch (err) {
			console.error('ExtensionsMarketplaceEditor: failed to create ViewPaneContainer', err);
		}
	}

	override async setInput(input: ExtensionsMarketplaceEditorInput, options: unknown, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options as never, context, token);
		if (this.layoutReady && this.currentDimension) {
			this.safeLayout(this.currentDimension);
		}
	}

	override focus(): void {
		try { this.viewPaneContainer?.focus(); } catch { /* swallow - focus before view ready */ }
	}

	override layout(dimension: Dimension): void {
		this.currentDimension = dimension;
		if (this.container) {
			this.container.style.height = `${dimension.height}px`;
			this.container.style.width = `${dimension.width}px`;
		}
		this.safeLayout(dimension);
	}

	private safeLayout(dimension: Dimension): void {
		if (!this.viewPaneContainer || !this.layoutReady) {
			return;
		}
		try {
			this.viewPaneContainer.layout(new Dimension(dimension.width, dimension.height));
		} catch (err) {
			// Early layout calls can race the view-pane registration; swallow and the next tick will recover.
		}
	}
}
