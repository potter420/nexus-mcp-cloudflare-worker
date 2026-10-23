/**
 * nexus-mcp — a read-only Nexus Mods MCP server on Cloudflare Workers.
 *
 * Transport: stateless Streamable HTTP (agents/mcp/server + MCP SDK v2).
 * Auth to this Worker: Cloudflare Access fronts the custom domain; the Worker
 * independently verifies the Access JWT (Cf-Access-Jwt-Assertion).
 * Auth to Nexus: your personal API key, held as a Worker secret and never
 * returned in any response.
 */
import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

export interface Env {
  NEXUS_API_KEY: string; // secret: wrangler secret put NEXUS_API_KEY
  MCP_HOSTNAME: string; // var: the only Host we answer on
  ACCESS_TEAM_DOMAIN: string; // var: https://<team>.cloudflareaccess.com (= JWT iss)
  ACCESS_AUD: string; // var: the Access application's AUD tag
  ALLOWED_EMAILS?: string; // var: optional comma-separated allowlist
}

const APP_NAME = "personal-nexus-mcp";
const APP_VERSION = "0.1.0";
const REST = "https://api.nexusmods.com/v1";
const GQL = "https://api.nexusmods.com/v2/graphql";
const MAX_TEXT = 20_000; // keep tool results inside a sane context budget
const DEFAULT_GAME = "skyrimspecialedition";

// ---------------------------------------------------------------- Nexus I/O

function nexusHeaders(env: Env): HeadersInit {
  return {
    apikey: env.NEXUS_API_KEY,
    accept: "application/json",
    "application-name": APP_NAME,
    "application-version": APP_VERSION,
    "user-agent": `${APP_NAME}/${APP_VERSION}`,
  };
}

/** GET against REST v1, cached at the edge for 10 minutes. */
async function rest(env: Env, ctx: ExecutionContext, path: string): Promise<unknown> {
  const url = `${REST}${path}`;
  const cache = caches.default;
  // Cache key carries no credentials; the key is only ever sent upstream.
  const cacheKey = new Request(url, { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();

  const res = await fetch(url, { headers: nexusHeaders(env) });
  if (!res.ok) {
    throw new Error(`Nexus REST ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = await res.text();
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(body, {
        headers: { "content-type": "application/json", "cache-control": "max-age=600" },
      }),
    ),
  );
  return JSON.parse(body);
}

/** POST to the (undocumented but widely used) v2 GraphQL endpoint. */
async function gql(env: Env, query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(GQL, {
    method: "POST",
    headers: { ...nexusHeaders(env), "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Nexus GraphQL HTTP ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  if (json.errors?.length) {
    throw new Error(`Nexus GraphQL errors: ${JSON.stringify(json.errors).slice(0, 800)}`);
  }
  return json.data;
}

// ---------------------------------------------------------------- helpers

/** Nexus descriptions are BBCode; strip tags so the model reads prose, not markup. */
function bbcodeToText(s: string | undefined | null): string {
  if (!s) return "";
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, "$2 ($1)")
    .replace(/\[img\][\s\S]*?\[\/img\]/gi, "")
    .replace(/\[\*\]/g, "\n- ")
    .replace(/\[\/?[a-z]+(=[^\]]*)?\]/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function out(value: unknown) {
  // Compact JSON: indentation roughly doubles size and burns the MAX_TEXT budget.
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n…[truncated at ${MAX_TEXT} chars]`;
  return { content: [{ type: "text" as const, text }] };
}

function fail(err: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
  };
}

const game = z
  .string()
  .regex(/^[a-z0-9]+$/)
  .default(DEFAULT_GAME)
  .describe("Nexus game domain, e.g. skyrimspecialedition");

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

/** Domain → numeric game id. Static data, so a per-isolate cache is safe. */
const gameIds = new Map<string, number>();

async function resolveGameId(env: Env, domainName: string): Promise<number> {
  const hit = gameIds.get(domainName);
  if (hit) return hit;
  const data = await gql(env, `query Game($d: String) { game(domainName: $d) { id } }`, { d: domainName });
  const id = data.game?.id;
  if (typeof id !== "number") throw new Error(`Unknown Nexus game domain: ${domainName}`);
  gameIds.set(domainName, id);
  return id;
}

/** Reject anything that is not a query operation. Coarse on purpose. */
function assertReadOnly(query: string) {
  const stripped = query.replace(/#[^\n]*/g, "").replace(/"(?:\\.|[^"\\])*"/g, '""');
  if (/(^|[\s}])(mutation|subscription)\b/i.test(stripped)) {
    throw new Error("Only query operations are allowed (no mutation/subscription).");
  }
}

// ---------------------------------------------------------------- server

function buildServer(env: Env, ctx: ExecutionContext): McpServer {
  const server = new McpServer({ name: "nexus-mods", version: APP_VERSION });

  server.registerTool(
    "search_mods",
    {
      title: "Search Nexus mods",
      description:
        "Search a game's mods on Nexus by name (wildcard match). Returns id, name, summary, author, endorsements, downloads, updated time. Use get_mod for full details.",
      inputSchema: z.object({
        term: z.string().min(2).describe("Words to match in the mod name (substring, case-insensitive; no * needed)"),
        game,
        sort: z.enum(["endorsements", "downloads"]).default("endorsements"),
        count: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: READ_ONLY,
    },
    async ({ term, game, sort, count, offset }) => {
      // `sort` is enum-validated above, so inlining it is safe.
      const query = /* GraphQL */ `
        query Search($filter: ModsFilter, $count: Int, $offset: Int) {
          mods(filter: $filter, sort: { ${sort}: { direction: DESC } }, count: $count, offset: $offset) {
            nodes { modId name summary version uploader { name } endorsements downloads updatedAt }
          }
        }`;
      const filter = {
        gameDomainName: [{ value: game, op: "EQUALS" }],
        name: [{ value: term, op: "WILDCARD" }],
      };
      try {
        const data = await gql(env, query, { filter, count, offset });
        return out(
          data.mods.nodes.map((n: any) => ({
            ...n,
            uploader: n.uploader?.name,
            url: `https://www.nexusmods.com/${game}/mods/${n.modId}`,
          })),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_mod",
    {
      title: "Get mod details",
      description:
        "Full details for one mod: name, author, version, category, endorsements, timestamps, summary and the full description page (BBCode stripped). The description is where authors list requirements, compatibility and patches.",
      inputSchema: z.object({ mod_id: z.number().int().positive(), game }),
      annotations: READ_ONLY,
    },
    async ({ mod_id, game }) => {
      try {
        const m: any = await rest(env, ctx, `/games/${game}/mods/${mod_id}.json`);
        return out({
          mod_id: m.mod_id,
          name: m.name,
          url: `https://www.nexusmods.com/${game}/mods/${mod_id}`,
          author: m.author,
          uploaded_by: m.uploaded_by,
          version: m.version,
          category_id: m.category_id,
          endorsements: m.endorsement_count,
          adult: m.contains_adult_content,
          status: m.status,
          created: m.created_time,
          updated: m.updated_time,
          summary: bbcodeToText(m.summary),
          description: bbcodeToText(m.description),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_mod_requirements",
    {
      title: "Get mod requirements",
      description:
        "The 'Requirements' a mod author declared on Nexus: Nexus mods this one needs, off-site requirements (external: true, with url, e.g. VC++ redist), and DLC. Some authors only list requirements in the description; check get_mod too.",
      inputSchema: z.object({ mod_id: z.number().int().positive(), game }),
      annotations: READ_ONLY,
    },
    async ({ mod_id, game }) => {
      const query = /* GraphQL */ `
        query Req($modId: ID!, $gameId: ID!) {
          mod(modId: $modId, gameId: $gameId) {
            modId name
            modRequirements {
              nexusRequirements(count: 50) {
                totalCount
                nodes { modId modName externalRequirement notes url }
              }
              dlcRequirements { notes gameExpansion { name } }
            }
          }
        }`;
      try {
        const gameId = await resolveGameId(env, game);
        const data = await gql(env, query, { modId: String(mod_id), gameId: String(gameId) });
        const r = data.mod.modRequirements;
        return out({
          mod_id: data.mod.modId,
          name: data.mod.name,
          total: r.nexusRequirements.totalCount,
          requirements: r.nexusRequirements.nodes.map((n: any) =>
            n.externalRequirement
              ? { name: n.modName, external: true, url: n.url, notes: n.notes || undefined }
              : {
                  mod_id: Number(n.modId),
                  name: n.modName,
                  url: `https://www.nexusmods.com/${game}/mods/${n.modId}`,
                  notes: n.notes || undefined,
                },
          ),
          dlc: r.dlcRequirements.map((d: any) => ({ name: d.gameExpansion?.name, notes: d.notes || undefined })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_mod_files",
    {
      title: "List mod files",
      description:
        "Downloadable files for a mod (main, optional, patches, old versions) with version, category, size and the file description. Patches for other mods usually live here as optional files.",
      inputSchema: z.object({
        mod_id: z.number().int().positive(),
        game,
        include_old: z.boolean().default(false).describe("Include OLD_VERSION/ARCHIVED files"),
      }),
      annotations: READ_ONLY,
    },
    async ({ mod_id, game, include_old }) => {
      try {
        const r: any = await rest(env, ctx, `/games/${game}/mods/${mod_id}/files.json`);
        const files = (r.files ?? [])
          .filter((f: any) => include_old || !["OLD_VERSION", "ARCHIVED", "DELETED"].includes(f.category_name))
          .map((f: any) => ({
            file_id: f.file_id,
            name: f.name,
            version: f.version,
            category: f.category_name,
            primary: f.is_primary,
            size_kb: f.size_kb,
            uploaded: f.uploaded_time,
            description: bbcodeToText(f.description),
          }));
        return out(files);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "search_collections",
    {
      title: "Search collections",
      description:
        "Search curated Nexus Collections (mod lists) for a game by name, most-endorsed first. Useful for seeing what other lists pair with a given mod.",
      inputSchema: z.object({
        term: z.string().default("").describe("Name filter (substring, 2+ chars); empty for top collections"),
        game,
        count: z.number().int().min(1).max(50).default(20),
      }),
      annotations: READ_ONLY,
    },
    async ({ term, game, count }) => {
      const query = /* GraphQL */ `
        query Cols($filter: CollectionsSearchFilter, $count: Int) {
          collectionsV2(filter: $filter, sort: [{ endorsements: { direction: DESC } }], count: $count) {
            nodes { slug name summary endorsements totalDownloads }
          }
        }`;
      const t = term.trim();
      if (t.length === 1) return fail(new Error("term must be empty or at least 2 characters"));
      // The API rejects WILDCARD values under 2 chars, so omit the name filter when empty.
      const filter: Record<string, unknown> = { gameDomain: [{ value: game, op: "EQUALS" }] };
      if (t) filter.name = [{ value: t, op: "WILDCARD" }];
      try {
        const data = await gql(env, query, { filter, count });
        return out(
          data.collectionsV2.nodes.map((c: any) => ({
            ...c,
            url: `https://www.nexusmods.com/games/${game}/collections/${c.slug}`,
          })),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "graphql_query",
    {
      title: "Raw read-only GraphQL",
      description:
        "Escape hatch: run any read-only query against Nexus's v2 GraphQL API (https://api.nexusmods.com/v2/graphql). The schema is undocumented; introspect when a typed tool's query fails or a field you need is missing. Output is capped at 20k chars, so introspect ONE type per call and keep it small, e.g. `{ __type(name: \"Mod\") { fields { name } } }`; never dump __schema. Root fields take numeric ids: mod(modId: ID!, gameId: ID!); get gameId via game(domainName: \"skyrimspecialedition\") { id } (1704). Collections search is collectionsV2. Mutations and subscriptions are rejected.",
      inputSchema: z.object({
        query: z.string().min(1),
        variables: z.record(z.string(), z.unknown()).default({}),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, variables }) => {
      try {
        assertReadOnly(query);
        return out(await gql(env, query, variables));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------- access

const ROUTE = "/mcp";

/** Per-isolate JWKS cache (keys only; jose handles refresh/rotation). */
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(issuer: string) {
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksByIssuer.set(issuer, jwks);
  }
  return jwks;
}

function normalizeIssuer(teamDomain: string): string {
  const d = teamDomain.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(d) ? d : `https://${d}`;
}

function allowedEmails(env: Env): string[] {
  return (env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Verify the Cloudflare Access assertion: RS256 signature against the team's
 * JWKS, plus iss, aud, exp, and the optional email allowlist.
 * Returns the verified email, or null on any failure (never throws).
 */
async function verifyAccess(request: Request, env: Env): Promise<string | null> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  const issuer = normalizeIssuer(env.ACCESS_TEAM_DOMAIN);
  try {
    const { payload } = await jwtVerify(token, jwksFor(issuer), {
      issuer,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["exp"],
    });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    const allow = allowedEmails(env);
    if (allow.length && !allow.includes(email)) return null;
    return email || String(payload.sub ?? "");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- worker

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 1. Fail closed on missing config.
    if (!env.NEXUS_API_KEY || !env.MCP_HOSTNAME || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
      return new Response("Server not configured", { status: 500 });
    }
    // 2. Only one host, only one path.
    const url = new URL(request.url);
    if (url.hostname !== env.MCP_HOSTNAME || url.pathname !== ROUTE) {
      return new Response("Not found", { status: 404 });
    }
    // 3. Verify the Access JWT ourselves; don't just trust the edge.
    const user = await verifyAccess(request, env);
    if (!user) return new Response("Forbidden", { status: 403 });

    const handler = createMcpHandler(() => buildServer(env, ctx), {
      route: ROUTE,
      allowedHostnames: [env.MCP_HOSTNAME],
      corsOptions: false, // only server-to-server MCP clients; no browser access needed
      authContext: { props: { user } },
    });
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
