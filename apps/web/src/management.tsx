import { useState } from "react";
import { BadgeCheck, Ban, CircleHelp, Code2, FileSearch, Fingerprint, SlidersHorizontal, TrendingUp, Workflow } from "lucide-react";
import { endpointPatch } from "@platform/shared/database";
import type { Agent, Endpoint } from "@platform/shared/database";
import { toolContracts } from "@platform/shared/tool-contracts";
import type { Platform } from "./platform";

export function PageTitle({ icon: Icon, section, title, description }: {
  icon: typeof Workflow; section: string; title: string; description: string;
}) {
  return <div className="page-heading"><div>
    <p className="eyebrow"><Icon size={14} /> {section}</p><h1>{title}</h1><p>{description}</p>
  </div></div>;
}

export const toolIcons = {
  cross_border_price_arbitrage: TrendingUp,
  contract_and_tender_risk_audit: FileSearch,
  verified_entity_kyb_oracle: Fingerprint,
};
export const toolTones = {
  cross_border_price_arbitrage: "green",
  contract_and_tender_risk_audit: "violet",
  verified_entity_kyb_oracle: "cyan",
};

export function ToolManager({ platform }: { platform: Platform }) {
  const [selected, setSelected] = useState<Endpoint["tool_name"]>();
  const endpoint = platform.endpoints.find((entry) => entry.tool_name === selected) ?? platform.endpoints[0];
  return <>
    <PageTitle icon={Workflow} section="MCP CATALOG" title="MCP tools" description="Manage tool availability, payment terms and agent-facing metadata." />
    <div className="management-grid">
      <section className="panel tool-list" aria-label="Available tools">
        <div className="panel-heading"><div><h2>Tool catalog</h2><p>{platform.endpoints.filter((entry) => entry.is_active).length} active tools</p></div></div>
        {platform.endpoints.map((entry) => {
          const Icon = toolIcons[entry.tool_name];
          return <button className={`tool-tab ${endpoint?.id === entry.id ? "selected" : ""}`} key={entry.id} onClick={() => setSelected(entry.tool_name)}>
            <span className={`metric-icon ${toolTones[entry.tool_name]}`}><Icon size={18} /></span>
            <span><strong>{toolContracts[entry.tool_name].title}</strong><small>${entry.price_usdc.toFixed(3)} USDC · {entry.pricing_scheme}</small></span>
            <i className={entry.is_active ? "active-dot" : "paused-dot"} title={entry.is_active ? "Active" : "Paused"} />
          </button>;
        })}
      </section>
      {endpoint ? <ToolEditor key={endpoint.id} endpoint={endpoint} saveTool={platform.saveTool} /> : <div className="panel empty">Waiting for the tool catalog.</div>}
    </div>
  </>;
}
function ToolEditor({ endpoint, saveTool }: { endpoint: Endpoint; saveTool: Platform["saveTool"] }) {
  const [price, setPrice] = useState(String(endpoint.price_usdc));
  const [scheme, setScheme] = useState(endpoint.pricing_scheme);
  const [description, setDescription] = useState(endpoint.description);
  const [guarantee, setGuarantee] = useState(String(endpoint.axo_metadata.data_guarantee ?? ""));
  const [latency, setLatency] = useState(String(endpoint.axo_metadata.average_latency_ms ?? ""));
  const [schema, setSchema] = useState(JSON.stringify(endpoint.input_schema, null, 2));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ text: "", error: false });
  const tool = toolContracts[endpoint.tool_name];

  async function update(patch: Partial<Endpoint>) {
    setSaving(true);
    setMessage({ text: "", error: false });
    try {
      await saveTool(endpoint.tool_name, patch);
      setMessage({ text: "Settings saved.", error: false });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Could not save settings.", error: true });
    } finally { setSaving(false); }
  }
  return <section className="panel editor">
    <div className="panel-heading"><div><h2>{tool.title}</h2><p><code>{endpoint.tool_name}</code></p></div>
      <button type="button" className={endpoint.is_active ? "toggle-button active" : "toggle-button"} role="switch" aria-checked={endpoint.is_active} aria-label="Tool active" disabled={saving}
        onClick={() => void update({ is_active: !endpoint.is_active })}><i />{endpoint.is_active ? "Active" : "Paused"}</button>
    </div>
    <form className="form-stack" onSubmit={(event) => {
      event.preventDefault();
      try {
        const parsed = endpointPatch.parse({
          pricing_scheme: scheme, price_usdc: Number(price), description: description.trim(),
          input_schema: JSON.parse(schema),
          axo_metadata: { ...endpoint.axo_metadata, average_latency_ms: Number(latency), data_guarantee: guarantee.trim() },
        });
        if (parsed.input_schema?.type !== "object" || !parsed.description) throw new Error("Invalid configuration");
        void update(parsed);
      } catch {
        setMessage({ text: "Enter a valid USDC price, description and object JSON Schema.", error: true });
      }
    }}>
      <div className="form-section-title"><SlidersHorizontal size={16} /> Payment terms</div>
      <div className="form-columns">
        <label>Price in USDC <input aria-label="Price in USDC" type="number" min=".001" max="10" step=".001" required value={price} onChange={(event) => setPrice(event.target.value)} /></label>
        <label>Payment scheme <select value={scheme} onChange={(event) => setScheme(event.target.value as typeof scheme)}><option value="exact">Exact · fixed price</option><option value="upto">Upto · metered Permit2</option></select></label>
      </div>
      <input aria-label="Price slider" type="range" min=".001" max="10" step=".001" value={price || ".001"} onChange={(event) => setPrice(event.target.value)} />
      <div className="form-section-title"><Code2 size={16} /> Discovery metadata</div>
      <label>Tool description <input maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} required /></label>
      <div className="form-columns">
        <label>Data guarantee <input maxLength={500} value={guarantee} onChange={(event) => setGuarantee(event.target.value)} required /></label>
        <label>Average latency (ms) <input min="0" max="60000" type="number" value={latency} onChange={(event) => setLatency(event.target.value)} required /></label>
      </div>
      <label>Input JSON Schema <textarea className="code-input" rows={10} maxLength={16384} spellCheck={false} value={schema} onChange={(event) => setSchema(event.target.value)} /></label>
      <div className="form-actions"><span role="status" className={message.error ? "error-ink" : "green-ink"}>{message.text}</span><button className="primary" type="submit" disabled={saving}>{saving ? "Saving…" : "Save settings"}</button></div>
    </form>
  </section>;
}

export function AgentRegistry({ platform }: { platform: Platform }) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const agents = platform.agents.filter((agent) => `${agent.agent_name} ${agent.wallet_address ?? ""}`.toLowerCase().includes(query));
  return <>
    <PageTitle icon={Fingerprint} section="KNOW YOUR AGENT" title="Agent registry" description="Review Ed25519 identities, payment history and per-agent limits." />
    <section className="panel">
      <div className="panel-heading terminal-heading"><div><h2>Agent identities</h2><p>{platform.agents.filter((agent) => agent.kya_verified).length} verified · {platform.agents.length} registered</p></div>
        <input className="agent-search" placeholder="Search agents" aria-label="Search agents" value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>
      <div className="table-scroll"><table className="registry-table"><thead><tr><th>AGENT</th><th>IDENTITY</th><th>WALLET</th><th>SPENT</th><th>RATE LIMIT</th><th>ACCESS</th></tr></thead>
        <tbody>{agents.map((agent) => <AgentRow agent={agent} saveAgent={platform.saveAgent} key={agent.id} />)}</tbody>
      </table>{!agents.length && <div className="empty">No matching agents.</div>}</div>
    </section>
  </>;
}
function AgentRow({ agent, saveAgent }: { agent: Agent; saveAgent: Platform["saveAgent"] }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [rpm, setRpm] = useState(agent.rate_limit_rpm);
  async function save(patch: Partial<Agent>) {
    setBusy(true); setMessage("");
    try { await saveAgent(agent.id, patch); setMessage("Saved"); }
    catch { setMessage("Save failed"); }
    finally { setBusy(false); }
  }
  const status = agent.kya_verified ? "Verified" : agent.ed25519_pubkey ? "Key registered" : "Unverified";
  return <tr>
    <td><strong>{agent.agent_name}</strong><small className="registry-sub">{agent.total_calls} paid calls</small></td>
    <td><span className={`status-badge ${agent.kya_verified ? "green" : "muted"}`} title={agent.signature_key_id ?? undefined}>{agent.kya_verified ? <BadgeCheck size={13} /> : <CircleHelp size={13} />}{status}</span></td>
    <td className="mono muted" title={agent.wallet_address ?? ""}>{agent.wallet_address ? `${agent.wallet_address.slice(0, 8)}…${agent.wallet_address.slice(-4)}` : "—"}</td>
    <td className="mono">${agent.total_spent_usdc.toFixed(2)}</td>
    <td><form className="inline-form" onSubmit={(event) => { event.preventDefault(); void save({ rate_limit_rpm: rpm }); }}>
      <input type="number" aria-label={`${agent.agent_name} requests per minute`} min={1} max={10000} required value={rpm} onChange={(event) => setRpm(Number(event.target.value))} />
      <button className="secondary compact" type="submit" disabled={busy || agent.rate_limit_rpm === rpm}>Save</button>
    </form></td>
    <td><button className={`secondary compact ${agent.is_blocked ? "error-ink" : ""}`} disabled={busy} onClick={() => void save({ is_blocked: !agent.is_blocked })}><Ban size={13} /> {agent.is_blocked ? "Unblock" : "Block"}</button>
      <span className="registry-sub" role="status">{message}</span></td>
  </tr>;
}
