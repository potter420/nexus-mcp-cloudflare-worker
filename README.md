# nexus-mcp

Read-only Nexus Mods MCP server on a Cloudflare Worker, for use as a claude.ai custom connector.

- **Transport:** stateless Streamable HTTP (`agents/mcp/server` + MCP SDK v2). No Durable Objects, no storage.
- **Worker auth:** unguessable path segment — the endpoint is `/mcp/<PATH_TOKEN>`; every other path is 404.
- **Nexus auth:** your personal API key, held as a Worker secret, sent only to `api.nexusmods.com`, never returned.
- **Writes:** none. The raw GraphQL tool rejects `mutation`/`subscription`.

## Tools

| Tool | Source | Use |
|---|---|---|
| `search_mods` | GraphQL v2 | Find mods by name, sorted by endorsements/downloads |
| `get_mod` | REST v1 | Full description page (BBCode stripped) — where authors list compat & patches |
| `get_mod_requirements` | GraphQL v2 | The declared Nexus "Requirements" list |
| `get_mod_files` | REST v1 | Main/optional/patch files with descriptions |
| `search_collections` | GraphQL v2 | Curated mod lists |
| `graphql_query` | GraphQL v2 | Read-only escape hatch + introspection |

REST v1 is documented and stable. GraphQL v2 is undocumented; the queries here are taken from working open-source clients, and `graphql_query` lets Claude introspect and adapt if a field moves.

## Deploy

```sh
npm ci
npx wrangler login

# 1. Path token — this is the connector's password
openssl rand -hex 32            # copy the output
npx wrangler secret put PATH_TOKEN      # paste it

# 2. Nexus personal API key
#    https://www.nexusmods.com/users/myaccount?tab=api%20access → Personal API Key
npx wrangler secret put NEXUS_API_KEY

# 3. Ship
npx wrangler deploy             # prints https://nexus-mcp.<your-subdomain>.workers.dev
```

Secrets created before the first deploy: `wrangler secret put` will offer to create the Worker; say yes.

### Smoke test

```sh
U="https://nexus-mcp.<sub>.workers.dev/mcp/<PATH_TOKEN>"
curl -s -X POST "$U" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_mod","arguments":{"mod_id":183621}}}'
```

You should see the mod's name and description. A 404 means the token in the URL doesn't match.

## Add to claude.ai

1. Settings → Connectors → **Add custom connector**
2. Name: `Nexus Mods`; URL: `https://nexus-mcp.<sub>.workers.dev/mcp/<PATH_TOKEN>`
3. Leave OAuth fields empty → **Add**
4. In a chat, open the tools/connectors menu and make sure it's toggled on.

## Security notes

- The full URL is a bearer secret. Anyone holding it can spend your Nexus API quota (read-only; they can't see the key). Rotate: `wrangler secret put PATH_TOKEN` with a new value, then edit the connector URL.
- `observability` is on in `wrangler.jsonc`, so request paths (including the token) land in your own Workers Logs. Set it to `false` if you'd rather not.
- Want real auth instead of a URL secret? Swap the path check for `@cloudflare/workers-oauth-provider` with GitHub login restricted to your account; claude.ai's connector supports OAuth.
- Nexus rate limits apply to your key (daily + hourly). REST responses are edge-cached for 10 minutes to stay well under them.

## Local dev

```sh
printf 'NEXUS_API_KEY=...\nPATH_TOKEN=%s\n' "$(openssl rand -hex 32)" > .dev.vars
npm run dev       # http://localhost:8787/mcp/<PATH_TOKEN>
npm run typecheck
```
