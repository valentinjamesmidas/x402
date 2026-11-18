import { z } from "zod";
import type { JsonObject, ToolName } from "./mcp";

const money = z.number().finite().nonnegative().max(1_000_000_000);
const country = z.enum(["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "CH", "NO", "GB"]);
export const offer = z.strictObject({
  country, buyUnitEur: money, sellUnitEur: money, shippingEur: money, feesEur: money,
  riskPercent: z.number().min(0).max(100),
});
export const arbitrageInput = z.strictObject({
  item: z.string().trim().min(1).max(120),
  quantity: z.number().int().min(1).max(10_000),
  offers: z.array(offer).min(1).max(30).optional(),
});
export const arbitrageOutput = z.strictObject({
  item: z.string(), currency: z.literal("EUR"), quantity: z.number(),
  source: z.enum(["caller", "provider", "sandbox"]),
  markets: z.array(z.strictObject({
    country, grossEur: z.number(), landedCostEur: money.max(1e14), netEur: z.number(),
    netMarginPercent: z.number().nullable(), riskAdjustedNetEur: z.number(), rank: z.number().int(),
  })),
});
export const contractInput = z.strictObject({
  text: z.string().trim().min(20).max(40_000), jurisdiction: country,
  asOf: z.iso.date(),
  standards: z.array(z.strictObject({
    reference: z.string().trim().min(2).max(100),
    withdrawnOn: z.iso.date(),
    source: z.url(),
  })).max(30).optional(),
});
export const contractOutput = z.strictObject({
  jurisdiction: country, asOf: z.iso.date(),
  risk: z.enum(["none_detected", "medium", "high"]),
  findings: z.array(z.strictObject({
    rule: z.string(), severity: z.enum(["medium", "high"]), excerpt: z.string(), evidence: z.string(),
  })),
});
export const kybInput = z.strictObject({
  country: z.literal("CZ"), companyId: z.string().regex(/^\d{8}$/),
  vatId: z.string().regex(/^CZ\d{8,10}$/).optional(),
});
export const kybOutput = z.strictObject({
  country: z.literal("CZ"), companyId: z.string(), name: z.string().nullable(),
  registryStatus: z.enum(["found", "not_found"]),
  vatId: z.string().nullable(), vatStatus: z.enum(["registry_match", "registry_mismatch", "unavailable", "not_requested"]),
  insolvency: z.enum(["record_found", "no_record", "unavailable"]),
  reputationScore: z.number().min(0).max(100).nullable(),
  paymentMorale: z.enum(["good", "mixed", "poor", "unavailable"]),
  sources: z.array(z.string()), fixture: z.boolean(),
});

export const toolContracts = {
  cross_border_price_arbitrage: {
    title: "Cross-border Price Arbitrage", description: "Rank European offers by net margin, landed costs and risk.",
    input: arbitrageInput, output: arbitrageOutput, price: 0.05, scheme: "exact",
    latency: 95, guarantee: "Calculations are traceable to caller-provided or configured market quotes.",
  },
  contract_and_tender_risk_audit: {
    title: "Contract & Tender Risk Audit", description: "Screen contract text for asymmetric terms and referenced withdrawn standards.",
    input: contractInput, output: contractOutput, price: 0.12, scheme: "upto",
    latency: 182, guarantee: "Versioned rules return source excerpts and explicit evidence for every finding.",
  },
  verified_entity_kyb_oracle: {
    title: "Verified Entity KYB Oracle", description: "Verify a Czech business against ARES and available risk-data sources.",
    input: kybInput, output: kybOutput, price: 0.075, scheme: "exact",
    latency: 264, guarantee: "Registry and risk results remain attributable, with unavailable fields marked explicitly.",
  },
} as const satisfies Record<ToolName, { title: string; description: string; input: z.ZodType; output: z.ZodType; price: number; scheme: "exact" | "upto"; latency: number; guarantee: string }>;

export const schemaFor = (schema: z.ZodType): JsonObject => {
  // MCP accepts a top-level object schema. The default dialect is 2020-12.
  return z.toJSONSchema(schema, {
    io: "input",
    override: ({ jsonSchema }) => {
      if ("format" in jsonSchema && jsonSchema.format === "date") delete jsonSchema.pattern;
    },
  }) as JsonObject;
};

export const toolExamples = {
  cross_border_price_arbitrage: { item: "Brake pads", quantity: 40, offers: [
    { country: "DE" as const, buyUnitEur: 18, sellUnitEur: 27, shippingEur: 22, feesEur: 18, riskPercent: 6 },
    { country: "PL" as const, buyUnitEur: 16, sellUnitEur: 25, shippingEur: 32, feesEur: 18, riskPercent: 9 },
  ] },
  contract_and_tender_risk_audit: {
    text: "The supplier shall pay a penalty solely for any delay. The buyer may terminate without notice.",
    jurisdiction: "CZ", asOf: "2026-11-18",
  },
  verified_entity_kyb_oracle: { country: "CZ", companyId: "00006947", vatId: "CZ00006947" },
} satisfies Record<ToolName, JsonObject>;
