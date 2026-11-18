import type { RequestGate } from "./gate";

export interface Env {
  GATES: DurableObjectNamespace<RequestGate>;
  X402_NONCE_STORE?: KVNamespace;
  SANDBOX_MODE?: string;
  X402_NETWORK?: string;
  OPERATOR_WALLET_ADDRESS?: string;
  FACILITATOR_URL?: string;
  FACILITATOR_TOKEN?: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  ENABLE_PROTOCOL_SANDBOX?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  ALLOWED_ORIGINS?: string;
  MARKET_QUOTES_URL?: string;
  KYB_RISK_URL?: string;
  DATA_PROVIDER_TOKEN?: string;
}

export type Lifetime = { waitUntil(promise: Promise<unknown>): void };
