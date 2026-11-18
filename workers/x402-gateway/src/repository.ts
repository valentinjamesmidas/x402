import { createClient } from "@supabase/supabase-js";
import { agentSchema, defaultEndpoints, endpointSchema } from "@platform/shared/database";
import type { Database } from "@platform/shared/database";
import type { Env, Lifetime } from "./env";

export function database(env: Env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(6500), redirect: "error" }) },
  });
}

export type Db = ReturnType<typeof database>;
const catalogKey = "catalog:v1";

export async function catalog(env: Env, db: Db, lifetime: Lifetime) {
  if (!db) return defaultEndpoints;
  const cached = await env.X402_NONCE_STORE?.get(catalogKey, "json").catch(() => null);
  if (Array.isArray(cached)) {
    const parsed = endpointSchema.array().safeParse(cached);
    if (parsed.success) return parsed.data;
  }
  const { data, error } = await db.from("x402_endpoints").select().order("tool_name");
  if (error) throw new Error("Catalog unavailable");
  const endpoints = endpointSchema.array().parse(data);
  if (env.X402_NONCE_STORE) lifetime.waitUntil(env.X402_NONCE_STORE.put(catalogKey, JSON.stringify(endpoints), { expirationTtl: 60 }).catch(() => undefined));
  return endpoints;
}

export async function clearCatalog(env: Env) {
  await env.X402_NONCE_STORE?.delete(catalogKey).catch(() => undefined);
}

export async function lookupAgent(db: NonNullable<Db>, by: "id" | "signature_key_id" | "wallet_address", value: string) {
  const { data, error } = await db.from("agent_identities").select().eq(by, value).maybeSingle();
  if (error) throw new Error("Agent registry unavailable");
  return data ? agentSchema.parse(data) : null;
}

export type Event = Database["public"]["Functions"]["record_x402_event"]["Args"]["event"];
export function recordEvent(lifetime: Lifetime, db: Db, event: Event) {
  if (db) lifetime.waitUntil(Promise.resolve(db.rpc("record_x402_event", { event })).then(({ error }) => {
    if (error) console.error(JSON.stringify({ event: "telemetry_write_failed", code: error.code, status: event.status }));
  }).catch(() => console.error(JSON.stringify({ event: "telemetry_unavailable", status: event.status }))));
}
