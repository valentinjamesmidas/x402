import type { Endpoint } from "@platform/shared/database";
import { auditContract, sandboxKyb, scoreArbitrage } from "@platform/shared/judgment";
import { MCP_VERSION, rpcCall } from "@platform/shared/mcp";
import type { JsonObject } from "@platform/shared/mcp";
import { toolExamples, arbitrageInput, contractInput, kybInput } from "@platform/shared/tool-contracts";
import {
  decodeHeader, encodeHeader, headers, makeRequirements, paymentRequired, sandboxFacilitator, sandboxPayTo, settlementSchema, unitsToUsdc,
} from "@platform/shared/x402";
import type { Challenge, Payment, Settlement } from "@platform/shared/x402";
import { edgeOrigin } from "./platform";

export type Mode = "edge" | "local" | "wallet";
export { encodeHeader };
export async function sendCall(mode: Mode, body: ReturnType<typeof rpcCall>, payment?: Payment) {
  const path = mode === "wallet" ? "/mcp" : "/sandbox/mcp";
  const result = await fetch(`${edgeOrigin}${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(60_000),
    headers: {
      Accept: "application/json, text/event-stream", "Content-Type": "application/json",
      "MCP-Protocol-Version": MCP_VERSION, "Mcp-Method": body.method, "Mcp-Name": String(body.params?.name),
      ...(mode === "edge" ? { "X-Sandbox-Agent": "command-center" } : {}),
      ...(payment ? { [headers.legacySignature]: encodeHeader(payment) } : {}),
    },
    body: JSON.stringify(body),
  });
  const data: unknown = await result.json();
  const required = result.headers.get(headers.required);
  const receipt = result.headers.get(headers.response);
  return {
    status: result.status, data,
    challenge: required ? paymentRequired.parse(decodeHeader(required)) : null,
    receipt: receipt ? settlementSchema.parse(decodeHeader(receipt)) : null,
  };
}

export function localChallenge(endpoint: Endpoint): Challenge {
  return {
    x402Version: 2, error: "PAYMENT-SIGNATURE header is required",
    resource: { url: new URL("/sandbox/mcp", location.origin).href, description: endpoint.description, mimeType: "application/json" },
    accepts: [makeRequirements(endpoint.price_usdc, endpoint.pricing_scheme, "eip155:84532", sandboxPayTo, sandboxFacilitator)],
  };
}

export async function sign(mode: Mode, challenge: Challenge) {
  if (mode === "wallet") return (await import("./wallet")).signWithConnectedWallet(challenge);
  return (await import("@platform/shared/payment-evm")).signSandboxPayment(challenge);
}

export async function executeLocal(endpoint: Endpoint, args: JsonObject, payment: Payment, challenge: Challenge) {
  const { verifyEvmPayment } = await import("@platform/shared/payment-evm");
  const { payer, nonce } = await verifyEvmPayment(payment, challenge.accepts[0]);
  const storageKey = `x402:used:${nonce}`;
  if (sessionStorage.getItem(storageKey)) throw new Error("This payment authorization has already been used.");
  sessionStorage.setItem(storageKey, "1");
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
  const tx = `0x${Array.from(new Uint8Array(raw), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const max = BigInt(challenge.accepts[0].amount);
  const used = max / 10n + BigInt(new TextEncoder().encode(JSON.stringify(args)).byteLength) * 2n;
  const receipt: Settlement = { success: true, transaction: tx, network: "eip155:84532", payer, amount: String(endpoint.pricing_scheme === "upto" && used < max ? used : max) };
  const data = endpoint.tool_name === "cross_border_price_arbitrage" ? scoreLocal(args) :
    endpoint.tool_name === "contract_and_tender_risk_audit" ? auditContract(contractInput.parse(args)) : sandboxKyb(kybInput.parse(args));
  return { receipt, data };
}
function scoreLocal(args: JsonObject) {
  const input = arbitrageInput.parse(args);
  return scoreArbitrage(input, input.offers ?? toolExamples.cross_border_price_arbitrage.offers, input.offers ? "caller" : "sandbox");
}
export const amountOf = (receipt: Settlement) => receipt.amount ? unitsToUsdc(receipt.amount) : 0;
