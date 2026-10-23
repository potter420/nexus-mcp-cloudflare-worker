# CLAUDE.md — nexus-mcp

Read-only Nexus Mods MCP server on a Cloudflare Worker, used as a claude.ai custom connector. Its job is to let Claude research mods (descriptions, requirements, patches, collections) while building a Skyrim SE mod list. It is personal infrastructure: one user, one Nexus API key.

```
claude.ai ──OAuth──▶ Cloudflare Access (Managed OAuth) @ <custom domain>
          ──Cf-Access-Jwt-Assertion──▶ Worker /mcp ──apikey──▶ api.nexusmods.com
```

## Current state

- **v0.1 (superseded):** auth was an unguessable path segment `/mcp/<PATH_TOKEN>` on workers.dev. If you still see `PATH_TOKEN`, `safeEqual`, or `workers_dev` unset in the repo, that's v0.1. Migrate it to v0.2.
- **v0.2 (target, this repo):** Cloudflare Access fronts a custom domain. The Worker verifies the Access JWT itself. `workers_dev: false` and `preview_urls: false` are set so there is no route around Access. The local test harness passes.
- **Not yet verified live:** the claude.ai ⇄ Access Managed OAuth handshake. Nexus GraphQL shapes were confirmed live (see Nexus API notes); REST v1 tools still need a smoke test with the real key.

## Commands

```sh
bun ci
bun run typecheck      # tsc --noEmit, must be clean
bun run test:auth      # fake Access issuer + wrangler dev; asserts 403/403/403/403/200/404 + 6 tools. Exit 0 = PASS
bun run dev            # needs .dev.vars (gitignored)
bun run deploy
```

Run `typecheck` and `test:auth` before every commit.

## Layout

- `src/index.ts`: the whole server. It has four parts: the Nexus I/O helpers (`rest`, `gql`), the tool registrations (`buildServer`), Access verification (`verifyAccess`), and the Worker `fetch`.
- `wrangler.jsonc`: custom-domain route, vars (`MCP_HOSTNAME`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ALLOWED_EMAILS`). There's one secret, `NEXUS_API_KEY`, set via `wrangler secret put`.
- `test/fake-access.mjs`: generates an RS256 keypair, serves `/cdn-cgi/access/certs` on :8788, and writes good, forged, wrong-aud, and wrong-email tokens.
- `test/run-auth-test.sh`: the end-to-end auth test.
- `README.md`: human setup guide (Access app, Managed OAuth, claude.ai connector).

## Non-negotiables

1. **Read-only.** No tool may change anything on Nexus (endorse, track, upload, download links). `graphql_query` must keep rejecting `mutation` and `subscription`.
2. **Fail closed.** Missing config returns 500. A missing or invalid Access assertion returns 403. A wrong host or a path other than `/mcp` returns 404. Never add a bypass, debug route, or "skip auth in dev" flag.
3. **No side doors.** Keep `workers_dev: false` and `preview_urls: false`. The custom domain stays the only route.
4. **Key never leaves.** `NEXUS_API_KEY` goes only to `api.nexusmods.com`. It never appears in responses, logs, or cache keys.
5. **Verify the JWT, don't trust the edge.** Check RS256 signature against `<team>/cdn-cgi/access/certs`, plus `iss`, `aud` (the app's AUD tag), `exp`, and the optional email allowlist.
6. **Minimal, pinned dependencies.** Exact versions only (no `^`). The current runtime deps are `agents`, `@modelcontextprotocol/server`, `zod`, and `jose`. A new dependency needs a one-line justification in the commit message.
7. **Bounded output.** Tool results are capped at 20k chars (`MAX_TEXT`) and serialized as compact JSON (no indent). Keep responses lean, because they land in a model's context.

## Cloudflare / MCP SDK notes

- Use `createMcpHandler` from **`agents/mcp/server`**, with `McpServer` from **`@modelcontextprotocol/server`** (MCP SDK v2). Don't mix in `agents/mcp` or `@modelcontextprotocol/sdk`, because that's the legacy v1 path.
- The handler takes a **factory**, and the server is built per request. Never hoist `McpServer` to module scope.
- Options in use: `route: "/mcp"`, `allowedHostnames: [MCP_HOSTNAME]`, `corsOptions: false` (no browser clients), and `authContext.props.user` (the verified email).
- Use `registerTool(name, { inputSchema: z.object({...}), annotations }, cb)`. The raw-shape form is deprecated.

## Nexus API notes

- Send these headers on every call: `apikey`, `application-name`, `application-version`, `user-agent`.
- **REST v1 is documented and stable.** `get_mod` uses `GET /v1/games/{game}/mods/{id}.json`. `get_mod_files` uses `/v1/games/{game}/mods/{id}/files.json`. Both are edge-cached for 10 minutes via `caches.default`.
- **GraphQL v2 (`/v2/graphql`) is undocumented.** Shapes below were **confirmed live by introspection + real queries (Oct 2026)**. Introspection works without an API key; a *wrong* key gets 401.
  - **Live shapes:**
    - `game(domainName: String) { id }` → skyrimspecialedition = `1704`. Used to resolve domain → numeric id (cached per isolate in `resolveGameId`).
    - `mods(filter: ModsFilter, sort: [ModsSort!], count, offset) { totalCount nodes { modId name summary version uploader{name} endorsements downloads updatedAt } }`, filter `{ gameDomainName: [{value, op: EQUALS}], name: [{value, op: WILDCARD}] }`. WILDCARD is already a case-insensitive substring match: `"address library"` works, `"*skyui*"` returns **nothing**. Values under 2 chars error. Sort keys `endorsements` and `downloads` both work (also `updatedAt`, `createdAt`, `name`, `relevance`, ...).
    - `mod(modId: ID!, gameId: ID!)`: **numeric game id, not domain**; ids are passed as strings. Unknown mod → GraphQL error `Mod not found`.
    - `Mod.modRequirements(skipDisabledRequirements) { nexusRequirements(offset,count) { totalCount nodes { modId modName gameId externalRequirement notes url } } dlcRequirements { notes gameExpansion { name } } modsRequiringThisMod(offset,count) { totalCount nodes { modId modName gameId url } } }`. External requirements have `modId "0"` and a real `url`; Nexus ones have `url: ""`.
    - `collectionsV2(filter: CollectionsSearchFilter, sort: [CollectionsSearchSort!], count, offset) { totalCount nodes { slug name summary endorsements totalDownloads } }`, filter `{ gameDomain: [{value, op: EQUALS}], name: [{value, op: WILDCARD}] }` (arrays). Omit `name` for "top collections": an empty WILDCARD value errors. Adult collections are included by default.
    - Alternative single-call lookup: `legacyModsByDomain(ids: [{ gameDomain, modId: Int }]) { nodes { ... } }` (returns empty nodes for unknown ids). Not used; `legacy` naming suggests deprecation.
  - **Wrong / removed (don't use):**
    - ~~`Mod.uploadedAt`~~ → doesn't exist; use `updatedAt` (or `createdAt`).
    - ~~root `modRequirements(modId, gameDomainName)`~~ → removed; it's now a field on `Mod`, reached via `mod(modId, gameId)`.
    - ~~root `collections(...)`~~ → removed; use `collectionsV2`. ~~`Collection.downloads`~~ → use `totalDownloads` / `uniqueDownloads`.
  - If a GraphQL tool errors, introspect **one type per call** with `__type(name: "X") { fields { name } }` (or `inputFields` for filters) through `graphql_query`, then fix the query. Don't guess field names, and don't dump `__schema` (it blows the 20k cap).
- Rate limits are per key (daily plus hourly). Don't add tools that fan out into many calls per invocation.

## Gotchas found the hard way

- **`wrangler dev` rewrites the request Host to the route pattern.** Locally, `request.url` shows `nexus-mcp.example.com`, not `localhost`. `MCP_HOSTNAME` in `.dev.vars` must match `routes[0].pattern`, or everything returns 404.
- **`bunx wrangler` orphans its children.** Killing the `bunx` PID leaves `node wrangler` and `workerd` holding :8787. The next run then hangs or hits a stale isolate. The harness uses `setsid` and kills the whole process group. Copy that pattern for anything else that spawns wrangler.
- **Stale JWKS.** `jose`'s remote JWKS is cached per isolate. If a test issuer restarts with new keys while an old `wrangler dev` is still up, valid tokens fail with "signature verification failed". Check for leftover processes before debugging the code.
- **`pgrep -f <pattern>` / `pkill -f` can match your own shell** when the pattern appears in the command line. Prefer PIDs or process groups.
- **Always pass `--max-time` to curl** in scripts. A half-dead dev server otherwise blocks forever.

## Deploy checklist

Do these in order. README has the details.

1. Fill `wrangler.jsonc`: hostname (in both `routes` and `MCP_HOSTNAME`), team domain, and `ALLOWED_EMAILS`. Then run `wrangler secret put NEXUS_API_KEY` and `wrangler deploy`. At this point `ACCESS_AUD` is empty, so the Worker returns 500 (missing config) to everything, which is correct.
2. In Zero Trust, create a **Self-hosted** Access app on the whole host (empty path), with an Allow policy for the owner's email. Copy the AUD tag into `ACCESS_AUD` and redeploy.
3. In the app's Advanced settings, turn on **Managed OAuth** and dynamic client registration, with allowed redirect URI `https://claude.ai/api/mcp/auth_callback`. Set access token lifetime to 15 min and grant session to 1–2 weeks.
4. Check that `curl -si -X POST https://<host>/mcp` returns **401 from Access** with `WWW-Authenticate`. A 403 there means the request reached the Worker, so Access isn't covering the host.
5. In claude.ai, go to Settings → Connectors → Add custom connector, use `https://<host>/mcp`, then Connect and sign in through Access.

**If step 5 fails** (claude.ai can't complete Managed OAuth, which requires RFC 8707 resource indicators), fall back to Cloudflare's `remote-mcp-cf-access` template pattern. In that pattern the Worker becomes the OAuth server (`@cloudflare/workers-oauth-provider` plus a KV namespace), and an **Access for SaaS (OIDC)** app is the identity provider. Keep `buildServer` and the Nexus helpers unchanged, and swap only the auth layer. Remove `verifyAccess` in that case, because tokens then come from the Worker's own provider.

## TODO

- [ ] Deploy, then live smoke test: `get_mod` 183621, `get_mod_requirements` 183621, `search_mods` (both sort keys), `search_collections`.
- [x] Fix GraphQL field mismatches found by introspection (`uploadedAt`, root `modRequirements`, root `collections`, `Collection.downloads`), and record the confirmed shapes in the Nexus notes above.
- [ ] Add a "mods that require this mod" tool. Field found: `Mod.modRequirements.modsRequiringThisMod(offset, count)` (e.g. Address Library has 2034). It's the most useful query for building a list around one mod.
- [ ] Optional: a collection-contents tool (`collection(slug) { latestPublishedRevision { modFiles { ... } } }`, shape unverified).