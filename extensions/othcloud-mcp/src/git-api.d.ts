/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  Minimal local mirror of the vscode.git extension API surface used by this extension.
 *  Keep in sync with extensions/git/src/api/git.d.ts.
 *--------------------------------------------------------------------------------------------*/

import type { Uri, Event } from 'vscode';

export type RefType = 0 | 1 | 2;

export interface Ref {
	readonly type: RefType;
	readonly name?: string;
	readonly commit?: string;
	readonly remote?: string;
}

export interface UpstreamRef {
	readonly remote: string;
	readonly name: string;
	readonly commit?: string;
}

export interface Branch extends Ref {
	readonly upstream?: UpstreamRef;
	readonly ahead?: number;
	readonly behind?: number;
}

export type Status =
	| 0 | 1 | 2 | 3 | 4
	| 5 | 6 | 7 | 8 | 9 | 10 | 11
	| 12 | 13 | 14 | 15 | 16 | 17 | 18;

export interface Change {
	readonly uri: Uri;
	readonly originalUri: Uri;
	readonly renameUri: Uri | undefined;
	readonly status: Status;
}

export interface Remote {
	readonly name: string;
	readonly fetchUrl?: string;
	readonly pushUrl?: string;
	readonly isReadOnly: boolean;
}

export interface FetchOptions {
	remote?: string;
	ref?: string;
	all?: boolean;
	prune?: boolean;
	depth?: number;
}

/** Mirrors the git extension's ForcePushMode: 0 = Force, 1 = ForceWithLease, 2 = ForceWithLeaseIfIncludes. */
export type ForcePushMode = 0 | 1 | 2;

export interface InputBox {
	value: string;
}

export interface RepositoryState {
	readonly HEAD: Branch | undefined;
	readonly remotes: Remote[];
	readonly mergeChanges: Change[];
	readonly indexChanges: Change[];
	readonly workingTreeChanges: Change[];
	readonly untrackedChanges: Change[];
	readonly onDidChange: Event<void>;
}

export interface CommitOptions {
	all?: boolean | 'tracked';
	amend?: boolean;
	signoff?: boolean;
	signCommit?: boolean;
	empty?: boolean;
	noVerify?: boolean;
	requireUserConfig?: boolean;
	useEditor?: boolean;
	verbose?: boolean;
	postCommitCommand?: string | null;
}

export interface BranchQuery {
	readonly remote?: boolean;
	readonly pattern?: string;
	readonly count?: number;
	readonly contains?: string;
}

export interface Commit {
	readonly hash: string;
	readonly message: string;
	readonly parents: string[];
	readonly authorDate?: Date;
	readonly authorName?: string;
	readonly authorEmail?: string;
	readonly commitDate?: Date;
}

export interface LogOptions {
	readonly maxEntries?: number;
	readonly path?: string;
	readonly ref?: string;
}

export interface Repository {
	readonly rootUri: Uri;
	readonly inputBox: InputBox;
	readonly state: RepositoryState;
	add(paths: string[]): Promise<void>;
	revert(paths: string[]): Promise<void>;
	commit(message: string, opts?: CommitOptions): Promise<void>;
	diff(cached?: boolean): Promise<string>;
	diffWithHEAD(path: string): Promise<string>;
	getBranches(query: BranchQuery): Promise<Ref[]>;
	log(options?: LogOptions): Promise<Commit[]>;
	checkout(treeish: string): Promise<void>;
	createBranch(name: string, checkout: boolean, ref?: string): Promise<void>;
	fetch(options?: FetchOptions): Promise<void>;
	pull(unshallow?: boolean): Promise<void>;
	push(remoteName?: string, branchName?: string, setUpstream?: boolean, force?: ForcePushMode): Promise<void>;
}

export type APIState = 'uninitialized' | 'initialized';

export interface API {
	readonly state: APIState;
	readonly repositories: Repository[];
	getRepository(uri: Uri): Repository | null;
}

export interface GitExtension {
	readonly enabled: boolean;
	readonly onDidChangeEnablement: Event<boolean>;
	getAPI(version: 1): API;
}
