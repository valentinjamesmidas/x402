const textEncoder = new TextEncoder();

export async function digest(value: string | ArrayBuffer) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", typeof value === "string" ? textEncoder.encode(value) : value));
}

export async function hash(value: string) {
  return Array.from(await digest(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
