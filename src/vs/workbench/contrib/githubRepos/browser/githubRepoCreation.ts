/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';

// The `github` auth provider is owned by OthcloudGithubAuthProvider, which hands
// out the user's own GitHub token from othcloud.xyz, or failing that a short-lived
// GitHub App **installation token**. Repo creation therefore goes straight to the
// GitHub REST API with that token - no othcloud.xyz endpoint needed. Note an
// installation token can create repos under an org (`POST /orgs/{org}/repos`, app
// needs Administration:write) but not under a personal user account, so resolving
// and showing the owner matters.
const GITHUB_API = 'https://api.github.com';
const OTHCLOUD_GITHUB_PROVIDER_ID = 'github';

function githubHeaders(token: string): Record<string, string> {
	return {
		'Authorization': `Bearer ${token}`,
		'Accept': 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
	};
}

export interface IGithubOwner {
	readonly login: string;
	/** `User` or `Organization` (per GitHub's owner.type). */
	readonly type: string;
}

export interface ICreateRepoInput {
	readonly name: string;
	readonly description?: string;
	readonly private: boolean;
	/** Seed with an initial commit (README) so it clones cleanly. Defaults true. */
	readonly autoInit?: boolean;
}

export interface ICreatedRepo {
	readonly name: string;
	readonly fullName: string;
	readonly htmlUrl: string;
	readonly cloneUrl: string;
	readonly sshUrl?: string;
	readonly owner: string;
	readonly private: boolean;
	readonly defaultBranch?: string;
}

export class GithubApiError extends Error {
	constructor(public readonly status: number, message: string) {
		super(message);
		this.name = 'GithubApiError';
	}
}

/**
 * Resolves the GitHub token from the OTHCloud account and nothing else.
 *
 * GitHub access is a property of being signed in to OTHCloud - the website hands
 * us the user's GitHub token, or an installation token of their organization's
 * GitHub App - so there is deliberately no second GitHub login to perform here. Returns undefined
 * when the user is signed out of OTHCloud or has not linked GitHub there.
 */
export async function resolveGithubToken(authService: IAuthenticationService): Promise<string | undefined> {
	try {
		const sessions = await authService.getSessions(OTHCLOUD_GITHUB_PROVIDER_ID);
		return sessions[0]?.accessToken;
	} catch {
		// Provider not registered (or failed to activate).
		return undefined;
	}
}

/**
 * Figures out which GitHub account the token belongs to: the user for a token of
 * their own GitHub account, else the account the installation token's app is
 * installed on (e.g. the `OverTimeHosting` org vs a personal account), from its
 * repositories since installation tokens can't hit `/user`. Returns undefined
 * when it can't be determined (e.g. a brand-new installation with no repos).
 */
export async function resolveGithubOwner(token: string): Promise<IGithubOwner | undefined> {
	try {
		const user = await fetch(`${GITHUB_API}/user`, { headers: githubHeaders(token) });
		if (user.ok) {
			const data = await user.json() as { login?: string };
			if (data.login) {
				return { login: data.login, type: 'User' };
			}
		}
	} catch {
		// network / parse error - try the installation
	}
	try {
		const res = await fetch(`${GITHUB_API}/installation/repositories?per_page=1`, { headers: githubHeaders(token) });
		if (!res.ok) {
			return undefined;
		}
		const data = await res.json() as { repositories?: { owner?: { login?: string; type?: string } }[] };
		const owner = data.repositories?.[0]?.owner;
		if (owner?.login) {
			return { login: owner.login, type: owner.type ?? 'User' };
		}
	} catch {
		// network / parse error - fall through
	}
	return undefined;
}

export interface IRemoteRepo {
	readonly name: string;
	readonly fullName: string;
	readonly description?: string;
	readonly htmlUrl: string;
	readonly cloneUrl: string;
	readonly owner: string;
	readonly private: boolean;
	readonly updatedAt?: string;
}

/** The subset of GitHub's repository payload we actually read. */
interface IGithubRepoPayload {
	readonly name?: string;
	readonly full_name?: string;
	readonly description?: string | null;
	readonly html_url?: string;
	readonly clone_url?: string;
	readonly owner?: { readonly login?: string };
	readonly private?: boolean;
	readonly pushed_at?: string | null;
	readonly updated_at?: string | null;
}

function toRemoteRepo(raw: IGithubRepoPayload): IRemoteRepo | undefined {
	const { name, clone_url: cloneUrl } = raw;
	if (!name || !cloneUrl) {
		return undefined;
	}
	return {
		name,
		fullName: raw.full_name ?? name,
		description: raw.description ?? undefined,
		htmlUrl: raw.html_url ?? '',
		cloneUrl,
		owner: raw.owner?.login ?? '',
		private: !!raw.private,
		updatedAt: raw.pushed_at ?? raw.updated_at ?? undefined,
	};
}

/**
 * Lists the repositories the token can see, most recently pushed first.
 *
 * Two token shapes reach here and they need different endpoints: the
 * OTHCloud-proxied GitHub App **installation** token can only use
 * `/installation/repositories`, while a token from a direct GitHub sign-in
 * (the built-in `github` provider) can only use `/user/repos`. We try the
 * installation endpoint first and fall back, so both sign-in paths work.
 *
 * Pages are followed up to {@link MAX_REPO_PAGES} so large orgs still return
 * promptly rather than walking thousands of repos.
 */
const MAX_REPO_PAGES = 5;
const REPOS_PER_PAGE = 100;

export async function listGithubRepos(token: string): Promise<IRemoteRepo[]> {
	const collected: IRemoteRepo[] = [];

	const readPage = async (url: string): Promise<{ items: IGithubRepoPayload[]; ok: boolean; status: number }> => {
		const res = await fetch(url, { headers: githubHeaders(token) });
		if (!res.ok) {
			return { items: [], ok: false, status: res.status };
		}
		const data = await res.json() as IGithubRepoPayload[] | { repositories?: IGithubRepoPayload[] };
		// `/installation/repositories` nests under `repositories`; `/user/repos`
		// is a bare array.
		const items = Array.isArray(data) ? data : (data.repositories ?? []);
		return { items, ok: true, status: res.status };
	};

	const drain = async (build: (page: number) => string): Promise<boolean> => {
		for (let page = 1; page <= MAX_REPO_PAGES; page++) {
			const { items, ok, status } = await readPage(build(page));
			if (!ok) {
				// Only treat the very first page as a hard failure; a later page
				// erroring just means we return what we already have.
				if (page === 1) {
					if (status === 401 || status === 403 || status === 404) {
						return false;
					}
					throw new GithubApiError(status, `HTTP ${status}`);
				}
				break;
			}
			for (const raw of items) {
				const repo = toRemoteRepo(raw);
				if (repo) {
					collected.push(repo);
				}
			}
			if (items.length < REPOS_PER_PAGE) {
				break;
			}
		}
		return true;
	};

	const viaInstallation = await drain(page => `${GITHUB_API}/installation/repositories?per_page=${REPOS_PER_PAGE}&page=${page}`);
	if (!viaInstallation || collected.length === 0) {
		collected.length = 0;
		await drain(page => `${GITHUB_API}/user/repos?per_page=${REPOS_PER_PAGE}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`);
	}

	// Most recently pushed first - that is nearly always what you want to clone.
	collected.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
	return collected;
}

/**
 * Creates a repo on GitHub using the installation token. Org installs go through
 * `/orgs/{org}/repos`; anything else falls back to `/user/repos` (which an
 * installation token usually can't use - GitHub's error is surfaced verbatim).
 */
/** GitHub's create-repository response, plus the error shape it returns on failure. */
interface ICreateRepoPayload {
	readonly name: string;
	readonly full_name: string;
	readonly html_url: string;
	readonly clone_url: string;
	readonly ssh_url?: string;
	readonly owner?: { readonly login?: string };
	readonly private?: boolean;
	readonly default_branch?: string;
	readonly message?: string;
	readonly errors?: { readonly message?: string }[];
}

export async function createGithubRepo(token: string, owner: IGithubOwner, input: ICreateRepoInput): Promise<ICreatedRepo> {
	const path = owner.type === 'Organization' ? `/orgs/${owner.login}/repos` : '/user/repos';
	const res = await fetch(`${GITHUB_API}${path}`, {
		method: 'POST',
		headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: input.name,
			description: input.description,
			private: input.private,
			auto_init: input.autoInit ?? true,
		}),
	});

	const text = await res.text();
	let parsed: ICreateRepoPayload | undefined;
	try { parsed = text ? JSON.parse(text) as ICreateRepoPayload : undefined; } catch { parsed = undefined; }

	if (!res.ok) {
		const detail = parsed?.errors?.[0]?.message;
		const message = detail ?? parsed?.message ?? `HTTP ${res.status}`;
		throw new GithubApiError(res.status, message);
	}

	if (!parsed) {
		throw new GithubApiError(res.status, `GitHub returned an empty response for ${owner.login}.`);
	}

	return {
		name: parsed.name,
		fullName: parsed.full_name,
		htmlUrl: parsed.html_url,
		cloneUrl: parsed.clone_url,
		sshUrl: parsed.ssh_url,
		owner: parsed.owner?.login ?? owner.login,
		private: !!parsed.private,
		defaultBranch: parsed.default_branch,
	};
}
