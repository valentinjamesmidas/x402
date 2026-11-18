import { z } from "zod";
import { pricingScheme } from "./mcp";

export const address = z.string().regex(/^0x[0-9a-f]{40}$/i).transform((value) => value as `0x${string}`);
export const hexSignature = z.string().regex(/^0x[0-9a-f]{130}$/i).transform((value) => value as `0x${string}`);
export const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine((value) => BigInt(value) < 2n ** 256n);
export const chain = z.enum(["eip155:8453", "eip155:84532"]);
export type Network = z.infer<typeof chain>;
export const networks = {
  "eip155:8453": { name: "base-mainnet", chainId: 8453, domainName: "USD Coin", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", explorer: "https://basescan.org/tx/" },
  "eip155:84532": { name: "base-sepolia", chainId: 84532, domainName: "USDC", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", explorer: "https://sepolia.basescan.org/tx/" },
} as const;
export const headers = {
  required: "PAYMENT-REQUIRED", signature: "PAYMENT-SIGNATURE", response: "PAYMENT-RESPONSE",
  legacySignature: "X-PAYMENT", legacyResponse: "X-PAYMENT-RESPONSE",
} as const;

const resourceSchema = z.object({ url: z.url(), description: z.string(), mimeType: z.string() });
export const requirementsSchema = z.object({
  scheme: pricingScheme, network: chain, asset: address, payTo: address, amount: uint,
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.object({
    name: z.string().optional(), version: z.string().optional(),
    assetTransferMethod: z.enum(["permit2", "eip3009"]).optional(), facilitatorAddress: address.optional(),
  }).passthrough(),
});
export const paymentRequired = z.object({
  x402Version: z.literal(2), error: z.string().optional(), resource: resourceSchema,
  accepts: z.array(requirementsSchema).nonempty(),
});
export const paymentPayload = z.object({
  x402Version: z.literal(2), resource: resourceSchema.optional(), accepted: requirementsSchema,
  payload: z.record(z.string(), z.unknown()), extensions: z.record(z.string(), z.unknown()).optional(),
});
export const eipAuthorization = z.object({
  from: address, to: address, value: uint, validAfter: uint, validBefore: uint,
  nonce: z.string().regex(/^0x[0-9a-f]{64}$/i).transform((value) => value as `0x${string}`),
});
export const permitAuthorization = z.object({
  from: address, permitted: z.object({ token: address, amount: uint }), spender: address,
  nonce: uint, deadline: uint, witness: z.object({ to: address, facilitator: address, validAfter: uint }),
});
export const settlementSchema = z.object({
  success: z.literal(true), transaction: z.string().regex(/^0x[0-9a-f]{64}$/i), network: chain,
  payer: address.optional(), amount: uint.optional(),
});
export type Requirements = z.infer<typeof requirementsSchema>;
export type Challenge = z.infer<typeof paymentRequired>;
export type Payment = z.infer<typeof paymentPayload>;
export type Settlement = z.infer<typeof settlementSchema>;
export const sandboxPayTo = "0x000000000000000000000000000000000000dEaD" as const;
export const sandboxFacilitator = "0x000000000000000000000000000000000000f402" as const;

export const usdcToUnits = (price: number) => BigInt(Math.round(price * 1_000_000)).toString();
export const unitsToUsdc = (units: string) => Number(BigInt(units)) / 1_000_000;

export function toBase64(bytes: Uint8Array) {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}
export function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
export function encodeHeader(value: unknown) {
  return toBase64(new TextEncoder().encode(JSON.stringify(value)));
}
export function decodeHeader(value: string): unknown {
  if (value.length > 32_768) throw new Error("Oversized payment header");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(fromBase64(value)));
}
export function makeRequirements(price: number, scheme: Requirements["scheme"], network: Network, payTo: Requirements["payTo"], facilitatorAddress?: Requirements["payTo"]): Requirements {
  return {
    scheme, network, amount: usdcToUnits(price), asset: networks[network].asset, payTo,
    maxTimeoutSeconds: 120,
    extra: scheme === "upto"
      ? { assetTransferMethod: "permit2", facilitatorAddress }
      : { name: networks[network].domainName, version: "2", assetTransferMethod: "eip3009" },
  };
}
