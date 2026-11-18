import type { Context } from "hono";
import type { ToolName } from "@platform/shared/mcp";
import type { Agent, Endpoint, Transaction } from "@platform/shared/database";
import { verifyEvmPayment } from "@platform/shared/payment-evm";
import {
  address, chain, decodeHeader, encodeHeader, headers, makeRequirements, networks, paymentPayload, sandboxFacilitator, sandboxPayTo, unitsToUsdc,
} from "@platform/shared/x402";
import type { Challenge, Network, Payment, Settlement } from "@platform/shared/x402";
import type { Env } from "./env";
import { facilitatorAddress, settleAtFacilitator, verifyAtFacilitator } from "./facilitator";
import { lookupAgent, recordEvent } from "./repository";
import type { Db, Event } from "./repository";
import { hash } from "./sha";
import { runTool } from "./tools";

type EdgeContext = Context<{ Bindings: Env }>;
type RequestId = string | number;
export function sandboxRequest(env: Env, path: string) {
  return env.SANDBOX_MODE === "true" || path === "/sandbox/mcp";
}

export function recordFor(c: EdgeContext, db: Db, start: number, sandbox: boolean, network: Network, endpoint?: Endpoint, agent?: Agent | null) {
  return (status: Transaction["status"], fields: Partial<Event> = {}) => {
    const label = (c.req.header("User-Agent") ?? "").slice(0, 100);
    recordEvent(c.executionCtx, db, {
      endpoint_id: endpoint?.id ?? null, tool_name: endpoint?.tool_name ?? null,
      agent_id: agent?.id ?? null, wallet_address: null, network, amount_usdc: 0,
      tx_hash: null, status, latency_ms: Math.max(0, Math.round(performance.now() - start)),
      request_meta: { sandbox, identity_verified: !!agent, agent_name: agent?.agent_name ?? (label || "Unknown agent") },
      ...fields,
    });
  };
}

const errorBody = (id: RequestId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

export const operatorPrice = (endpoint: Endpoint, agent: Agent | null, sandbox: boolean) =>
  !sandbox && agent?.kya_verified && agent.total_calls >= 10 && agent.total_spent_usdc > 0
    ? Math.max(0.001, endpoint.price_usdc * 0.9) : endpoint.price_usdc;

export function meteredAmount(maximum: string, scheme: "exact" | "upto", args: unknown) {
  if (scheme === "exact") return maximum;
  const cap = BigInt(maximum);
  const bytes = BigInt(new TextEncoder().encode(JSON.stringify(args)).byteLength);
  const used = cap / 10n + bytes * 2n;
  return (used < cap ? used : cap).toString();
}

export async function paidTool(c: EdgeContext, options: {
  db: Db; endpoint: Endpoint; name: ToolName; args: unknown; agent: Agent | null;
  sandbox: boolean; id: RequestId; start: number;
}) {
  const { db, endpoint, name, args, agent, sandbox, id, start } = options;
  const env = c.env;
  const network = sandbox ? "eip155:84532" : chain.parse(env.X402_NETWORK ?? "eip155:8453");
  const record = recordFor(c, db, start, sandbox, network, endpoint, agent);
  if (!sandbox && !db) return c.json(errorBody(id, -32001, "Live payment configuration unavailable"), 503);

  const flowId = await hash(JSON.stringify([name, id, agent?.id ?? c.req.header("CF-Connecting-IP"), args]));
  const event = (status: Transaction["status"], fields: Partial<Event> = {}) =>
    record(status, { ...fields, request_meta: {
      sandbox, identity_verified: !!agent, agent_name: agent?.agent_name ?? c.req.header("User-Agent")?.slice(0, 100) ?? "Unknown agent",
      ...fields.request_meta, flow_id: flowId,
    } });

  const route = new URL(c.req.url);
  route.search = "";
  route.hash = "";
  const payTo = sandbox ? sandboxPayTo : address.parse(env.OPERATOR_WALLET_ADDRESS);
  if (!sandbox && payTo.toLowerCase() === sandboxPayTo.toLowerCase()) {
    return c.json(errorBody(id, -32001, "Live payment configuration unavailable"), 503);
  }
  const facilitator = endpoint.pricing_scheme === "upto"
    ? sandbox ? sandboxFacilitator : await facilitatorAddress(env, network, c.executionCtx)
    : undefined;
  const required = makeRequirements(operatorPrice(endpoint, agent, sandbox), endpoint.pricing_scheme, network, payTo, facilitator);
  const challenge: Challenge = {
    x402Version: 2,
    resource: { url: route.href, description: endpoint.description, mimeType: "application/json" },
    accepts: [required],
  };
  const requirePayment = (message: string, status: "challenge_402" | "failed_signature") => {
    event(status);
    const paymentRequired = { ...challenge, error: message };
    c.header(headers.required, encodeHeader(paymentRequired));
    return c.json(paymentRequired, 402);
  };

  const canonical = c.req.header(headers.signature);
  const alias = c.req.header(headers.legacySignature);
  const signature = canonical ?? alias;
  if (!signature) return requirePayment("PAYMENT-SIGNATURE header is required", "challenge_402");
  if (canonical && alias && canonical !== alias) return requirePayment("Conflicting payment headers", "failed_signature");

  let payment: Payment;
  let authorization: Awaited<ReturnType<typeof verifyEvmPayment>>;
  try {
    payment = paymentPayload.parse(decodeHeader(signature));
    if (payment.resource && payment.resource.url !== route.href) throw new Error("Resource mismatch");
    authorization = await verifyEvmPayment(payment, required);
  } catch {
    return requirePayment("Payment authorization is invalid or terms have changed", "failed_signature");
  }
  const { payer, nonce, expiresAt } = authorization;
  const blockedWallet = !sandbox && db ? (await lookupAgent(db, "wallet_address", payer))?.is_blocked : false;
  if (!sandbox && (blockedWallet || (agent?.wallet_address && agent.wallet_address.toLowerCase() !== payer))) {
    event("failed_signature");
    return c.json(errorBody(id, -32003, "Wallet is blocked or does not match the signed identity"), 403);
  }

  const namespace = sandbox ? "sandbox" : "live";
  // The namespace matches the scope of the contract nonce. KV is an advisory fast path.
  const nonceKey = `payment:${await hash(`${namespace}:${network}:${required.scheme}:${payer}:${nonce}`)}`;
  const cached = await env.X402_NONCE_STORE?.get(nonceKey).catch(() => null);
  if (cached) return c.json(errorBody(id, -32009, "Payment authorization already used"), 409);

  if (!sandbox && !(await verifyAtFacilitator(env, payment, required, payer))) {
    return requirePayment("Facilitator rejected the payment authorization", "failed_signature");
  }
  if (!(await env.GATES.getByName(nonceKey).claim(expiresAt + 60_000))) {
    return c.json(errorBody(id, -32009, "Payment authorization already used"), 409);
  }
  if (env.X402_NONCE_STORE) c.executionCtx.waitUntil(env.X402_NONCE_STORE.put(nonceKey, "1", {
    expirationTtl: Math.max(60, Math.ceil((expiresAt - Date.now()) / 1000) + 60),
  }).catch(() => undefined));

  let output: Awaited<ReturnType<typeof runTool>>;
  try {
    output = await runTool(name, args, env, sandbox);
  } catch {
    event("failed_execution", { wallet_address: payer });
    return c.json({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "Tool could not complete. No settlement was requested." }] } });
  }

  const amount = meteredAmount(required.amount, required.scheme, args);
  const settleStarted = performance.now();
  let receipt: Settlement;
  try {
    receipt = sandbox ? {
      success: true, transaction: `0x${await hash(nonceKey)}`, network, payer, amount,
    } : await settleAtFacilitator(env, payment, required, payer, amount);
  } catch {
    event("failed_execution", { wallet_address: payer, request_meta: { sandbox, identity_verified: !!agent, settlement: "unconfirmed" } });
    return c.json(errorBody(id, -32001, "Settlement could not be confirmed"), 503);
  }
  const tx = receipt.transaction.toLowerCase();
  const txKey = `transaction:${await hash(`${namespace}:${network}:${tx}`)}`;
  const transactionSeen = await env.X402_NONCE_STORE?.get(txKey).catch(() => null);
  if (transactionSeen || !(await env.GATES.getByName(txKey).claim(Date.now() + 30 * 24 * 60 * 60_000))) {
    return c.json(errorBody(id, -32009, "Settlement already recorded"), 409);
  }
  if (env.X402_NONCE_STORE) c.executionCtx.waitUntil(env.X402_NONCE_STORE.put(txKey, "1", { expirationTtl: 2_592_000 }).catch(() => undefined));

  const settledAmountUsdc = unitsToUsdc(amount);
  const settlementMs = Math.max(0, Math.round(performance.now() - settleStarted));
  event("settled_200", {
    wallet_address: payer, amount_usdc: settledAmountUsdc, tx_hash: tx,
    request_meta: { sandbox, identity_verified: !!agent, settlement_ms: settlementMs, agent_name: agent?.agent_name ?? (c.req.header("X-Sandbox-Agent") && sandbox ? "Sandbox Wallet" : payer) },
  });
  c.header(headers.response, encodeHeader({ ...receipt, transaction: tx, payer, amount }));
  c.header(headers.legacyResponse, encodeHeader({ txHash: tx, settledAmountUsdc, network: networks[network].name, sandbox }));
  return c.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output } });
}
