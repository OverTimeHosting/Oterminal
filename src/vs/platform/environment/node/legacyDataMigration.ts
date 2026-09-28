/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from '../../../base/common/path.js';

/**
 * OTerminal shipped as "othcloud terminal" until 1.110.26. Its user data
 * folder is named after `nameShort` and its extensions/argv folder after
 * `dataFolderName`, so the rename left both behind:
 *
 * - `<appData>/othcloud terminal` -> `<appData>/OTerminal`
 * - `~/.othcloud-terminal`        -> `~/.oterminal`
 *
 * 1.110.26 already started from an empty `<appData>/OTerminal`. That folder
 * is kept next to the migrated one as `OTerminal.before-migration-<time>`.
 */
const LEGACY_NAME_SHORT = 'othcloud terminal';
const LEGACY_DATA_FOLDER_NAME = '.othcloud-terminal';

/** Written into a folder once it has been migrated, or found nothing to migrate. */
const MARKER = '.migrated-from-othcloud-terminal';

/**
 * Moves the legacy folders into place. Must run before anything reads from
 * either folder (argv.json is read very early in main.ts). Never throws: a
 * failed move (e.g. files still locked by an old instance on Windows) is
 * retried on the next start.
 */
export function migrateLegacyDataFolders(userDataPath: string, product: { nameShort: string; dataFolderName: string }): void {
	// Only the default location follows the product name; --user-data-dir and
	// portable mode point somewhere the user chose.
	if (basename(userDataPath) === product.nameShort && product.nameShort !== LEGACY_NAME_SHORT) {
		migrateFolder(join(dirname(userDataPath), LEGACY_NAME_SHORT), userDataPath);
	}
	if (product.dataFolderName !== LEGACY_DATA_FOLDER_NAME) {
		migrateFolder(join(homedir(), LEGACY_DATA_FOLDER_NAME), join(homedir(), product.dataFolderName));
	}
}

function migrateFolder(legacy: string, target: string): void {
	try {
		if (fs.existsSync(join(target, MARKER))) {
			return;
		}
		if (!fs.existsSync(legacy)) {
			// Nothing to bring over. Mark the folder so a legacy folder that
			// shows up later (an old build run again) never replaces it.
			if (fs.existsSync(target)) {
				writeMarker(target, 'nothing to migrate');
			}
			return;
		}

		let backup: string | undefined;
		if (fs.existsSync(target)) {
			backup = `${target}.before-migration-${Date.now()}`;
			fs.renameSync(target, backup);
		}
		try {
			fs.renameSync(legacy, target);
		} catch (err) {
			if (backup) {
				fs.renameSync(backup, target);
			}
			throw err;
		}
		writeMarker(target, `moved from ${legacy}${backup ? `, previous contents kept in ${backup}` : ''}`);
	} catch (err) {
		console.error(`Could not move ${legacy} to ${target}, will retry on next start:`, err);
	}
}

function writeMarker(folder: string, detail: string): void {
	fs.writeFileSync(join(folder, MARKER), `${new Date().toISOString()} ${detail}\n`);
}
