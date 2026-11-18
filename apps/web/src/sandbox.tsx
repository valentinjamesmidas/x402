import { useState } from "react";
import { ArrowRight, Check, CircleDollarSign, Code2, FlaskConical, KeyRound, RotateCcw, Send } from "lucide-react";
import { jsonObject, rpcCall } from "@platform/shared/mcp";
import type { ToolName } from "@platform/shared/mcp";
import { toolContracts, toolExamples } from "@platform/shared/tool-contracts";
import { encodeHeader, unitsToUsdc } from "@platform/shared/x402";
import type { Challenge, Payment, Settlement } from "@platform/shared/x402";
import { demoTransaction } from "./demo";
import { PageTitle } from "./management";
import type { Platform } from "./platform";
import { amountOf, executeLocal, localChallenge, sendCall, sign } from "./sandbox-client";
import type { Mode } from "./sandbox-client";

const steps = [
  { title: "Unpaid call", hint: "Request payment terms", icon: Send },
  { title: "Sign payment", hint: "Authorize USDC", icon: KeyRound },
  { title: "Paid execution", hint: "Receive result and receipt", icon: CircleDollarSign },
];

export function Sandbox({ platform }: { platform: Platform }) {
  const hasEdgeSandbox = platform.edge?.sandboxEnabled;
  const initial = (hasEdgeSandbox ? platform.publishedEndpoints : platform.endpoints).find((entry) => entry.is_active);
  const [chosen, setChosen] = useState(initial?.tool_name);
  const [customMode, setCustomMode] = useState<Mode>();
  const mode = customMode ?? (platform.edge?.sandboxEnabled ? "edge" : "local");
  const available = (mode === "local" ? platform.endpoints : platform.publishedEndpoints).filter((entry) => entry.is_active);
  const selected = available.find((entry) => entry.tool_name === chosen) ?? available[0];
  const [args, setArgs] = useState<Partial<Record<ToolName, string>>>({});
  const [run, setRun] = useState<{
    mode: Mode; body: ReturnType<typeof rpcCall>; challenge: Challenge; payment?: Payment; receipt?: Settlement; output?: unknown;
  }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"response" | "request">("response");
  const stage = !run ? 0 : !run.payment ? 1 : !run.receipt ? 2 : 3;
  const activeArgs = selected ? args[selected.tool_name] ?? JSON.stringify(toolExamples[selected.tool_name], null, 2) : "";

  function reset() { setRun(undefined); setError(""); setTab("response"); }
  async function advance() {
    if (!selected) return;
    setBusy(true); setError("");
    const started = performance.now();
    try {
      if (!run) {
        const input = jsonObject.parse(JSON.parse(activeArgs));
        if (!toolContracts[selected.tool_name].input.safeParse(input).success) throw new Error("Arguments do not match this tool’s input schema.");
        const request = rpcCall("tools/call", { name: selected.tool_name, arguments: input });
        const response = mode === "local" ? { status: 402, challenge: localChallenge(selected) } : await sendCall(mode, request);
        if (response.status !== 402 || !response.challenge) throw new Error(`Expected a payment challenge. Gateway returned HTTP ${response.status}.`);
        setRun({ mode, body: request, challenge: response.challenge });
        if (mode !== "wallet" && !platform.live) platform.addDemoEvent(demoTransaction("challenge_402", selected, { latency_ms: Math.round(performance.now() - started), request_meta: { sandbox: true, agent_name: "Sandbox Wallet", flow_id: String(request.id) } }));
      } else if (!run.payment) {
        setRun({ ...run, payment: await sign(run.mode, run.challenge) });
      } else if (!run.receipt) {
        let receipt: Settlement;
        let output: unknown;
        if (run.mode === "local") {
          const local = await executeLocal(selected, jsonObject.parse(run.body.params?.arguments), run.payment, run.challenge);
          receipt = local.receipt; output = local.data;
        } else {
          const response = await sendCall(run.mode, run.body, run.payment);
          if (response.status !== 200 || !response.receipt) throw new Error(`No settlement receipt received (HTTP ${response.status}). Inspect terms or reset the run.`);
          receipt = response.receipt; output = response.data;
        }
        setRun({ ...run, receipt, output });
        if (run.mode !== "wallet" && !platform.live) {
          const elapsed = Math.round(performance.now() - started);
          platform.addDemoEvent(demoTransaction("settled_200", selected, {
            latency_ms: elapsed, amount_usdc: amountOf(receipt), tx_hash: receipt.transaction, wallet_address: receipt.payer ?? null,
            request_meta: { sandbox: true, agent_name: "Sandbox Wallet", settlement_ms: elapsed, flow_id: String(run.body.id) },
          }));
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Protocol step failed.");
    } finally { setBusy(false); }
  }
  const view = !run ? null : tab === "request"
    ? { body: run.body, ...(run.payment ? { "X-PAYMENT": encodeHeader(run.payment) } : {}) }
    : run.receipt ? { "PAYMENT-RESPONSE": run.receipt, output: run.output }
    : run.payment ? { "X-PAYMENT (decoded)": run.payment }
    : { "PAYMENT-REQUIRED (decoded)": run.challenge };
  return <>
    <PageTitle icon={FlaskConical} section="PROTOCOL INSPECTOR" title="Payment sandbox" description="Inspect the request, EIP-712 authorization and settlement in three steps." />
    <div className="steps">{steps.map(({ title, hint, icon: Icon }, index) => <div className={`panel step ${stage === index ? "current" : ""} ${stage > index ? "done" : ""}`} key={title}>
      <span className="step-icon">{stage > index ? <Check size={17} /> : <Icon size={17} />}</span>
      <div><strong>{title}</strong><small>{hint}</small></div><span className="step-index">0{index + 1}</span>
    </div>)}</div>
    <div className="sandbox-grid">
      <section className="panel editor">
        <div className="panel-heading"><div><h2>Build request</h2><p><code>POST {mode === "wallet" ? "/mcp" : "/sandbox/mcp"}</code></p></div></div>
        <div className="form-stack">
          <label>Payment environment<select disabled={busy || stage > 0} value={mode} onChange={(event) => setCustomMode(event.target.value as Mode)}>
            {platform.edge?.sandboxEnabled && <option value="edge">Edge sandbox · Base Sepolia simulation</option>}
            <option value="local">Browser simulation · offline</option>
            {platform.edge?.mode === "live" && <option value="wallet">Connected wallet · live settlement</option>}
          </select></label>
          <label>MCP tool<select disabled={busy || stage > 0} value={selected?.tool_name ?? ""} onChange={(event) => {
            const name = event.target.value as keyof typeof toolExamples;
            setChosen(name);
          }}><option value="" disabled>Select a tool</option>{available.map((entry) => <option key={entry.id} value={entry.tool_name}>{toolContracts[entry.tool_name].title}</option>)}</select></label>
          <label>Arguments <textarea className="code-input" rows={11} spellCheck={false} disabled={busy || stage > 0} value={activeArgs} onChange={(event) => selected && setArgs({ ...args, [selected.tool_name]: event.target.value })} /></label>
          {mode === "wallet" && <p className="notice amber-ink">This mode can move real USDC. Review the authorization in your wallet.</p>}
          {run && <p className="notice">Authorized {run.challenge.accepts[0].scheme === "upto" ? "cap" : "amount"} <strong>{unitsToUsdc(run.challenge.accepts[0].amount).toFixed(3)} USDC</strong></p>}
          <p role="status" className="error-ink">{error}</p>
          <div className="form-actions"><button className="secondary" onClick={reset} disabled={busy}><RotateCcw size={15} /> Reset</button>
            <button className="primary" onClick={() => void advance()} disabled={!selected || busy || stage === 3}>{busy ? "Working…" : stage === 0 ? "Send unpaid call" : stage === 1 ? "Sign authorization" : stage === 2 ? "Execute paid call" : "Settled"} <ArrowRight size={15} /></button></div>
        </div>
      </section>
      <section className="panel protocol-panel">
        <div className="panel-heading"><div><h2>Protocol output</h2><p>Decoded headers and JSON-RPC payload</p></div>
          {stage === 3 ? <span className="status-badge green"><i />200 SETTLED</span> : stage === 2 ? <span className="status-badge cyan"><i />SIGNED</span> : stage === 1 ? <span className="status-badge amber"><i />402 CHALLENGE</span> : <span className="subtle-pill">AWAITING CALL</span>}
        </div>
        <div className="code-tabs" role="group" aria-label="Inspect payload">
          <button aria-pressed={tab === "response"} onClick={() => setTab("response")}>Response</button><button aria-pressed={tab === "request"} onClick={() => setTab("request")}>Request</button>
        </div>
        {view ? <pre className="code-output">{JSON.stringify(view, null, 2)}</pre> : <div className="output-empty"><Code2 size={27} /><p>Send a request to inspect the response.</p></div>}
      </section>
    </div>
  </>;
}
