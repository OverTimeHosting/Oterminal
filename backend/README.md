# OTerminal — Developers backend

Go HTTP server backing the Developers panel inside the editor.

## Configuration

Environment variables:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `OTHCLOUD_ACCESS_TOKEN` | yes | — | Shared secret. Every request (including `/login` and `/register`) must send `X-Access-Token: <value>`. |
| `OTHCLOUD_JWT_SECRET` | yes | — | HMAC signing secret for session JWTs. |
| `OTHCLOUD_ADDR` | no | `:8787` | Listen address. |
| `OTHCLOUD_MONGO_URI` | no | dev cluster (in `main.go`) | MongoDB connection string. |
| `OTHCLOUD_MONGO_DB`  | no | `othcloud_terminal` | Database name. |
| `OTHCLOUD_CORS_ORIGIN` | no | `*` | Value used for `Access-Control-Allow-Origin`. |

## Run

```powershell
$env:OTHCLOUD_ACCESS_TOKEN = "let-me-in"
$env:OTHCLOUD_JWT_SECRET   = "change-this-to-a-long-random-string"
go run .
```

The first run creates the indexes on the configured MongoDB database.

## API surface

All endpoints require `X-Access-Token`. Authenticated endpoints additionally require `Authorization: Bearer <jwt>`.

Public:
- `POST /api/auth/register` — `{username, password}` → `{token, user}`
- `POST /api/auth/login` — `{username, password}` → `{token, user}`
- `GET  /api/auth/me` — current user (auth required)

Tasks (auth required):
- `GET  /api/tasks` — list visible tasks (creator or assignee)
- `POST /api/tasks` — `{title, description, assigneeUsername?}`
- `GET  /api/tasks/{id}` — task with checklist + members
- `PATCH /api/tasks/{id}` — `{title?, description?, status?}`

Per-task subresources (auth required):
- `GET  /api/tasks/{id}/messages`
- `POST /api/tasks/{id}/messages` — `{body}`
- `GET  /api/tasks/{id}/checklist`
- `POST /api/tasks/{id}/checklist` — `{label}` (creator only)
- `PATCH /api/tasks/{id}/checklist/{itemId}` — `{done}`
- `GET  /api/tasks/{id}/activity`
