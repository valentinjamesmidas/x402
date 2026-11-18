import { describe, expect, it } from "vitest";
import { defaultEndpoints } from "@platform/shared/database";
import { MCP_VERSION, rpcCall, toolNames } from "@platform/shared/mcp";
import { signSandboxPayment } from "@platform/shared/payment-evm";
import { toolExamples } from "@platform/shared/tool-contracts";
import { decodeHeader, encodeHeader, headers, paymentRequired, settlementSchema } from "@platform/shared/x402";
import { app } from "./app";
import type { Env } from "./env";
import { validOperatorSchema } from "./tools";

const origin = "https://gateway.example";
function setup() {
  const claims = new Set<string>();
  const env = {
    SANDBOX_MODE: "true",
    GATES: { getByName: (key: string) => ({
      allow: async () => true,
      claim: async () => {
        if (claims.has(key)) return false;
        claims.add(key);
        return true;
      },
    }) },
  } as unknown as Env;
  const context = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} };
  return (body: ReturnType<typeof rpcCall>, extra: Record<string, string> = {}) => Promise.resolve(app.request(`${origin}/mcp`, {
    method: "POST", body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_VERSION, "Mcp-Method": body.method, ...(body.params?.name ? { "Mcp-Name": String(body.params.name) } : {}), ...extra,
    },
  }, env, context));
}

describe("Streamable HTTP", () => {
  it("publishes server capabilities and typed, priced tools without payment", async () => {
    const request = setup();
    const discovery = await request(rpcCall("server/discover"));
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({ result: { supportedVersions: expect.arrayContaining([MCP_VERSION]) } });
    const list = await request(rpcCall("tools/list"));
    expect(list.status).toBe(200);
    expect(list.headers.get(headers.required)).toBeNull();
    expect(await list.json()).toMatchObject({ result: { tools: toolNames.map((name) => ({
      name, inputSchema: { type: "object" }, outputSchema: { type: "object" }, x402_pricing: { currency: "USDC" },
    })) } });
  });

  it("checks the 2026 routing headers and rejects foreign origins", async () => {
    const request = setup();
    const mismatch = await request(rpcCall("tools/list"), { "Mcp-Method": "ping" });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ error: { code: -32020 } });
    expect((await request(rpcCall("tools/list"), { Origin: "https://other.example" })).status).toBe(403);
  });

  it("accepts the compiled tool schema and rejects external or executable schema features", () => {
    expect(defaultEndpoints.every((entry) => validOperatorSchema(entry.input_schema))).toBe(true);
    expect(validOperatorSchema({ type: "object", properties: { a: { $ref: "https://outside.example" } } })).toBe(false);
  });
});

describe("x402 v2 sandbox", () => {
  for (const name of toolNames) {
    it(`verifies, settles and prevents replay for ${name}`, async () => {
      const request = setup();
      const body = rpcCall("tools/call", { name, arguments: toolExamples[name] });
      const unpaid = await request(body);
      expect(unpaid.status).toBe(402);
      const challenge = paymentRequired.parse(decodeHeader(unpaid.headers.get(headers.required)!));
      expect(await unpaid.json()).toEqual(challenge);
      const payment = await signSandboxPayment(challenge);
      const alias = name === "cross_border_price_arbitrage" ? headers.legacySignature : headers.signature;
      const proof = { [alias]: encodeHeader(payment) };
      const results = await Promise.all([request(body, proof), request(body, proof)]);
      expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
      const paid = results.find((response) => response.status === 200)!;
      const receipt = settlementSchema.parse(decodeHeader(paid.headers.get(headers.response)!));
      expect(await paid.json()).toMatchObject({ result: { structuredContent: expect.any(Object) } });
      expect(decodeHeader(paid.headers.get(headers.legacyResponse)!)).toMatchObject({ txHash: receipt.transaction, sandbox: true });
      const cap = Number(challenge.accepts[0].amount);
      if (challenge.accepts[0].scheme === "upto") expect(Number(receipt.amount)).toBeLessThan(cap);
      else expect(Number(receipt.amount)).toBe(cap);
    });
  }

  it("rejects a proof with tampered terms or a conflicting alias", async () => {
    const request = setup();
    const name = "cross_border_price_arbitrage";
    const body = rpcCall("tools/call", { name, arguments: toolExamples[name] });
    const challenge = paymentRequired.parse(await (await request(body)).json());
    const payment = await signSandboxPayment(challenge);
    const tampered = { ...payment, accepted: { ...payment.accepted, amount: "1000" } };
    expect((await request(body, { [headers.signature]: encodeHeader(tampered) })).status).toBe(402);
    expect((await request(body, { [headers.signature]: encodeHeader(payment), [headers.legacySignature]: "different" })).status).toBe(402);
    expect((await request(body, { [headers.signature]: encodeHeader(payment) })).status).toBe(200);
  });
});
