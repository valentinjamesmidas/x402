import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { agentPatch, endpointPatch } from "@platform/shared/database";
import type { Agent } from "@platform/shared/database";
import { MCP_LEGACY_VERSION, MCP_VERSION, callParams, rpcRequest, serverInfo, toolName } from "@platform/shared/mcp";
import { schemaFor, toolContracts } from "@platform/shared/tool-contracts";
import { chain, headers, networks } from "@platform/shared/x402";
import type { Env } from "./env";
import { verifyAgent } from "./identity";
import { paidTool, recordFor, sandboxRequest } from "./payment";
import { catalog, clearCatalog, database } from "./repository";
import { hash } from "./sha";
import { validOperatorSchema, validateArguments } from "./tools";

export const app = new Hono<{ Bindings: Env }>();
const versions = [MCP_VERSION, MCP_LEGACY_VERSION];
const capabilities = { tools: {} };
const noStore = "no-store, private";
const rpcError = (id: number | string | null, code: number, message: string, data?: unknown) =>
  ({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });

app.use("*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Cache-Control", noStore);
  const origin = c.req.header("Origin");
  if (origin) {
    const allowed = [new URL(c.req.url).origin, ...(c.env.ALLOWED_ORIGINS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)];
    if (!allowed.includes(origin)) return c.json({ error: "Origin forbidden" }, 403);
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
    c.header("Access-Control-Expose-Headers", `${headers.required}, ${headers.response}, ${headers.legacyResponse}, Retry-After`);
  }
  if (c.req.method === "OPTIONS") {
    c.header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Payment-Signature, X-Payment, Signature, Signature-Input, Content-Digest, X-Sandbox-Agent");
    return c.body(null, 204);
  }
  await next();
});
app.use("*", bodyLimit({ maxSize: 96 * 1024, onError: (c) => c.json(rpcError(null, -32600, "Request exceeds 96 KiB"), 413) }));
app.onError((_error, c) => {
  console.error(JSON.stringify({ event: "edge_request_failed", method: c.req.method, path: c.req.path }));
  return c.json(rpcError(null, -32001, "Gateway dependency unavailable"), 503);
});

app.get("/api/health", (c) => c.json({
  service: serverInfo.name, version: serverInfo.version, mcp: MCP_VERSION,
  mode: c.env.SANDBOX_MODE === "true" ? "sandbox" : "live",
  operatorConfigured: Boolean(c.env.SUPABASE_URL && c.env.SUPABASE_SERVICE_ROLE_KEY),
  supabaseUrl: c.env.SUPABASE_URL ?? null, supabasePublishableKey: c.env.SUPABASE_PUBLISHABLE_KEY ?? null,
  sandboxEnabled: c.env.SANDBOX_MODE === "true" || c.env.ENABLE_PROTOCOL_SANDBOX === "true",
}));
app.get("/api/catalog", async (c) => c.json({ endpoints: await catalog(c.env, database(c.env), c.executionCtx) }));
app.get("/.well-known/x402.json", async (c) => {
  const url = new URL(c.req.url);
  const sandbox = c.env.SANDBOX_MODE === "true";
  const network = sandbox ? "eip155:84532" : chain.parse(c.env.X402_NETWORK ?? "eip155:8453");
  return c.json({
    x402Version: 2, mcp: new URL("/mcp", url).href, mcpProtocolVersion: MCP_VERSION, transport: "streamable-http",
    discoveryMethod: "tools/list", paymentHeaders: headers, mode: sandbox ? "sandbox" : "live",
    network, asset: networks[network].asset, currency: "USDC", decimals: 6,
    schemes: ["exact", "upto"], payTo: sandbox ? null : c.env.OPERATOR_WALLET_ADDRESS ?? null,
  });
});
app.get("/agent-manifest.txt", (c) => {
  const url = new URL(c.req.url);
  return c.text([
    "# x402 Agent Gateway", "", `MCP: ${new URL("/mcp", url)}`, `Protocol: ${MCP_VERSION}, Streamable HTTP`,
    `Payment metadata: ${new URL("/.well-known/x402.json", url)}`,
    "Discover tools with tools/list. Execute tools with tools/call and PAYMENT-SIGNATURE after a 402.",
  ].join("\n"));
});

const mcpPaths = ["/mcp", "/sandbox/mcp"];
app.on(["GET", "DELETE"], mcpPaths, (c) => {
  c.header("Allow", "POST, OPTIONS");
  return c.body(null, 405);
});

app.on("POST", mcpPaths, async (c) => {
  const start = performance.now();
  const env = c.env;
  if (c.req.path === "/sandbox/mcp" && env.SANDBOX_MODE !== "true" && env.ENABLE_PROTOCOL_SANDBOX !== "true") {
    return c.json(rpcError(null, -32601, "Sandbox disabled"), 404);
  }
  const accept = c.req.header("Accept");
  if (accept && !accept.includes("*/*") && !accept.includes("application/json")) {
    return c.json(rpcError(null, -32600, "This endpoint responds with application/json"), 406);
  }
  if (c.req.header("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return c.json(rpcError(null, -32600, "Content-Type must be application/json"), 415);
  }
  const body = await c.req.arrayBuffer();
  let rpc: unknown;
  try {
    rpc = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    return c.json(rpcError(null, -32700, "Parse error"), 400);
  }
  const request = rpcRequest.safeParse(rpc);
  if (!request.success) return c.json(rpcError(null, -32600, "Invalid request"), 400);
  const { method, id, params } = request.data;
  const version = c.req.header("MCP-Protocol-Version") ?? MCP_LEGACY_VERSION;
  if (!versions.includes(version)) {
    return c.json(rpcError(id ?? null, -32022, "Unsupported protocol version", { supported: versions, requested: version }), 400);
  }
  if (version === MCP_VERSION) {
    const meta = params?._meta;
    const metadata = meta && typeof meta === "object" ? meta as Record<string, unknown> : {};
    const requestedName = params?.name ?? params?.uri;
    const mustMirrorName = ["tools/call", "prompts/get", "resources/read"].includes(method);
    const mismatch = metadata["io.modelcontextprotocol/protocolVersion"] !== version ? "MCP-Protocol-Version"
      : c.req.header("Mcp-Method") !== method ? "Mcp-Method"
      : mustMirrorName && c.req.header("Mcp-Name") !== requestedName ? "Mcp-Name" : null;
    if (mismatch) return c.json(rpcError(id ?? null, -32020, "MCP header mismatch", { header: mismatch }), 400);
    const clientCapabilities = metadata["io.modelcontextprotocol/clientCapabilities"];
    if (id !== undefined && (!clientCapabilities || typeof clientCapabilities !== "object" || Array.isArray(clientCapabilities))) {
      return c.json(rpcError(id, -32602, "Missing client capabilities"), 400);
    }
  }
  c.header("MCP-Protocol-Version", version);
  if (id === undefined) {
    if (!method.startsWith("notifications/")) return c.json(rpcError(null, -32600, "A request ID is required"), 400);
    return c.body(null, 202);
  }
  const success = (result: object) => c.json({
    jsonrpc: "2.0", id, result: version === MCP_VERSION ? { ...result, _meta: { "io.modelcontextprotocol/serverInfo": serverInfo } } : result,
  });
  if (method === "ping") return success({});
  if (method === "server/discover" && version === MCP_VERSION) return success({
    supportedVersions: versions, capabilities, instructions: "Discover free tool metadata. Paid calls use the x402 v2 HTTP transport.", ttlMs: 60_000,
  });
  if (method === "initialize" && version === MCP_LEGACY_VERSION) return success({
    protocolVersion: MCP_LEGACY_VERSION, capabilities, serverInfo,
  });
  if (method !== "tools/list" && method !== "tools/call") return c.json(rpcError(id, -32601, "Method not found"), version === MCP_VERSION ? 404 : 200);

  const db = database(env);
  const sandbox = sandboxRequest(env, c.req.path);
  const network = sandbox ? "eip155:84532" : chain.parse(env.X402_NETWORK ?? "eip155:8453");
  if (method === "tools/list") {
    const endpoints = await catalog(env, db, c.executionCtx);
    recordFor(c, db, start, sandbox, network)("discovery_200");
    return success({ tools: endpoints.filter((entry) => entry.is_active).map((entry) => {
      const tool = toolContracts[entry.tool_name];
      const pricing = {
        amount_usdc: entry.price_usdc, currency: "USDC", scheme: entry.pricing_scheme,
        average_latency_ms: entry.axo_metadata.average_latency_ms ?? tool.latency,
        data_guarantee: entry.axo_metadata.data_guarantee ?? tool.guarantee, network,
      };
      return {
        name: entry.tool_name, title: tool.title, description: entry.description,
        inputSchema: { type: "object", allOf: [schemaFor(tool.input), entry.input_schema] },
        outputSchema: schemaFor(tool.output), x402_pricing: pricing, _meta: { "x402.org/pricing": pricing },
      };
    }) });
  }

  const call = callParams.safeParse(params);
  if (!call.success) return c.json(rpcError(id, -32602, "Unknown tool or invalid call parameters"), version === MCP_VERSION ? 400 : 200);
  const name = call.data.name;
  const endpoint = (await catalog(env, db, c.executionCtx)).find((entry) => entry.tool_name === name && entry.is_active);
  if (!endpoint) return c.json(rpcError(id, -32602, "Tool is unavailable"), version === MCP_VERSION ? 400 : 200);
  const args = call.data.arguments ?? {};
  if (!validateArguments(endpoint, args)) {
    return success({ isError: true, content: [{ type: "text", text: "Arguments do not match the tool input schema. Call tools/list for the current schema." }] });
  }
  let agent: Agent | null;
  try {
    agent = await verifyAgent(c.req.raw, body, db, env);
  } catch {
    recordFor(c, db, start, sandbox, network, endpoint)("failed_signature");
    return c.json(rpcError(id, -32003, "Invalid or replayed agent signature"), 401);
  }
  if (agent?.is_blocked) {
    recordFor(c, db, start, sandbox, network, endpoint, agent)("rate_limited");
    return c.json(rpcError(id, -32003, "Agent is blocked"), 403);
  }
  const address = c.req.header("CF-Connecting-IP") ?? "local";
  const gate = env.GATES.getByName(`quota:${await hash(agent?.id ?? address)}`);
  if (!(await gate.allow(agent?.rate_limit_rpm ?? 60))) {
    recordFor(c, db, start, sandbox, network, endpoint, agent)("rate_limited");
    c.header("Retry-After", String(60 - Math.floor(Date.now() / 1000) % 60));
    return c.json(rpcError(id, -32029, "Rate limit exceeded"), 429);
  }
  return paidTool(c, { db, endpoint, name, args, agent, sandbox, id, start });
});

async function authorize(c: { env: Env; req: { header(name: string): string | undefined } }) {
  const db = database(c.env);
  const token = c.req.header("Authorization");
  if (!db || !token?.startsWith("Bearer ")) return null;
  const { data, error } = await db.auth.getUser(token.slice(7));
  return !error && data.user.app_metadata.x402_role === "operator" ? db : null;
}

app.patch("/api/operator/tools/:name", async (c) => {
  const db = await authorize(c);
  if (!db) return c.json({ error: "Operator access required" }, 403);
  const name = toolName.safeParse(c.req.param("name"));
  const patch = endpointPatch.safeParse(await c.req.json().catch(() => null));
  if (!name.success || !patch.success || !Object.keys(patch.data).length || (patch.data.input_schema && !validOperatorSchema(patch.data.input_schema))) {
    return c.json({ error: "Invalid tool settings or input schema" }, 400);
  }
  const { data, error } = await db.from("x402_endpoints").update(patch.data).eq("tool_name", name.data).select().maybeSingle();
  if (error) return c.json({ error: "Unable to update tool" }, 400);
  if (!data) return c.json({ error: "Tool not found" }, 404);
  await clearCatalog(c.env);
  return c.json(data);
});
app.patch("/api/operator/agents/:id", async (c) => {
  const db = await authorize(c);
  if (!db) return c.json({ error: "Operator access required" }, 403);
  const patch = agentPatch.safeParse(await c.req.json().catch(() => null));
  if (!patch.success || !Object.keys(patch.data).length) return c.json({ error: "Invalid agent settings" }, 400);
  const { data, error } = await db.from("agent_identities").update(patch.data).eq("id", c.req.param("id")).select().maybeSingle();
  if (error) return c.json({ error: "Unable to update agent" }, 400);
  if (!data) return c.json({ error: "Agent not found" }, 404);
  return c.json(data);
});

export default app;
