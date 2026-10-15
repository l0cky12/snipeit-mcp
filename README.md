# snipeit-mcp

An [MCP](https://modelcontextprotocol.io) server for [Snipe-IT](https://snipeitapp.com) asset management. Gives Claude Code, OpenClaw, or any other MCP client the same reach you have in the Snipe-IT web UI: list, search, create, update, delete, check out, check in, audit and restore across every Snipe-IT object type.

Built on the MCP TypeScript SDK v2. Exposes **11 tools** (4 in read-only mode) so it stays cheap in your context window even on clients without tool search.

## Setup

Requires Node 20+ and a Snipe-IT personal API token (Snipe-IT: your avatar > *Manage API Keys*). The token carries the permissions of the account that created it, so use a superuser account if you want full admin reach.

```bash
npx -y snipeit-mcp setup
```

It asks for your Snipe-IT URL and token, validates them against the live instance, warns if the account is not a superuser, and saves them to `~/.config/snipeit-mcp/config.json` with owner-only permissions. You do this once; every MCP client on the machine reuses it.

Environment variables override the file: `SNIPEIT_URL`, `SNIPEIT_API_TOKEN`, and `SNIPEIT_READ_ONLY=1` (hides every write tool).

### Claude Code

```bash
claude mcp add -s user snipeit -- npx -y snipeit-mcp
```

### OpenClaw

```bash
openclaw mcp add snipeit --command npx --arg -y --arg snipeit-mcp
```

Or in `~/.openclaw/openclaw.json`:

```json
{ "mcp": { "servers": { "snipeit": { "command": "npx", "args": ["-y", "snipeit-mcp"] } } } }
```

### Any other MCP client (stdio)

Command `npx`, args `-y snipeit-mcp`. For a less-trusted agent add `SNIPEIT_READ_ONLY=1` to its environment.

## Tools

| Tool | What it does |
|---|---|
| `list` | List/search any resource. `user_id` returns what a person has checked out. `filters` passes resource-specific query params. |
| `get` | One record by id. |
| `lookup` | Resolve an asset tag, serial, username, email or employee number to a record. |
| `describe` | Fields accepted by create/update plus list filters. For hardware, also the instance's custom fields. |
| `create` | Create a record. Hardware custom fields can be passed by display name. |
| `update` | Partial update. |
| `delete` | Delete. Requires `confirm: true`. |
| `restore` | Restore a soft-deleted record. |
| `checkout` | Hardware to user/asset/location, accessories and consumables to user, components to asset, licenses to user/asset (first free seat). |
| `checkin` | Hardware by id; accessories/licenses from a user; components from an asset. |
| `audit` | Record an audit, optionally move the asset and set the next audit date. |

Resources: `hardware`, `users`, `licenses`, `accessories`, `consumables`, `components`, `locations`, `companies`, `categories`, `manufacturers`, `models`, `status_labels`, `suppliers`, `departments`, `groups`, `fields`, `fieldsets`, `maintenances`, `activity` (read-only audit log).

Responses are trimmed by default: nested date objects collapse to strings, nulls and `available_actions` are dropped, custom fields become `{name: value}`. Pass `raw: true` to `list`/`get` for the untouched payload.

## Development

```bash
npm install
npm test                        # build + unit tests, no Snipe-IT needed
bash test/snipeit-up.sh         # throwaway Snipe-IT in Docker with demo data (port 8765)
npm run test:integration        # end-to-end against it
docker compose -f test/docker-compose.yml down -v
```

## License

AGPL-3.0-only. Forks and hosted derivatives must stay open source.
