import { z } from "zod";
import { Validator } from "@cfworker/json-schema";
import type { Schema } from "@cfworker/json-schema";
import type { Endpoint } from "@platform/shared/database";
import type { JsonObject, ToolName } from "@platform/shared/mcp";
import { auditContract, sandboxKyb, scoreArbitrage } from "@platform/shared/judgment";
import { arbitrageInput, arbitrageOutput, contractInput, contractOutput, kybInput, kybOutput, offer, toolContracts, toolExamples } from "@platform/shared/tool-contracts";
import type { Env } from "./env";

const ares = "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/";
const aresResponse = z.object({ ico: z.string(), obchodniJmeno: z.string(), dic: z.string().optional() });
const riskResponse = kybOutput.pick({ insolvency: true, reputationScore: true, paymentMorale: true, sources: true })
  .refine((entry) => entry.sources.length > 0);
const marketResponse = z.object({ offers: z.array(offer).min(1).max(30) });

async function dataRequest(url: URL | string, token?: string) {
  return fetch(url, { redirect: "error", signal: AbortSignal.timeout(5500), headers: {
    Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}),
  } });
}

export function validOperatorSchema(schema: JsonObject) {
  const allowed = new Set(["$schema", "type", "properties", "required", "additionalProperties", "items", "description", "title", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "enum", "const", "format", "anyOf", "oneOf", "allOf", "$comment"]);
  const validateNode = (node: unknown, depth: number): boolean => {
    if (node === true || node === false) return true;
    if (!node || typeof node !== "object" || Array.isArray(node) || depth > 12) return false;
    return Object.entries(node).every(([key, value]) => {
      if (!allowed.has(key)) return false;
      if (key === "properties") return !!value && typeof value === "object" && !Array.isArray(value) &&
        Object.entries(value).every(([name, child]) => !["__proto__", "constructor", "prototype"].includes(name) && validateNode(child, depth + 1));
      if (["items", "additionalProperties"].includes(key)) return validateNode(value, depth + 1);
      if (["anyOf", "oneOf", "allOf"].includes(key)) return Array.isArray(value) && value.length > 0 && value.length <= 20 && value.every((part) => validateNode(part, depth + 1));
      if (key === "pattern") {
        // Keep patterns within the safe, linear patterns used by tool contracts.
        return typeof value === "string" && /^\^([A-Z]{1,3})?\\d\{\d{1,2}(,\d{1,2})?\}\$$/.test(value);
      }
      if (key === "$schema") return value === "https://json-schema.org/draft/2020-12/schema";
      if (key === "type") return typeof value === "string" && ["object", "array", "string", "boolean", "number", "integer", "null"].includes(value);
      if (["minimum", "maximum"].includes(key)) return typeof value === "number";
      if (["minLength", "maxLength", "minItems", "maxItems"].includes(key)) return typeof value === "number" && value >= 0 && Number.isInteger(value);
      if (["description", "title", "format", "$comment"].includes(key)) return typeof value === "string";
      if (key === "required") return Array.isArray(value) && value.every((part) => typeof part === "string");
      if (key === "enum") return Array.isArray(value) && value.length > 0;
      return true;
    });
  };
  return schema.type === "object" && JSON.stringify(schema).length <= 16_384 && validateNode(schema, 0);
}

export function validateArguments(endpoint: Endpoint, args: unknown) {
  if (!toolContracts[endpoint.tool_name].input.safeParse(args).success) return false;
  try {
    if (!validOperatorSchema(endpoint.input_schema)) return false;
    return new Validator(endpoint.input_schema as Schema, "2020-12", true).validate(args).valid;
  } catch {
    return false;
  }
}

export async function runTool(name: ToolName, args: unknown, env: Env, sandbox: boolean) {
  switch (name) {
    case "cross_border_price_arbitrage": {
      const input = arbitrageInput.parse(args);
      if (input.offers) return arbitrageOutput.parse(scoreArbitrage(input, input.offers, "caller"));
      if (sandbox) return arbitrageOutput.parse(scoreArbitrage(input, toolExamples.cross_border_price_arbitrage.offers, "sandbox"));
      if (!env.MARKET_QUOTES_URL) throw new Error("Provide market offers or configure a data provider");
      const url = new URL(env.MARKET_QUOTES_URL);
      url.searchParams.set("item", input.item);
      url.searchParams.set("quantity", String(input.quantity));
      const response = await dataRequest(url, env.DATA_PROVIDER_TOKEN);
      if (!response.ok) throw new Error("Market provider unavailable");
      return arbitrageOutput.parse(scoreArbitrage(input, marketResponse.parse(await response.json()).offers, "provider"));
    }
    case "contract_and_tender_risk_audit":
      return contractOutput.parse(auditContract(contractInput.parse(args)));
    case "verified_entity_kyb_oracle": {
      const input = kybInput.parse(args);
      if (sandbox) return kybOutput.parse(sandboxKyb(input));
      const source = `${ares}${input.companyId}`;
      const response = await dataRequest(source);
      if (response.status !== 404 && !response.ok) throw new Error("ARES unavailable");
      const entity = response.ok ? aresResponse.parse(await response.json()) : null;
      if (entity && entity.ico !== input.companyId) throw new Error("Unexpected company ID from ARES");
      const risk = entity && env.KYB_RISK_URL ? await lookupRisk(env.KYB_RISK_URL, input.companyId, env.DATA_PROVIDER_TOKEN) : null;
      return kybOutput.parse({
        country: "CZ", companyId: input.companyId, name: entity?.obchodniJmeno ?? null,
        registryStatus: entity ? "found" : "not_found", vatId: entity?.dic ?? null,
        vatStatus: !input.vatId ? "not_requested" : !entity?.dic ? "unavailable" : entity.dic === input.vatId ? "registry_match" : "registry_mismatch",
        insolvency: risk?.insolvency ?? "unavailable", reputationScore: risk?.reputationScore ?? null,
        paymentMorale: risk?.paymentMorale ?? "unavailable", sources: [source, ...(risk?.sources ?? [])], fixture: false,
      });
    }
  }
}

async function lookupRisk(provider: string, companyId: string, token?: string) {
  try {
    const url = new URL(provider);
    url.searchParams.set("country", "CZ");
    url.searchParams.set("companyId", companyId);
    const response = await dataRequest(url, token);
    return response.ok ? riskResponse.parse(await response.json()) : null;
  } catch {
    return null;
  }
}
