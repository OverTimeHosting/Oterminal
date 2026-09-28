/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CredentialsProvider, Credentials, API as GitAPI } from './typings/git.js';
import { workspace, Uri, Disposable } from 'vscode';
import { getSession } from './auth.js';

const EmptyDisposable: Disposable = { dispose() { } };

class GitHubCredentialProvider implements CredentialsProvider {

	async getCredentials(host: Uri): Promise<Credentials | undefined> {
		if (!/github\.com/i.test(host.authority)) {
			return;
		}

		let session;
		try {
			session = await getSession();
		} catch {
			// No GitHub session (declined, or OTHCloud has none): let git carry on without
			// one, e.g. for a public repository, rather than failing the operation here
			return undefined;
		}
		// Installation tokens (ghs_) only authenticate as this username; any works for others
		const username = session.accessToken.startsWith('ghs_') ? 'x-access-token' : session.account.label;
		return { username, password: session.accessToken };
	}
}

export class GithubCredentialProviderManager {

	private providerDisposable: Disposable = EmptyDisposable;
	private readonly disposable: Disposable;

	private _enabled = false;
	private set enabled(enabled: boolean) {
		if (this._enabled === enabled) {
			return;
		}

		this._enabled = enabled;

		if (enabled) {
			this.providerDisposable = this.gitAPI.registerCredentialsProvider(new GitHubCredentialProvider());
		} else {
			this.providerDisposable.dispose();
		}
	}

	constructor(private gitAPI: GitAPI) {
		this.disposable = workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('github')) {
				this.refresh();
			}
		});

		this.refresh();
	}

	private refresh(): void {
		const config = workspace.getConfiguration('github', null);
		const enabled = config.get<boolean>('gitAuthentication', true);
		this.enabled = !!enabled;
	}

	dispose(): void {
		this.enabled = false;
		this.disposable.dispose();
	}
}
