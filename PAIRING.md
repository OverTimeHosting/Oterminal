# Othcloud Desktop Pairing Contract

This document describes the handshake between **othcloud.xyz** (the Next.js +
tRPC monorepo) and **OTerminal** (this desktop client) for linking a
logged-in browser session to the desktop app.

It is the source of truth for what each side must implement. Once both sides
match this contract, the desktop sidebar (`Othcloud` in the activity bar)
lights up automatically.

## High-level flow

```
┌──────────────┐         ┌──────────────────┐         ┌────────────────────┐
│ othcloud.xyz │  (1)    │   User's browser │   (2)   │  othcloud-terminal │
│ (Next.js)    │ ──────▶ │  (or in-editor   │ ──────▶ │   (Electron app)   │
│              │ pair    │   BrowserView)   │ deep    │                    │
│              │ code    │                  │ link    │                    │
└──────┬───────┘         └──────────────────┘         └─────────┬──────────┘
       │                                                        │
       │ (3) POST /api/desktop/token { code }                   │
       │ ◀──────────────────────────────────────────────────────│
       │                                                        │
       │     200 { token, user }                                │
       │ ──────────────────────────────────────────────────────▶│
       │                                                        │
       │ (4) Sidebar uses token for all subsequent calls         │
```

1. **User clicks "Open in OTerminal"** on othcloud.xyz (while
   logged in via the regular session cookie).
2. **Website redirects the browser to `othcloud-terminal://auth?code=<code>`**.
   The OS routes this URL to the running desktop app via the
   `othcloud-terminal://` protocol handler.
3. **Desktop exchanges the code** for a real token by `POST`ing to
   `/api/desktop/token`. Codes are single-use and short-lived.
4. **Desktop stores the token** in OS-level secret storage and uses it as a
   `Bearer` token for all subsequent requests.

## Endpoints to implement on othcloud.xyz

All endpoints accept and return JSON. Errors should respond with
`{ "error": "<human-readable message>" }` and a non-2xx status.

### `POST /api/desktop/pair`

**Auth:** session cookie (the user must already be logged in via the website).

**Body:** empty (`{}`).

**Response:** `200 OK`
```json
{
  "code": "ya29-aBcD...EfGh",
  "expiresAt": "2026-05-12T12:35:00.000Z"
}
```

**Behavior:**
- Generate a cryptographically random opaque code (≥128 bits of entropy).
- Store it server-side keyed to the current user, with an expiry of
  **≤2 minutes** from issuance.
- The code is single-use: once `/api/desktop/token` succeeds, delete it.

The website's "Open in OTerminal" button calls this, then sets
`window.location.href = "othcloud-terminal://auth?code=" + encodeURIComponent(code)`.

### `POST /api/desktop/token`

**Auth:** none (the code itself is the credential).

**Body:**
```json
{ "code": "ya29-aBcD...EfGh" }
```

**Response:** `200 OK`
```json
{
  "token": "<long-lived bearer token>",
  "user": {
    "id": "usr_01HF...",
    "email": "florian.nemeti11@gmail.com",
    "name": "Florian Nemeti",
    "avatarUrl": "https://..."   // optional
  }
}
```

**Behavior:**
- Look up the code; reject with `400` if it is unknown, already used, or
  expired.
- Delete the code (single-use).
- Mint a long-lived API token tied to this user. The token must also be
  accepted by:
  - `GET /api/desktop/me`
  - any `/api/desktop/services/*` endpoints (Phase 2)
  - the SSH terminal WebSocket and game-console WebSocket
    (`apps/othcloud/server/server.ts`) — so the desktop client can open a
    real terminal pty against the user's VPS / game server without a session
    cookie.

**Token format:** the desktop side treats it as an opaque string. A JWT or
`Authorization: Bearer <token>` against a tokens table both work. Recommended:
store a SHA-256 hash on the server, hand the user the raw value once, and
include token metadata (name="OTerminal", createdAt, lastUsedAt).

### `GET /api/desktop/me`

**Auth:** `Authorization: Bearer <token>`.

**Response:** `200 OK`
```json
{
  "id": "usr_01HF...",
  "email": "florian.nemeti11@gmail.com",
  "name": "Florian Nemeti",
  "avatarUrl": "https://..."
}
```

**Behavior:**
- Validates the token. On `401`, the desktop signs the user out and re-prompts.
- Used on app start to confirm the cached token is still good.

### `GET /api/desktop/profiles`

**Auth:** `Authorization: Bearer <token>`.

**Response:** `200 OK`
```json
{
  "profiles": [
    {
      "id": "dtp_aBcD...",
      "name": "claude",
      "platform": "all",
      "path": "claude",
      "args": ["--dangerously-skip-permissions"],
      "env": null,
      "icon": "sparkle",
      "color": "terminal.ansiMagenta",
      "sortOrder": 0,
      "updatedAt": "2026-09-26T20:00:00.000Z"
    }
  ]
}
```

**Behavior:**
- Returns every terminal profile the user keeps on othcloud.xyz, across all
  platforms. `platform` is one of `all`, `linux`, `osx`, `windows`.
- The desktop writes the ones matching its platform (or `all`) into
  `terminal.integrated.profiles.<platform>` on start-up, after sign-in, and on
  "Sync Terminal Profiles from OTHCloud". They then show up wherever the
  built-in profiles do: the "+" dropdown and the New Terminal submenu of the
  terminal context menus.
- Profiles a previous sync added and that are no longer returned are removed
  from the local settings again. Profiles the user defined locally are never
  touched. Signing out removes every synced profile.
- Managed on the website under account settings → Preferences → Terminal
  profiles.

### `POST /api/desktop/profiles`

**Auth:** `Authorization: Bearer <token>`.

**Body:** the profile without `id`/`updatedAt` (see above). `name` and `path`
are required; `args`, `env`, `icon`, `color` are optional; `platform`
defaults to `all`.

**Response:** `201 Created` with the stored profile, or `200 OK` when a
profile with the same `name` and `platform` already existed and was replaced.
`400 { "error": "invalid_profile", "issues": [...] }` on validation errors.

Used by the desktop's "Save Terminal Profile to OTHCloud..." command, which
uploads one of the locally configured profiles.

### `DELETE /api/desktop/profiles/<id>`

**Auth:** `Authorization: Bearer <token>`.

**Response:** `200 { "ok": true }`, or `404 { "error": "not_found" }` when
the profile does not exist or belongs to someone else.

Used by the desktop's "Remove Terminal Profile from OTHCloud..." command.

### GitHub repository creation (desktop-side, no new endpoint)

The **GitHub Repos** sidebar can create repositories directly. It does **not**
need a dedicated othcloud.xyz endpoint: the `githubRepos.createOnGithub` action
reuses the `github` auth session (the GitHub App installation token proxied by
`/api/desktop/github-token`) and calls the GitHub REST API itself:

- `GET https://api.github.com/installation/repositories` → resolve and display
  which account/org the link belongs to (e.g. `OverTimeHosting` vs a personal
  account).
- `POST https://api.github.com/orgs/{org}/repos` (org installs) to create the
  repo, then clones it locally (credentials flow through the `github` provider)
  and adds it to the sidebar list.

Because an installation token can only create repos under an **organization**
(not a personal user account), the action surfaces the resolved owner so the
user knows where the repo will land.

## Embedded (web) sign-in — no pairing at all

The flow above needs a protocol handler and a native window. The **web build**
(`othcloud-terminal-server-web-*`, which othcloud.xyz runs next to a customer's
website for the Editor tab) has neither, so the sidebar there could only ever
show a "Sign in" button with nowhere to go — to someone who is demonstrably
already signed in, since they are looking at the editor *through* their
othcloud.xyz session.

So when othcloud.xyz is the one serving the workbench, it hands the session
over directly.

### `GET <serverBasePath>/__othcloud/session`

**Served by:** othcloud.xyz's editor proxy, NOT by this server. The workbench
is mounted at `/_editor/<composeId>/` behind a proxy that authenticates every
request against the panel session, so this path never reaches the container.

**Auth:** the panel's own session cookie, same-origin. There is no bearer to
send yet — that is the point.

**Response:** `200 OK`
```json
{
  "token": "<bearer, as minted by /api/desktop/token>",
  "user": { "id": "...", "email": "...", "name": "...", "avatarUrl": "...", "isOwner": true },
  "baseUrl": ""
}
```

`baseUrl` is where the client should send `/api/desktop/*` calls. The empty
string means "same origin as this workbench" — necessary because the web build
has no environment to read (`base/common/process` hardcodes `env` to `{}` in
web), so its compiled-in default is always `https://othcloud.xyz`, which is
wrong for every other panel including localhost.

**`204 No Content`** for anything else — not signed in, not their website,
couldn't mint. The client treats it as "carry on signed out"; a 401 would be
noise, since the page it is rendering in only exists because the panel already
authenticated the person.

**Behavior:**
- The token is a normal `desktop_token` row, but with `expires_at` set (12h)
  and `name = "Othcloud Editor (web)"`. It is short-lived because it is handed
  to a BROWSER and lives in IndexedDB where script can read it, unlike the
  desktop app's, which sits in OS secret storage. It can afford to be: the
  editor seeds a fresh one every time it is opened.
- Scoped to the VIEWER, not the container. Two people with access to the same
  website get their own identity, and nothing is written to the customer's box.
- Minting also prunes that user's expired/revoked web-editor tokens.

Client side: `OthcloudEmbeddedSession`
(`src/vs/workbench/contrib/othcloudAccount/browser/othcloudEmbeddedSession.ts`),
registered at `WorkbenchPhase.BlockRestore` so the sidebar doesn't render the
signed-out card first and swap it underneath the user. Web only — desktop pairs
properly and has a real token already.

## Deep-link format

The desktop registers a system-level handler for the `othcloud-terminal://`
scheme (declared in `product.json`, `urlProtocol`). The website should emit:

```
othcloud-terminal://auth?code=<urlencoded pair code>
```

Any other path / authority is ignored by the desktop URL handler
(`OthcloudAccountUrlHandler`). The query is parsed manually (not via
`URLSearchParams`) to avoid double-decoding opaque codes that contain `+`.

## Security notes

- **Codes must be one-shot and short-lived.** A long-lived code is
  effectively a sharable login link.
- **The code endpoint requires an authenticated session.** Otherwise anyone
  can mint a code → exchange → token without ever logging in.
- **Use HTTPS-only on the website.** The `othcloud-terminal://` URL itself
  is local IPC so doesn't need TLS, but the `/api/desktop/*` endpoints do.
- **Token revocation:** Phase 4 polish will add a `DELETE /api/desktop/token`
  endpoint that the desktop calls on sign-out and a "Devices" page on the
  website that lists active desktop tokens.

## Phase 1 acceptance test

1. Run the desktop client. The activity bar shows a cloud icon labeled
   *Othcloud*. The sidebar reads "Sign in to othcloud" with a CTA button.
2. Click the CTA. The embedded browser opens `https://othcloud.xyz`.
3. Log in on the website (or already logged in).
4. Click "Open in OTerminal" on the website dashboard.
5. The website hits `/api/desktop/pair`, gets a code, and redirects to
   `othcloud-terminal://auth?code=...`.
6. The desktop catches the URL, exchanges the code at `/api/desktop/token`,
   stores the token, and the sidebar swaps to the signed-in header with the
   user's name + email and four "Coming soon" sections.
7. Quit and relaunch the desktop. The sidebar remains signed-in (the token is
   persisted in OS secret storage; the user profile in workspace storage).
8. Run command **"Othcloud: Sign out of Othcloud"** from the command palette.
   The sidebar reverts to the signed-out state.
