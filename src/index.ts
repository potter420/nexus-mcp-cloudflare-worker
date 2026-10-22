/**
 * nexus-mcp — a read-only Nexus Mods MCP server on Cloudflare Workers.
 *
 * Transport: stateless Streamable HTTP (agents/mcp/server + MCP SDK v2).
 * Auth to this Worker: an unguessable path segment (/mcp/<PATH_TOKEN>).
 * Auth to Nexus: your personal API key, held as a Worker secret and never
 * returned in any response.
 */
import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export interface Env {
  NEXUS_API_KEY: string; // wrangler secret put NEXUS_API_KEY
  PATH_TOKEN: string; // wrangler secret put PATH_TOKEN  (>= 32 random chars)
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
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
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
        term: z.string().min(1).describe("Words to match in the mod name"),
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
            nodes { modId name summary version uploader { name } endorsements downloads uploadedAt }
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
        "The 'Requirements' list a mod author declared on Nexus (other Nexus mods this one needs). Off-site requirements (e.g. SKSE) may only appear in the description; check get_mod too.",
      inputSchema: z.object({ mod_id: z.number().int().positive(), game }),
      annotations: READ_ONLY,
    },
    async ({ mod_id, game }) => {
      const query = /* GraphQL */ `
        query Req($modId: Int!, $gameDomainName: String!) {
          modRequirements(modId: $modId, gameDomainName: $gameDomainName) {
            nexusRequirements { nodes { modId modName } }
          }
        }`;
      try {
        const data = await gql(env, query, { modId: mod_id, gameDomainName: game });
        return out(data.modRequirements);
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
        term: z.string().default("").describe("Name filter; empty for top collections"),
        game,
        count: z.number().int().min(1).max(50).default(20),
      }),
      annotations: READ_ONLY,
    },
    async ({ term, game, count }) => {
      const query = /* GraphQL */ `
        query Cols($game: String!, $term: String, $count: Int) {
          collections(
            filter: { gameDomain: { value: $game, op: EQUALS }, name: { value: $term, op: WILDCARD } }
            sort: { endorsements: { direction: DESC } }
            count: $count
          ) { nodes { slug name summary endorsements downloads } }
        }`;
      try {
        const data = await gql(env, query, { game, term, count });
        return out(
          data.collections.nodes.map((c: any) => ({
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
        "Escape hatch: run any read-only query against Nexus's v2 GraphQL API (https://api.nexusmods.com/v2/graphql). The schema is undocumented; introspect with __schema/__type when a typed tool's query fails or a field you need is missing (e.g. collection mod lists, mods that require a given mod). Mutations and subscriptions are rejected.",
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

// ---------------------------------------------------------------- worker

/** Constant-time comparison so the path token can't be timed byte by byte. */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.PATH_TOKEN || env.PATH_TOKEN.length < 32 || !env.NEXUS_API_KEY) {
      return new Response("Server not configured", { status: 500 });
    }
    const { pathname } = new URL(request.url);
    const m = pathname.match(/^\/mcp\/([^/]+)$/);
    if (!m || !safeEqual(m[1], env.PATH_TOKEN)) {
      return new Response("Not found", { status: 404 });
    }
    const handler = createMcpHandler(() => buildServer(env, ctx), {
      route: pathname,
      corsOptions: false, // only server-to-server MCP clients; no browser access needed
    });
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
