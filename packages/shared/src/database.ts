import { z } from "zod";
import { jsonObject, pricingScheme, toolName, toolNames } from "./mcp";
import { schemaFor, toolContracts } from "./tool-contracts";

export const endpointSchema = z.object({
  id: z.uuid(), slug: z.string(), tool_name: toolName, description: z.string(),
  price_usdc: z.number().min(0.001).max(10), pricing_scheme: pricingScheme, is_active: z.boolean(),
  input_schema: jsonObject, axo_metadata: jsonObject, updated_at: z.string(),
});
export type Endpoint = z.infer<typeof endpointSchema>;
export const transactionStatuses = ["challenge_402", "settled_200", "failed_signature", "rate_limited", "discovery_200", "failed_execution"] as const;
export const transactionSchema = z.object({
  id: z.uuid(), created_at: z.string(), endpoint_id: z.uuid().nullable(), tool_name: toolName.nullable(),
  agent_id: z.string().nullable(), wallet_address: z.string().nullable(), network: z.string(),
  amount_usdc: z.number(), tx_hash: z.string().nullable(), status: z.enum(transactionStatuses),
  latency_ms: z.number().int().nonnegative(), request_meta: jsonObject,
});
export type Transaction = z.infer<typeof transactionSchema>;
export const agentSchema = z.object({
  id: z.uuid(), agent_name: z.string(), user_agent: z.string().nullable(),
  ed25519_pubkey: z.string().nullable(), signature_key_id: z.string().nullable(), wallet_address: z.string().nullable(), kya_verified: z.boolean(),
  total_spent_usdc: z.number(), total_calls: z.number().int(), rate_limit_rpm: z.number().int(),
  is_blocked: z.boolean(), last_seen_at: z.string().nullable(),
});
export type Agent = z.infer<typeof agentSchema>;
export const endpointPatch = endpointSchema.pick({
  price_usdc: true, pricing_scheme: true, is_active: true, input_schema: true, description: true, axo_metadata: true,
}).partial().strict();
export const agentPatch = agentSchema.pick({ rate_limit_rpm: true, is_blocked: true })
  .extend({ rate_limit_rpm: z.number().int().min(1).max(10_000) }).partial().strict();

type Table<Row extends Record<string, unknown>, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row; Insert: Insert; Update: Update; Relationships: [];
};
type TransactionInsert = Omit<Transaction, "id" | "created_at">;
export type Database = {
  public: {
    Tables: {
      x402_endpoints: Table<Endpoint>;
      x402_transactions: Table<Transaction, TransactionInsert>;
      agent_identities: Table<Agent>;
    };
    Views: Record<never, never>;
    Functions: {
      record_x402_event: { Args: { event: TransactionInsert }; Returns: undefined };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};

export const defaultEndpoints: Endpoint[] = toolNames.map((name, index) => {
  const tool = toolContracts[name];
  return {
    id: `00000000-0000-4000-8000-00000000000${index + 1}`,
    slug: name.replaceAll("_", "-"), tool_name: name, description: tool.description,
    price_usdc: tool.price, pricing_scheme: tool.scheme, is_active: true,
    input_schema: schemaFor(tool.input),
    axo_metadata: { average_latency_ms: tool.latency, data_guarantee: tool.guarantee },
    updated_at: "2026-01-01T00:00:00Z",
  };
});
