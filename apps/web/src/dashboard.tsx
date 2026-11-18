import { useMemo, useState } from "react";
import { Activity, ArrowDownRight, ArrowRight, ArrowUpRight, ChevronDown, CircleDollarSign, Clock3, ExternalLink, Radio, Route, Terminal, UsersRound } from "lucide-react";
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Transaction } from "@platform/shared/database";
import type { ToolName } from "@platform/shared/mcp";
import { toolNames } from "@platform/shared/mcp";
import { networks } from "@platform/shared/x402";

export const statusInfo = {
  settled_200: { label: "200 SETTLED", tone: "green" },
  challenge_402: { label: "402 CHALLENGE", tone: "amber" },
  failed_signature: { label: "INVALID SIGNATURE", tone: "red" },
  rate_limited: { label: "429 RATE LIMITED", tone: "red" },
  discovery_200: { label: "200 DISCOVERY", tone: "cyan" },
  failed_execution: { label: "EXECUTION FAILED", tone: "red" },
} as const;
export const toolLabels: Record<ToolName, string> = {
  cross_border_price_arbitrage: "Price Arbitrage",
  contract_and_tender_risk_audit: "Risk Audit",
  verified_entity_kyb_oracle: "KYB Oracle",
};
const colors = ["#44e8ca", "#6e91ff", "#a184fa"] as const;
const number = new Intl.NumberFormat("en-US");
const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const hours = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
const usdc = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const getAgent = (row: Transaction) => typeof row.request_meta.agent_name === "string" ? row.request_meta.agent_name : row.agent_id ?? "Anonymous agent";
const short = (text: string) => text.length > 20 ? `${text.slice(0, 10)}…${text.slice(-5)}` : text;

export function Dashboard({ events, live, connected, openSandbox }: {
  events: Transaction[]; live: boolean; connected: boolean; openSandbox: () => void;
}) {
  const [period, setPeriod] = useState(24);
  const [showFixtures, setShowFixtures] = useState(false);
  const [filter, setFilter] = useState<"all" | Transaction["status"]>("all");
  const [showAll, setShowAll] = useState(false);
  const summary = useMemo(() => {
    const now = Date.now();
    const currentHour = Math.floor(now / 3_600_000) * 3_600_000;
    const rows = events.filter((row) => Date.parse(row.created_at) > now - period * 3_600_000
      && (!live || (showFixtures ? row.request_meta.sandbox === true : row.request_meta.sandbox !== true)));
    const paid = rows.filter((row) => row.status === "settled_200");
    const challenges = rows.filter((row) => row.status === "challenge_402");
    const challenged = new Set(challenges.map((row) => row.request_meta.flow_id ?? row.id));
    const converted = new Set(paid.map((row) => row.request_meta.flow_id).filter((flow) => typeof flow === "string" && challenged.has(flow)));
    const discovery = rows.filter((row) => row.status === "discovery_200").length;
    const unique = new Set(rows.map((row) => row.agent_id ?? row.wallet_address).filter(Boolean)).size;
    const times = paid.flatMap((row) => typeof row.request_meta.settlement_ms === "number" ? [row.request_meta.settlement_ms] : []).sort((a, b) => a - b);
    const middle = Math.floor(times.length / 2);
    const median = times.length ? (times.length % 2 ? times[middle] : Math.round((times[middle - 1] + times[middle]) / 2)) : null;
    const buckets = Array.from({ length: period }, (_, index) => ({
      timestamp: currentHour - (period - index - 1) * 3_600_000,
      cross_border_price_arbitrage: 0, contract_and_tender_risk_audit: 0, verified_entity_kyb_oracle: 0,
    }));
    const byHour = new Map(buckets.map((bucket) => [bucket.timestamp, bucket]));
    for (const row of paid) {
      const bucket = byHour.get(Math.floor(Date.parse(row.created_at) / 3_600_000) * 3_600_000);
      if (bucket && row.tool_name) bucket[row.tool_name] += row.amount_usdc;
    }
    return {
      rows, paid, challenge: challenges.length, discovery, unique, median, buckets,
      revenue: paid.reduce((total, row) => total + row.amount_usdc, 0),
      conversion: challenged.size ? converted.size / challenged.size * 100 : null,
    };
  }, [events, period, showFixtures, live]);
  const traffic = summary.rows.filter((row) => filter === "all" || row.status === filter);
  const total = summary.discovery + summary.paid.length;
  const discoveryPercent = total ? Math.round(summary.discovery / total * 100) : 0;
  const metrics = [
    { label: "Revenue", icon: CircleDollarSign, tone: "green", value: usdc(summary.revenue), unit: "USDC", detail: `${number.format(summary.paid.length)} settled payments` },
    { label: "Payment conversion", icon: Route, tone: "amber", value: summary.conversion === null ? "—" : summary.conversion.toFixed(1), unit: summary.conversion === null ? "" : "%", detail: `${number.format(summary.challenge)} challenges issued` },
    { label: "Active agents", icon: UsersRound, tone: "cyan", value: number.format(summary.unique), unit: "", detail: "Unique identities & wallets" },
    { label: "Settlement latency", icon: Clock3, tone: "violet", value: summary.median ?? "—", unit: summary.median === null ? "" : "ms", detail: "Median across paid calls" },
  ];
  const chartValues = [
    { name: "Free discovery", value: summary.discovery, color: "#51e8cf" },
    { name: "Paid execution", value: summary.paid.length, color: "#8875f7" },
  ];
  return <>
    <div className="page-heading">
      <div><p className="eyebrow"><Activity size={14} /> GATEWAY TELEMETRY</p><h1>Overview</h1>
        <p>Monitor x402 payments and MCP traffic across your gateway.</p></div>
      <div className="page-actions">
        {live && <label className="check fixtures"><input type="checkbox" checked={showFixtures} onChange={(event) => setShowFixtures(event.target.checked)} /> Sandbox</label>}
        <label className="select-control"><Clock3 size={15} /><span className="sr-only">Time range</span><select value={period} onChange={(event) => setPeriod(Number(event.target.value))}><option value={24}>Last 24 hours</option><option value={12}>Last 12 hours</option><option value={6}>Last 6 hours</option></select><ChevronDown size={13} /></label>
        <button className="primary" onClick={openSandbox}>Run sandbox <ArrowUpRight size={16} /></button>
      </div>
    </div>

    <section className="metric-grid" aria-label="Key metrics">
      {metrics.map(({ label, icon: Icon, tone, value, unit, detail }) => <article className="panel metric" key={label}>
        <div className="metric-top"><span>{label}</span><span className={`metric-icon ${tone}`}><Icon size={16} strokeWidth={1.8} /></span></div>
        <div className="metric-value">{value} {unit && <small>{unit}</small>}</div>
        <div className="metric-detail">{detail}</div>
      </article>)}
    </section>

    <div className="charts-grid">
      <section className="panel chart-panel">
        <div className="panel-heading"><div><h2>Revenue over time</h2><p>Hourly USDC settlements by MCP tool</p></div><span className="subtle-pill">USDC</span></div>
        <div className="area-chart" role="img" aria-label="Hourly USDC settlements by MCP tool">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <AreaChart data={summary.buckets} margin={{ top: 13, right: 7, bottom: 0, left: -7 }}>
              <defs>{colors.map((color, index) => <linearGradient key={color} id={`area-${index}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="2%" stopColor={color} stopOpacity={0.28} /><stop offset="96%" stopColor={color} stopOpacity={0.025} />
              </linearGradient>)}</defs>
              <CartesianGrid vertical={false} stroke="#252834" strokeDasharray="3 4" />
              <XAxis dataKey="timestamp" tickFormatter={(value: number) => hours.format(value)} interval={period === 24 ? 4 : period === 12 ? 2 : 0} tick={{ fill: "#828a9c", fontSize: 10 }} tickMargin={11} axisLine={false} tickLine={false} />
              <YAxis width={45} domain={[0, "auto"]} tickFormatter={(value: number) => value.toFixed(2)} tick={{ fill: "#828a9c", fontSize: 10 }} axisLine={false} tickLine={false} tickMargin={8} />
              <Tooltip labelFormatter={(value) => hours.format(Number(value))} formatter={(value) => `${usdc(Number(value))} USDC`}
                contentStyle={{ background: "#131622", border: "1px solid #2a3040", borderRadius: 8, fontSize: 12 }} />
              {toolNames.map((tool, index) => <Area key={tool} dataKey={tool} type="monotone" name={toolLabels[tool]} stroke={colors[index]} strokeWidth={1.9} fill={`url(#area-${index})`} isAnimationActive={false} />)}
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="legend">{toolNames.map((tool, index) => <span key={tool}><i style={{ background: colors[index] }} />{toolLabels[tool]}</span>)}</div>
      </section>

      <section className="panel chart-panel breakdown">
        <div className="panel-heading"><div><h2>Request mix</h2><p>MCP discovery vs. paid execution</p></div><span className="panel-icon"><Radio size={17} /></span></div>
        <div className="donut" role="img" aria-label={`${summary.discovery} free discovery and ${summary.paid.length} paid execution requests`}>
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <PieChart><Pie data={total ? chartValues : [{ ...chartValues[0], value: 1, color: "#252935" }]} dataKey="value" innerRadius={57} outerRadius={72}
              startAngle={90} endAngle={-270} paddingAngle={total ? 4 : 0} stroke="none" cornerRadius={4} isAnimationActive={false}>
              {(total ? chartValues : [{ color: "#252935" }]).map(({ color }) => <Cell key={color} fill={color} />)}
            </Pie></PieChart>
          </ResponsiveContainer>
          <div className="donut-center"><strong>{number.format(total)}</strong><span>REQUESTS</span></div>
        </div>
        <div className="mix-legend">{chartValues.map(({ name, value, color }, index) => <div key={name}>
          <span><i style={{ background: color }} />{name}</span><small>{index === 0 ? discoveryPercent : total ? 100 - discoveryPercent : 0}%</small><strong>{number.format(value)}</strong>
        </div>)}</div>
      </section>
    </div>

    <section className="panel terminal-panel" aria-label="Traffic terminal">
      <div className="panel-heading terminal-heading">
        <div className="terminal-title"><span className="terminal-icon"><Terminal size={19} /></span><div><h2>Traffic terminal</h2><p>Recent requests on the x402 gateway</p></div>{connected && <span className="live-pill"><i /> LIVE</span>}</div>
        <label className="select-control filter"><span className="sr-only">Filter traffic status</span><select value={filter} onChange={(event) => { setFilter(event.target.value as typeof filter); setShowAll(false); }}><option value="all">All statuses</option>{Object.entries(statusInfo).map(([status, info]) => <option value={status} key={status}>{info.label}</option>)}</select><ChevronDown size={13} /></label>
      </div>
      <div className="table-scroll"><table className="traffic-table"><thead><tr><th>TIME</th><th>AGENT</th><th>TOOL / METHOD</th><th>STATUS</th><th>AMOUNT</th><th>LATENCY</th><th><span className="sr-only">Explorer</span></th></tr></thead>
        <tbody>{traffic.slice(0, showAll ? 60 : 7).map((row) => {
          const badge = statusInfo[row.status];
          const explorer = networks[row.network as keyof typeof networks]?.explorer;
          return <tr key={row.id}><td className="mono muted">{time.format(new Date(row.created_at))}</td>
            <td><span className="table-agent"><span className={`agent-icon ${badge.tone}`}>{row.status === "settled_200" ? <ArrowDownRight size={13} /> : <ArrowRight size={13} />}</span><span title={getAgent(row)}>{short(getAgent(row))}</span></span></td>
            <td>{row.tool_name ? toolLabels[row.tool_name] : <code>tools/list</code>}</td>
            <td><span className={`status-badge ${badge.tone}`}><i />{badge.label}</span></td>
            <td className={`mono ${row.amount_usdc > 0 ? "green-ink" : "muted"}`}>{row.amount_usdc > 0 ? `+${usdc(row.amount_usdc)}` : "—"}</td>
            <td className="mono muted">{row.latency_ms} ms</td>
            <td>{row.tx_hash && explorer && row.request_meta.sandbox !== true && <a href={`${explorer}${row.tx_hash}`} target="_blank" rel="noreferrer" aria-label="Open on BaseScan" title={row.tx_hash}><ExternalLink size={14} /></a>}</td></tr>;
        })}</tbody></table>
        {!traffic.length && <div className="empty">No requests for this view.</div>}
      </div>
      {traffic.length > 7 && <div className="table-footer"><span>Showing {Math.min(showAll ? 60 : 7, traffic.length)} of {number.format(traffic.length)} events</span><button className="text-button" onClick={() => setShowAll(!showAll)}>{showAll ? "Show recent only" : "Show more events"} <ArrowRight size={14} /></button></div>}
    </section>
  </>;
}
