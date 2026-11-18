import { useCallback, useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import type { RealtimePostgresChangesPayload, Session, SupabaseClient } from "@supabase/supabase-js";
import { agentSchema, defaultEndpoints, endpointSchema, transactionSchema } from "@platform/shared/database";
import type { Agent, Database, Endpoint, Transaction } from "@platform/shared/database";
import { demoAgents, demoEvents } from "./demo";

export const edgeOrigin = (import.meta.env.VITE_EDGE_URL ?? "").replace(/\/$/, "");
type Edge = { mode: "sandbox" | "live"; sandboxEnabled: boolean; supabaseUrl?: string; supabasePublishableKey?: string };

function localState<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") as T ?? fallback; }
  catch { return fallback; }
}

const upsert = <T extends { id: string }>(entries: T[], row: T) =>
  entries.some((entry) => entry.id === row.id) ? entries.map((entry) => entry.id === row.id ? row : entry) : [row, ...entries];
const transactionOrder = (a: Transaction, b: Transaction) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);

export function usePlatform() {
  const [edge, setEdge] = useState<Edge | null>(null);
  const [client, setClient] = useState<SupabaseClient<Database> | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [demoTools, setDemoTools] = useState(() => localState("x402:tools", defaultEndpoints));
  const [demoRegistry, setDemoRegistry] = useState(() => localState("x402:agents", demoAgents));
  const [demoTransactions, setDemoTransactions] = useState(demoEvents);
  const [publicTools, setPublicTools] = useState<Endpoint[] | null>(null);
  const [liveTools, setLiveTools] = useState<Endpoint[]>([]);
  const [liveAgents, setLiveAgents] = useState<Agent[]>([]);
  const [liveEvents, setLiveEvents] = useState<Transaction[]>([]);
  const [connection, setConnection] = useState<"demo" | "connecting" | "realtime" | "offline">("demo");
  const [problem, setProblem] = useState("");
  const live = session?.user.app_metadata.x402_role === "operator" && Boolean(client);

  useEffect(() => {
    const abort = new AbortController();
    void fetch(`${edgeOrigin}/api/health`, { signal: abort.signal }).then(async (response) => {
      if (!response.ok || !response.headers.get("Content-Type")?.includes("application/json")) return;
      const info = await response.json() as Edge;
      if (info.mode === "sandbox" || info.mode === "live") setEdge(info);
    }).catch(() => undefined);
    return () => abort.abort();
  }, []);

  useEffect(() => {
    if (!edge) return;
    const abort = new AbortController();
    const refresh = () => {
      void fetch(`${edgeOrigin}/api/catalog`, { signal: abort.signal }).then(async (response) => {
        if (!response.ok) return;
        const parsed = endpointSchema.array().safeParse((await response.json()).endpoints);
        if (parsed.success && !abort.signal.aborted) setPublicTools(parsed.data);
      }).catch(() => undefined);
    };
    refresh();
    const interval = window.setInterval(refresh, 60_000);
    return () => { abort.abort(); window.clearInterval(interval); };
  }, [edge]);

  useEffect(() => {
    const url = import.meta.env.VITE_SUPABASE_URL || edge?.supabaseUrl;
    const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || edge?.supabasePublishableKey;
    if (!url || !key) return;
    const db = createClient<Database>(url, key);
    let active = true;
    setClient(db);
    void db.auth.getSession().then(({ data }) => { if (active) setSession(data.session); });
    const { data: { subscription } } = db.auth.onAuthStateChange((_event, current) => setSession(current));
    return () => { active = false; subscription.unsubscribe(); };
  }, [edge?.supabaseUrl, edge?.supabasePublishableKey]);

  useEffect(() => {
    if (!live || !client) return;
    let active = true;
    const pending: (() => void)[] = [];
    let loaded = false;
    setConnection("connecting");
    const afterLoad = (apply: () => void) => {
      if (!active) return;
      if (loaded) apply(); else pending.push(apply);
    };
    function updateEvent(payload: RealtimePostgresChangesPayload<Transaction>) {
      afterLoad(() => setLiveEvents((entries) => {
        if (payload.eventType === "DELETE") return entries.filter((entry) => entry.id !== payload.old.id);
        const next = transactionSchema.safeParse(payload.new);
        return next.success ? upsert(entries, next.data).sort(transactionOrder) : entries;
      }));
    }
    function updateTool(payload: RealtimePostgresChangesPayload<Endpoint>) {
      afterLoad(() => setLiveTools((entries) => {
        if (payload.eventType === "DELETE") return entries.filter((entry) => entry.id !== payload.old.id);
        const next = endpointSchema.safeParse(payload.new);
        return next.success ? upsert(entries, next.data) : entries;
      }));
    }
    function updateAgent(payload: RealtimePostgresChangesPayload<Agent>) {
      afterLoad(() => setLiveAgents((entries) => {
        if (payload.eventType === "DELETE") return entries.filter((entry) => entry.id !== payload.old.id);
        const next = agentSchema.safeParse(payload.new);
        return next.success ? upsert(entries, next.data) : entries;
      }));
    }
    async function loadEvents(db: SupabaseClient<Database>) {
      const result: Transaction[] = [];
      const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
      const before = new Date().toISOString();
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await db.from("x402_transactions").select().gte("created_at", dayAgo).lte("created_at", before)
          .order("created_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + 999);
        if (error) throw error;
        result.push(...transactionSchema.array().parse(data));
        if (data.length < 1000 || !active) return result;
      }
    }
    let loading = false;
    void client.channel("x402-operator")
      .on<Transaction>("postgres_changes", { event: "*", schema: "public", table: "x402_transactions" }, updateEvent)
      .on<Endpoint>("postgres_changes", { event: "*", schema: "public", table: "x402_endpoints" }, updateTool)
      .on<Agent>("postgres_changes", { event: "*", schema: "public", table: "agent_identities" }, updateAgent)
      .subscribe((status) => {
        if (!active) return;
        if (status !== "SUBSCRIBED") {
          setConnection("offline");
          setProblem("Realtime connection interrupted. Supabase will reconnect automatically.");
          return;
        }
        if (loading) return;
        loading = true;
        loaded = false;
        void Promise.all([client.from("x402_endpoints").select(), client.from("agent_identities").select(), loadEvents(client)]).then(([tools, agents, events]) => {
          if (tools.error || agents.error) throw new Error("Operator rows unavailable");
          if (!active) return;
          setLiveTools(endpointSchema.array().parse(tools.data));
          setLiveAgents(agentSchema.array().parse(agents.data));
          setLiveEvents(events);
          loaded = true;
          pending.splice(0).forEach((apply) => apply());
          setProblem("");
          setConnection("realtime");
        }).catch(() => {
          if (active) { setProblem("Could not load operator data from Supabase."); setConnection("offline"); }
        }).finally(() => { loading = false; });
      });
    return () => { active = false; void client.removeAllChannels(); };
  }, [client, live]);

  const addDemoEvent = useCallback((event: Transaction) => setDemoTransactions((current) => upsert(current, event).sort(transactionOrder)), []);

  async function saveTool(name: Endpoint["tool_name"], patch: Partial<Endpoint>) {
    if (!live) {
      const next = demoTools.map((entry) => entry.tool_name === name ? { ...entry, ...patch } : entry);
      setDemoTools(next);
      localStorage.setItem("x402:tools", JSON.stringify(next));
      return;
    }
    const response = await fetch(`${edgeOrigin}/api/operator/tools/${name}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${session?.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify(patch),
    });
    const data: unknown = await response.json();
    if (!response.ok) throw new Error("The gateway rejected the tool settings.");
    const saved = endpointSchema.parse(data);
    setLiveTools((current) => upsert(current, saved));
  }

  async function saveAgent(id: string, patch: Partial<Agent>) {
    if (!live) {
      const next = demoRegistry.map((entry) => entry.id === id ? { ...entry, ...patch } : entry);
      setDemoRegistry(next);
      localStorage.setItem("x402:agents", JSON.stringify(next));
      return;
    }
    const response = await fetch(`${edgeOrigin}/api/operator/agents/${id}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${session?.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify(patch),
    });
    const data: unknown = await response.json();
    if (!response.ok) throw new Error("The gateway rejected the agent settings.");
    const saved = agentSchema.parse(data);
    setLiveAgents((current) => upsert(current, saved));
  }

  return {
    edge, client, session, live, connection: live ? connection : "demo", problem: live ? problem : "",
    endpoints: live ? liveTools : demoTools,
    publishedEndpoints: live && connection === "realtime" ? liveTools : publicTools ?? demoTools,
    agents: live ? liveAgents : demoRegistry,
    events: live ? liveEvents : demoTransactions,
    saveTool, saveAgent, addDemoEvent,
  };
}
export type Platform = ReturnType<typeof usePlatform>;
