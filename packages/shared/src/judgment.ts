import type { z } from "zod";
import type { arbitrageInput, arbitrageOutput, contractInput, contractOutput, kybInput, kybOutput, offer } from "./tool-contracts";

type Offer = z.infer<typeof offer>;
type ArbitrageOutput = z.infer<typeof arbitrageOutput>;
type ContractOutput = z.infer<typeof contractOutput>;
type KybOutput = z.infer<typeof kybOutput>;
const round = (value: number) => Math.round(value * 100) / 100;

export function scoreArbitrage(input: z.infer<typeof arbitrageInput>, offers: Offer[], source: ArbitrageOutput["source"]): ArbitrageOutput {
  const markets = offers.map((market) => {
    const sales = market.sellUnitEur * input.quantity;
    const gross = sales - market.buyUnitEur * input.quantity;
    const landed = market.buyUnitEur * input.quantity + market.shippingEur + market.feesEur;
    const net = sales - landed;
    return {
      country: market.country, grossEur: round(gross), landedCostEur: round(landed), netEur: round(net),
      netMarginPercent: sales === 0 ? null : round(net / sales * 100),
      riskAdjustedNetEur: round(net - sales * market.riskPercent / 100),
    };
  }).sort((a, b) => b.riskAdjustedNetEur - a.riskAdjustedNetEur || a.country.localeCompare(b.country));
  return { item: input.item, currency: "EUR", quantity: input.quantity, source, markets: markets.map((market, index) => ({ ...market, rank: index + 1 })) };
}

const rules: { rule: string; severity: "medium" | "high"; pattern: RegExp; evidence: string }[] = [
  { rule: "one_sided_penalty", severity: "high", pattern: /(?:supplier|contractor|dodavatel|zhotovitel)[^.!?\n]{0,100}(?:penalt|liquidated damages|pokut)[^.!?\n]{0,45}/iu, evidence: "A monetary sanction is assigned to the supplier. Check proportionality and reciprocal obligations." },
  { rule: "termination_without_notice", severity: "high", pattern: /(?:terminat\w* without (?:prior )?notice|odstoupit bez (?:předchozího )?upozornění)/iu, evidence: "The wording permits immediate termination. Check cure periods and grounds." },
  { rule: "unilateral_variation", severity: "high", pattern: /(?:unilaterally (?:amend|change|modify)|jednostranně změnit)/iu, evidence: "One party can change terms. Check scope and changes to tendered obligations." },
  { rule: "unlimited_liability", severity: "high", pattern: /(?:unlimited liability|without limitation of liability|neomezená odpovědnost)/iu, evidence: "An express liability cap may be absent." },
  { rule: "extended_payment_term", severity: "medium", pattern: /(?:(?:payment|splatnost)[^.!?\n]{0,50}(?:[7-9][0-9]|[1-9][0-9]{2,})\s*(?:days|dnů))/iu, evidence: "The stated payment term exceeds 69 days. Check the applicable law and justification." },
  { rule: "deemed_acceptance", severity: "medium", pattern: /(?:deemed (?:to have been )?accepted|považuje se za schválen)/iu, evidence: "Acceptance can follow from inaction. Check the review period and notice process." },
];

export function auditContract(input: z.infer<typeof contractInput>): ContractOutput {
  const findings: ContractOutput["findings"] = [];
  for (const { rule, severity, pattern, evidence } of rules) {
    const match = input.text.match(pattern);
    if (match) findings.push({ rule, severity, excerpt: match[0], evidence });
  }
  for (const standard of input.standards ?? []) {
    const index = input.text.toLowerCase().indexOf(standard.reference.toLowerCase());
    if (index >= 0 && standard.withdrawnOn <= input.asOf) findings.push({
      rule: "withdrawn_standard", severity: "high",
      excerpt: input.text.slice(index, index + standard.reference.length),
      evidence: `Caller-supplied withdrawal date ${standard.withdrawnOn}. Source: ${standard.source}`,
    });
  }
  return {
    jurisdiction: input.jurisdiction, asOf: input.asOf,
    risk: findings.some((finding) => finding.severity === "high") ? "high" : findings.length ? "medium" : "none_detected",
    findings,
  };
}

export function sandboxKyb(input: z.infer<typeof kybInput>): KybOutput {
  const found = input.companyId === "00006947";
  return {
    country: "CZ", companyId: input.companyId, name: found ? "Demo Holdings s.r.o." : null,
    registryStatus: found ? "found" : "not_found", vatId: found ? "CZ00006947" : null,
    vatStatus: !input.vatId ? "not_requested" : !found ? "unavailable" : input.vatId === "CZ00006947" ? "registry_match" : "registry_mismatch",
    insolvency: found ? "no_record" : "unavailable", reputationScore: found ? 88 : null,
    paymentMorale: found ? "good" : "unavailable", sources: ["sandbox:fixture"], fixture: true,
  };
}
