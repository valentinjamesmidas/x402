import { parseDictionary, serializeInnerList } from "structured-headers";
import { expect, it, vi } from "vitest";
import type { Agent } from "@platform/shared/database";
import { toBase64 } from "@platform/shared/x402";
import type { Env } from "./env";
import { verifyAgent } from "./identity";
import { database } from "./repository";

it("authenticates an RFC 9421 Ed25519 signature, binds the body and rejects replay", async () => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("publicKey" in pair)) throw new Error("Ed25519 did not generate a key pair");
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (!(raw instanceof ArrayBuffer)) throw new Error("Unexpected public key format");
  const pubkey = new Uint8Array(raw);
  const calls = new Set<string>();
  const env = {
    SUPABASE_URL: "https://project.example",
    SUPABASE_SERVICE_ROLE_KEY: "fixture",
    GATES: { getByName: (key: string) => ({
      claim: async () => {
        if (calls.has(key)) return false;
        calls.add(key);
        return true;
      },
    }) },
  } as unknown as Env;
  const keyid = "agent-test-key";
  const agent: Agent = {
    id: "10000000-0000-4000-8000-000000000001", agent_name: "fixture", user_agent: null,
    ed25519_pubkey: toBase64(pubkey), signature_key_id: keyid, wallet_address: null, kya_verified: true,
    total_spent_usdc: 1, total_calls: 11, rate_limit_rpm: 120, is_blocked: false, last_seen_at: null,
  };
  const fetchMock = vi.fn(async () => Response.json(agent));
  vi.stubGlobal("fetch", fetchMock);
  try {
    const db = database(env);
    const url = "https://gateway.example/mcp";
    const body = new Uint8Array(new TextEncoder().encode('{"example":1}')).buffer;
    const digest = toBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));
    const now = Math.floor(Date.now() / 1000);
    const signatureInput = `agent=("@method" "@target-uri" "content-digest");created=${now};expires=${now + 60};nonce="example-unique-nonce";keyid="${keyid}";alg="ed25519"`;
    const parsed = parseDictionary(signatureInput).get("agent");
    if (!parsed || !Array.isArray(parsed[0])) throw new Error("Test signature input is malformed");
    const contentDigest = `sha-256=:${digest}:`;
    const signed = new TextEncoder().encode(`"@method": POST\n"@target-uri": ${url}\n"content-digest": ${contentDigest}\n"@signature-params": ${serializeInnerList([parsed[0], parsed[1]])}`);
    const bytes = new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, signed));
    const request = new Request(url, { method: "POST", body, headers: {
      "Signature-Input": signatureInput, Signature: `agent=:${toBase64(bytes)}:`, "Content-Digest": contentDigest,
    } });
    await expect(verifyAgent(request, new Uint8Array(new TextEncoder().encode('{"example":2}')).buffer, db, env)).rejects.toThrow("Invalid");
    await expect(verifyAgent(request, body, db, env)).resolves.toEqual(agent);
    await expect(verifyAgent(request, body, db, env)).rejects.toThrow("replayed");
  } finally {
    vi.unstubAllGlobals();
  }
});
