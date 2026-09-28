/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { OthcloudGameFileSystemContribution } from './othcloudGameFileSystem.js';
import { OthcloudServiceEditor } from './othcloudServiceEditor.js';
import { OthcloudServiceInput, OthcloudServiceKind } from './othcloudServiceInput.js';

// Registered before editors restore, so a reopened window can load game files straight away
registerWorkbenchContribution2(OthcloudGameFileSystemContribution.ID, OthcloudGameFileSystemContribution, WorkbenchPhase.BlockRestore);

/** Opens (or focuses) the native tab for a service: `(kind, id, name?)`. */
export const OPEN_SERVICE_COMMAND = 'othcloud.service.open';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(OthcloudServiceEditor, OthcloudServiceEditor.ID, localize('othcloud.service.editorName', "OTHCloud Service")),
	[new SyncDescriptor(OthcloudServiceInput)],
);

const isKind = (value: unknown): value is OthcloudServiceKind => value === 'application' || value === 'gameServer';

class OthcloudServiceInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}

	serialize(input: EditorInput): string | undefined {
		return input instanceof OthcloudServiceInput
			? JSON.stringify({ kind: input.kind, id: input.serviceId, name: input.getName() })
			: undefined;
	}

	deserialize(instantiationService: IInstantiationService, serialized: string): EditorInput | undefined {
		try {
			const { kind, id, name } = JSON.parse(serialized);
			if (!isKind(kind) || typeof id !== 'string') {
				return undefined;
			}
			return instantiationService.createInstance(OthcloudServiceInput, kind, id, typeof name === 'string' ? name : id);
		} catch {
			return undefined;
		}
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(OthcloudServiceInput.ID, OthcloudServiceInputSerializer);

CommandsRegistry.registerCommand(OPEN_SERVICE_COMMAND, async (accessor, kind: unknown, id: unknown, name?: unknown) => {
	if (!isKind(kind) || typeof id !== 'string' || !id) {
		return;
	}
	const editorService = accessor.get(IEditorService);
	const instantiationService = accessor.get(IInstantiationService);
	const input = instantiationService.createInstance(OthcloudServiceInput, kind, id, typeof name === 'string' && name ? name : id);
	await editorService.openEditor(input, { pinned: true });
});
