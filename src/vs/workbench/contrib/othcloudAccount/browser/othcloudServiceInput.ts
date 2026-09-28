/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

export const OTHCLOUD_SERVICE_SCHEME = 'othcloud-service';

/** The kinds of OTHCloud service that get their own tab. */
export type OthcloudServiceKind = 'application' | 'gameServer';

/**
 * A tab for one OTHCloud service (an application or a game server), rendered
 * natively by {@link OthcloudServiceEditor} rather than by loading the
 * othcloud.xyz dashboard page. One tab per service: the URI is
 * `othcloud-service://<kind>/<id>`, so opening the same service again focuses
 * its tab.
 */
export class OthcloudServiceInput extends EditorInput {

	static readonly ID = 'workbench.editors.othcloudServiceInput';

	private readonly _resource: URI;

	constructor(
		readonly kind: OthcloudServiceKind,
		readonly serviceId: string,
		private name: string,
	) {
		super();
		this._resource = URI.from({ scheme: OTHCLOUD_SERVICE_SCHEME, authority: kind, path: '/' + serviceId });
	}

	override get typeId(): string {
		return OthcloudServiceInput.ID;
	}

	override get editorId(): string | undefined {
		return OthcloudServiceInput.ID;
	}

	override get resource(): URI {
		return this._resource;
	}

	override getName(): string {
		return this.name;
	}

	/** The service's name once loaded, which may differ from what the tab opened with. */
	setName(name: string): void {
		if (name && name !== this.name) {
			this.name = name;
			this._onDidChangeLabel.fire();
		}
	}

	override getIcon(): ThemeIcon {
		return this.kind === 'gameServer' ? Codicon.game : Codicon.server;
	}

	override toUntyped(): IUntypedEditorInput {
		return { resource: this._resource, options: { override: OthcloudServiceInput.ID, pinned: true } };
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (other instanceof OthcloudServiceInput) {
			return other.kind === this.kind && other.serviceId === this.serviceId;
		}
		return super.matches(other);
	}
}
