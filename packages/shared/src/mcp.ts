import { z } from "zod";

export const MCP_VERSION = "2026-07-28";
export const MCP_LEGACY_VERSION = "2025-11-25";
export const serverInfo = { name: "x402-gateway", version: "1.0.0" };
export const toolNames = ["cross_border_price_arbitrage", "contract_and_tender_risk_audit", "verified_entity_kyb_oracle"] as const;
export const toolName = z.enum(toolNames);
export type ToolName = z.infer<typeof toolName>;

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export const jsonObject = z.record(z.string(), z.json());
export const rpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number().int()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type RpcRequest = z.infer<typeof rpcRequest>;
export const callParams = z.object({ name: toolName, arguments: z.unknown().optional() });
export const pricingScheme = z.enum(["exact", "upto"]);

export function rpcCall(method: string, params: Record<string, unknown> = {}): RpcRequest {
  return {
    jsonrpc: "2.0", id: crypto.randomUUID(), method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_VERSION,
        "io.modelcontextprotocol/clientInfo": { name: "x402-command-center", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
}
