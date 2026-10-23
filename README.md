# nexus-mcp

Read-only Nexus Mods MCP server on a Cloudflare Worker, for use as a claude.ai custom connector.

```
claude.ai ──OAuth──▶ Cloudflare Access (Managed OAuth) @ nexus-mcp-worker.lakehaus.ai
          ──Cf-Access-Jwt-Assertion──▶ Worker /mcp ──apikey──▶ api.nexusmods.com
```

- **Transport:** stateless Streamable HTTP (`agents/mcp/server` + MCP SDK v2). No Durable Objects, no storage.
- **Worker auth:** Cloudflare Access fronts the custom domain. The Worker *also* verifies the Access JWT itself (RS256 signature against the team JWKS, `iss`, `aud`, `exp`, email allowlist). `workers_dev` and `preview_urls` are off, so there is no route around Access.
- **Nexus auth:** your personal API key, held as a Worker secret, sent only to `api.nexusmods.com`, never returned.
- **Writes:** none. The raw GraphQL tool rejects `mutation`/`subscription`.

| Request | Response |
|---|---|
| Missing config (e.g. `ACCESS_AUD` empty) | 500 |
| Wrong host, or path other than `/mcp` | 404 |
| Missing / invalid / wrong-aud / non-allowlisted Access JWT | 403 |
| Valid Access JWT on `POST /mcp` | MCP |

## Tools

| Tool | Source | Use |
|---|---|---|
| `search_mods` | GraphQL v2 | Find mods by name, sorted by endorsements/downloads |
| `get_mod` | REST v1 | Full description page (BBCode stripped), where authors list compat & patches |
| `get_mod_requirements` | GraphQL v2 | The declared Nexus "Requirements" list |
| `get_mod_files` | REST v1 | Main/optional/patch files with descriptions |
| `search_collections` | GraphQL v2 | Curated mod lists |
| `graphql_query` | GraphQL v2 | Read-only escape hatch + introspection |

REST v1 is documented and stable. GraphQL v2 is undocumented; the queries here are taken from working open-source clients, and `graphql_query` lets Claude introspect and adapt if a field moves.

## Config

`wrangler.jsonc` holds the non-secret config:

| Var | Value |
|---|---|
| `routes[0].pattern` / `MCP_HOSTNAME` | `nexus-mcp-worker.lakehaus.ai` (must match) |
| `ACCESS_TEAM_DOMAIN` | `https://lakehausai.cloudflareaccess.com` |
| `ACCESS_AUD` | AUD tag of the Access app (filled in at step 2 below) |
| `ALLOWED_EMAILS` | `thanhmt0612@gmail.com` (comma-separated; empty = any identity Access lets through) |

The one secret is `NEXUS_API_KEY`.

## Deploy

Do these in order.

1. **Ship the Worker.**
   ```sh
   bun ci
   bunx wrangler login
   # https://www.nexusmods.com/users/myaccount?tab=api%20access → Personal API Key
   bunx wrangler secret put NEXUS_API_KEY
   bun run deploy
   ```
   With `ACCESS_AUD` still empty, the Worker answers **500** to everything. That's expected.

2. **Create the Access app.** Zero Trust → Access → Applications → Add → **Self-hosted**.
   - Domain: `nexus-mcp-worker.lakehaus.ai`, path empty (whole host).
   - Policy: Allow, Include → Emails → `thanhmt0612@gmail.com`.
   - Copy the **Application Audience (AUD) tag** into `ACCESS_AUD` in `wrangler.jsonc`, then `bun run deploy` again.

3. **Enable Managed OAuth.** In the app's Advanced settings, turn on **Managed OAuth** with dynamic client registration.
   - Allowed redirect URI: `https://claude.ai/api/mcp/auth_callback`
   - Access token lifetime: 15 min. Grant session: 1–2 weeks.

4. **Check Access covers the host.**
   ```sh
   curl -si -X POST https://nexus-mcp-worker.lakehaus.ai/mcp | head -20
   ```
   You want a **401 from Access** with a `WWW-Authenticate` header. A **403** means the request reached the Worker, so Access isn't in front of the host.

5. **Add to claude.ai.** Settings → Connectors → **Add custom connector**.
   - Name: `Nexus Mods`. URL: `https://nexus-mcp-worker.lakehaus.ai/mcp`.
   - Connect, sign in through Access, then toggle the connector on in a chat.

If step 5 can't complete the OAuth handshake, see the fallback in `CLAUDE.md` (Worker-as-OAuth-server with an Access for SaaS OIDC app).

## Security notes

- Two layers: Access must let the request through, and the Worker re-verifies the JWT. A misconfigured Access app fails closed (403), not open.
- `NEXUS_API_KEY` never appears in responses, logs, or cache keys. REST responses are edge-cached for 10 minutes under credential-free keys to stay under Nexus rate limits (daily + hourly, per key).
- `observability` is on. Logs show `/mcp` paths and status codes; there is no secret in the URL anymore.

## Local dev & tests

```sh
bun run typecheck   # tsc --noEmit, must be clean
bun run test:auth   # fake Access issuer + wrangler dev; expects 403×4, 200 (6 tools), 404. Exit 0 = PASS
```

`test:auth` uses its own temporary env file and ports 8787/8788; it doesn't touch `.dev.vars`.

For `bun run dev` you need a `.dev.vars` (gitignored). `wrangler dev` rewrites the Host header to the route pattern, so `MCP_HOSTNAME` must stay `nexus-mcp-worker.lakehaus.ai`. You'll also need a real Access JWT in `Cf-Access-Jwt-Assertion`, or point `ACCESS_TEAM_DOMAIN` at `test/fake-access.mjs`.
