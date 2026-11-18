import { parseDictionary, serializeInnerList, serializeItem } from "structured-headers";
import { fromBase64, toBase64 } from "@platform/shared/x402";
import type { Agent } from "@platform/shared/database";
import { lookupAgent } from "./repository";
import type { Db } from "./repository";
import type { Env } from "./env";
import { digest, hash } from "./sha";

const clockSkew = 30;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export async function verifyAgent(request: Request, body: ArrayBuffer, db: Db, env: Env): Promise<Agent | null> {
  const signatureHeader = request.headers.get("Signature");
  const inputHeader = request.headers.get("Signature-Input");
  if (!signatureHeader && !inputHeader) return null;
  if (!db || !signatureHeader || !inputHeader || signatureHeader.length > 8192 || inputHeader.length > 8192) {
    throw new Error("Agent signature unavailable");
  }
  const inputs = parseDictionary(inputHeader);
  const signatures = parseDictionary(signatureHeader);
  const url = new URL(request.url);
  for (const [label, input] of inputs) {
    if (!Array.isArray(input[0])) continue;
    const parameters = input[1];
    const keyid = parameters.get("keyid");
    const nonce = parameters.get("nonce");
    const created = parameters.get("created");
    const expires = parameters.get("expires");
    const alg = parameters.get("alg");
    const now = Math.floor(Date.now() / 1000);
    if (typeof keyid !== "string" || keyid.length > 200 || typeof nonce !== "string" || nonce.length < 10 || nonce.length > 128 ||
        (alg !== undefined && alg !== "ed25519") || typeof created !== "number" || !Number.isSafeInteger(created) ||
        typeof expires !== "number" || !Number.isSafeInteger(expires) ||
        created > now + clockSkew || expires <= now || expires <= created || expires - created > 300) continue;
    const signature = signatures.get(label)?.[0];
    if (!(signature instanceof ArrayBuffer) || signature.byteLength !== 64) continue;
    const values = new Map<string, string>([
      ["@method", request.method], ["@authority", url.host], ["@scheme", url.protocol.slice(0, -1)],
      ["@path", url.pathname], ["@query", url.search || "?"], ["@target-uri", url.href],
    ]);
    const components = input[0];
    const names = new Set(components.map(([name]) => name));
    if (!names.has("@method") || (!names.has("@target-uri") &&
      !(names.has("@authority") && names.has("@path") && (!url.search || names.has("@query")))) ||
      !names.has("content-digest") || names.size !== components.length) continue;
    const contentDigest = request.headers.get("content-digest");
    if (!contentDigest || contentDigest !== `sha-256=:${toBase64(await digest(body))}:`) continue;
    const lines: string[] = [];
    for (const component of components) {
      const [name, params] = component;
      if (typeof name !== "string" || params.size || name !== name.toLowerCase()) break;
      const value = name.startsWith("@") ? values.get(name) : request.headers.get(name)?.trim();
      if (value === undefined) break;
      lines.push(`${serializeItem(component)}: ${value}`);
    }
    if (lines.length !== components.length) continue;
    lines.push(`"@signature-params": ${serializeInnerList([components, parameters])}`);
    const agent = await lookupAgent(db, uuid.test(keyid) ? "id" : "signature_key_id", keyid);
    if (!agent?.ed25519_pubkey) continue;
    const bytes = fromBase64(agent.ed25519_pubkey);
    if (bytes.byteLength !== 32) continue;
    const key = await crypto.subtle.importKey("raw", bytes, { name: "Ed25519" }, false, ["verify"]);
    if (!(await crypto.subtle.verify("Ed25519", key, signature, new TextEncoder().encode(lines.join("\n"))))) continue;
    const gate = env.GATES.getByName(`signature:${await hash(`${agent.id}:${nonce}`)}`);
    if (!(await gate.claim((expires + clockSkew) * 1000))) throw new Error("Agent signature replayed");
    return agent;
  }
  throw new Error("Invalid agent signature");
}
