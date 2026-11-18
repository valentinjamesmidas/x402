import { useEffect, useState } from "react";
import { Blocks, Calculator, Clipboard, ExternalLink, FileJson } from "lucide-react";
import { usdcToUnits } from "@platform/shared/x402";
import { toolContracts } from "@platform/shared/tool-contracts";
import type { Endpoint } from "@platform/shared/database";
import { PageTitle } from "./management";

type ToolResponse = { content: { type: "text"; text: string }[] };
type BrowserModelContext = {
  registerTool(tool: { name: string; description: string; inputSchema: object; execute: (input: Record<string, unknown>) => Promise<ToolResponse> }): void;
  unregisterTool(name: string): void;
};

function quote(endpoint: Endpoint, count: number) {
  const units = BigInt(usdcToUnits(endpoint.price_usdc)) * BigInt(count);
  return { tool: endpoint.tool_name, calls: count, scheme: endpoint.pricing_scheme, amount_atomic: units.toString(), currency: "USDC", is_maximum: endpoint.pricing_scheme === "upto" };
}

export function useWebMcp(endpoints: Endpoint[]) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const context = (navigator as Navigator & { modelContext?: BrowserModelContext }).modelContext;
    if (!context) return;
    const active = endpoints.filter((entry) => entry.is_active);
    const result = (data: unknown): ToolResponse => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
    const registered: string[] = [];
    try {
      context.registerTool({
        name: "get_x402_catalog", description: "Read active x402 MCP tools and USDC pricing.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => result(active.map((tool) => ({
          name: tool.tool_name, description: tool.description, price_usdc: tool.price_usdc,
          pricing_scheme: tool.pricing_scheme, input_schema: tool.input_schema, axo_metadata: tool.axo_metadata,
        }))),
      });
      registered.push("get_x402_catalog");
      context.registerTool({
        name: "calculate_batch_quote", description: "Calculate the fixed total or authorization cap for repeated calls.",
        inputSchema: { type: "object", required: ["tool", "calls"], additionalProperties: false, properties: {
          tool: { type: "string", enum: active.map((entry) => entry.tool_name) }, calls: { type: "integer", minimum: 1, maximum: 10000 },
        } },
        execute: async (input) => {
          const tool = active.find((entry) => entry.tool_name === input.tool);
          const count = input.calls;
          if (!tool || typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 10_000) throw new Error("Invalid batch quote arguments");
          return result(quote(tool, count));
        },
      });
      registered.push("calculate_batch_quote");
      setAvailable(true);
    } catch {
      setAvailable(false);
    }
    return () => { for (const name of registered) context.unregisterTool(name); };
  }, [endpoints]);
  return available;
}

export function WebMcp({ endpoints, available }: { endpoints: Endpoint[]; available: boolean }) {
  const active = endpoints.filter((entry) => entry.is_active);
  const [selected, setSelected] = useState("");
  const [count, setCount] = useState(10);
  const [copied, setCopied] = useState(false);
  const tool = active.find((entry) => entry.tool_name === selected) ?? active[0];
  const valid = Number.isInteger(count) && count > 0 && count <= 10_000;
  const total = tool && valid ? Number(quote(tool, count).amount_atomic) / 1_000_000 : 0;
  return <>
    <PageTitle icon={Blocks} section="AGENT DISCOVERY" title="WebMCP" description="Expose browser tools and publish discovery metadata for external agents." />
    <div className="sandbox-grid">
      <section className="panel editor">
        <div className="panel-heading"><div><h2>Browser tools</h2><p><code>navigator.modelContext</code></p></div>
          <span className={`status-badge ${available ? "green" : "muted"}`}><i />{available ? "REGISTERED" : "UNAVAILABLE IN THIS BROWSER"}</span>
        </div>
        <div className="form-stack">
          <div className="discovery-row"><Blocks size={17} /><div><strong><code>get_x402_catalog</code></strong><p>Read active tools, schemas and prices.</p></div></div>
          <div className="discovery-row"><Calculator size={17} /><div><strong><code>calculate_batch_quote</code></strong><p>Calculate a fixed total or authorization cap.</p></div></div>
          <div className="form-section-title"><Calculator size={16} /> Batch quote</div>
          <div className="form-columns">
            <label>Tool <select value={tool?.tool_name ?? ""} onChange={(event) => setSelected(event.target.value)}>{active.map((entry) => <option key={entry.id} value={entry.tool_name}>{toolContracts[entry.tool_name].title}</option>)}</select></label>
            <label>Calls <input type="number" min={1} max={10_000} value={count} onChange={(event) => setCount(Number(event.target.value))} /></label>
          </div>
          <p className="quote">{tool && valid ? <><strong>{total.toLocaleString("en-US", { maximumFractionDigits: 6 })} USDC</strong> {tool.pricing_scheme === "upto" ? "maximum" : "fixed"}</> : "Enter 1–10,000 calls for an active tool."}</p>
        </div>
      </section>
      <section className="panel editor">
        <div className="panel-heading"><div><h2>Discovery files</h2><p>Public endpoints for autonomous clients</p></div></div>
        <div className="form-stack">
          {[["Agent manifest", "/agent-manifest.txt"], ["x402 payment manifest", "/.well-known/x402.json"]].map(([label, href]) =>
            <a className="discovery-row" href={href} key={href} target="_blank" rel="noreferrer"><FileJson size={17} /><div><strong>{label}</strong><p><code>{href}</code></p></div><ExternalLink size={15} /></a>)}
          <button className="secondary" onClick={() => void navigator.clipboard.writeText(new URL("/mcp", location.origin).href).then(() => setCopied(true)).catch(() => setCopied(false))}><Clipboard size={15} />{copied ? "MCP URL copied" : "Copy MCP URL"}</button>
        </div>
      </section>
    </div>
  </>;
}
