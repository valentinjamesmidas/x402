import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { z } from "zod";
import { address, chain, settlementSchema } from "@platform/shared/x402";
import type { Network, Payment, Requirements } from "@platform/shared/x402";
import type { Env, Lifetime } from "./env";

const supported = z.object({ kinds: z.array(z.object({
  x402Version: z.number(), scheme: z.string(), network: z.string(),
  extra: z.object({ facilitatorAddress: address.optional() }).passthrough().optional(),
})) });
const verification = z.object({ isValid: z.boolean(), payer: address.optional() });

async function call(env: Env, operation: "verify" | "settle" | "supported", payload?: unknown) {
  const base = (env.FACILITATOR_URL ?? "https://x402.org/facilitator").replace(/\/$/, "");
  const url = new URL(`${base}/${operation}`);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Invalid facilitator URL");
  const method = operation === "supported" ? "GET" : "POST";
  let token = env.FACILITATOR_TOKEN;
  if (env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET) {
    if (url.hostname !== "api.cdp.coinbase.com") throw new Error("CDP authorization requires Coinbase's API hostname");
    token = await generateJwt({
      apiKeyId: env.CDP_API_KEY_ID, apiKeySecret: env.CDP_API_KEY_SECRET,
      requestMethod: method, requestHost: url.host, requestPath: url.pathname,
    });
  }
  const response = await fetch(url, {
    method, redirect: "error", signal: AbortSignal.timeout(operation === "settle" ? 30_000 : 7000),
    headers: { "Content-Type": "application/json", Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!response.ok) throw new Error(`Facilitator ${operation} unavailable`);
  return response.json();
}
export async function facilitatorAddress(env: Env, network: Network, lifetime: Lifetime) {
  const key = `facilitator:v1:${env.FACILITATOR_URL ?? "public"}:${network}`;
  const cache = await env.X402_NONCE_STORE?.get(key).catch(() => null);
  if (cache) return address.parse(cache);
  const list = supported.parse(await call(env, "supported"));
  const entry = list.kinds.find((kind) => kind.x402Version === 2 && kind.network === network && kind.scheme === "upto");
  const facilitator = address.parse(entry?.extra?.facilitatorAddress);
  if (env.X402_NONCE_STORE) lifetime.waitUntil(env.X402_NONCE_STORE.put(key, facilitator, { expirationTtl: 60 }).catch(() => undefined));
  return facilitator;
}

function message(paymentPayload: Payment, paymentRequirements: Requirements) {
  return { x402Version: 2, paymentPayload, paymentRequirements };
}
export async function verifyAtFacilitator(env: Env, payment: Payment, requirements: Requirements, payer: string) {
  const verified = verification.parse(await call(env, "verify", message(payment, requirements)));
  return verified.isValid && (!verified.payer || verified.payer.toLowerCase() === payer);
}
export async function settleAtFacilitator(env: Env, payment: Payment, requirements: Requirements, payer: string, amount: string) {
  const result = settlementSchema.parse(await call(env, "settle", message(payment, { ...requirements, amount })));
  if (chain.parse(result.network) !== requirements.network || (result.payer && result.payer.toLowerCase() !== payer) ||
    (result.amount !== undefined && result.amount !== amount)) {
    throw new Error("Facilitator receipt disagrees with settlement terms");
  }
  return result;
}
