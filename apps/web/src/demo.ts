import { defaultEndpoints } from "@platform/shared/database";
import type { Agent, Endpoint, Transaction } from "@platform/shared/database";

const names = ["Arbitrage-Agent", "OAI-SearchBot", "Claude-MCP", "RiskSignal-EU", "Atlas-KYB", "TradeDesk-AI", "Peregrine", "AgentBridge"];
const time = Date.now();
export const demoAgents: Agent[] = names.map((name, index) => ({
  id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  agent_name: name, user_agent: `${name}/1.0`, ed25519_pubkey: index < 5 ? "c2FuZGJveC1leGFtcGxl" : null,
  signature_key_id: index < 5 ? `fixture-${index + 1}` : null,
  wallet_address: `0x${(123_456 + index * 234_567).toString(16).repeat(8).slice(0, 40)}`,
  kya_verified: index < 5, total_spent_usdc: Math.round(3981 / (index + 2)) / 100,
  total_calls: 175 - index * 19, rate_limit_rpm: index < 5 ? 120 : 60,
  is_blocked: index === 7, last_seen_at: new Date(time - index * 980_000).toISOString(),
}));
const hourly = [6, 8, 5, 9, 7, 13, 12, 10, 17, 15, 19, 15, 21, 16, 22, 20, 24, 28, 21, 30, 25, 27, 30, 32];
const nowHour = Math.floor(time / 3_600_000) * 3_600_000;

export function demoTransaction(status: Transaction["status"], endpoint?: Endpoint, fields: Partial<Transaction> = {}): Transaction {
  return {
    id: crypto.randomUUID(), created_at: new Date().toISOString(), endpoint_id: endpoint?.id ?? null, tool_name: endpoint?.tool_name ?? null,
    agent_id: null, wallet_address: null, network: "eip155:84532", tx_hash: null, amount_usdc: 0, latency_ms: 0,
    status, request_meta: { sandbox: true, agent_name: "Sandbox Wallet" }, ...fields,
  };
}

export const demoEvents = hourly.flatMap((volume, hour) => {
  const startsAt = nowHour - (23 - hour) * 3_600_000;
  const duration = Math.min(3_600_000, Math.max(0, time - startsAt - 1500));
  return Array.from({ length: volume }, (_, index) => {
    const sequence = hour * 1000 + index * 4 + 1;
    const endpoint = defaultEndpoints[(index + hour) % 3];
    const agent = demoAgents[(index * 3 + hour) % demoAgents.length];
    const created = startsAt + Math.floor((index + 1) * duration / (volume + 1));
    const hash = (BigInt(sequence) * 0x1d129914c0fa61ben).toString(16);
    const flow = `demo-${sequence}`;
    const events: Transaction["status"][] = ["discovery_200", "challenge_402"];
    if ((index * 7 + hour * 3) % 10 < 8) events.push("settled_200");
    else events.push(index % 2 ? "failed_signature" : "rate_limited");
    return events.map((status, step) => {
      const isPaid = status === "settled_200";
      const exact = endpoint.pricing_scheme === "exact";
      const paid = exact ? endpoint.price_usdc : Math.round(endpoint.price_usdc * (20 + (hour + index) % 30) * 10_000) / 1_000_000;
      return demoTransaction(status, status === "discovery_200" ? undefined : endpoint, {
        created_at: new Date(Math.min(time - 1000, created + step * 2700)).toISOString(),
        id: `20000000-0000-4000-8000-${String(sequence + step).padStart(12, "0")}`,
        agent_id: agent.id, wallet_address: agent.wallet_address,
        amount_usdc: isPaid ? paid : 0,
        tx_hash: isPaid ? `0x${hash.repeat(5).slice(0, 64)}` : null,
        latency_ms: 52 + (hour * 23 + index * 31 + step * 11) % 240,
        request_meta: { sandbox: true, seed: true, agent_name: agent.agent_name, settlement_ms: 80 + (hour * 17 + index * 7) % 191, flow_id: flow },
      });
    });
  }).flat();
}).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
