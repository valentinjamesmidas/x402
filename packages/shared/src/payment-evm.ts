import { PERMIT2_ADDRESS, authorizationTypes, uptoPermit2WitnessTypes, x402UptoPermit2ProxyAddress } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  eipAuthorization, hexSignature, networks, permitAuthorization, sandboxPayTo,
} from "./x402";
import type { Challenge, Payment, Requirements } from "./x402";

// A public fixture key. It is only used with the sandbox payee on Base Sepolia.
const fixtureWallet = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000402");

export async function signSandboxPayment(challenge: Challenge): Promise<Payment> {
  const accepted = challenge.accepts[0];
  if (accepted.network !== "eip155:84532" || accepted.payTo.toLowerCase() !== sandboxPayTo.toLowerCase()) {
    throw new Error("Fixture wallet requires a Base Sepolia sandbox challenge");
  }
  if (accepted.scheme === "upto") {
    // The SDK's client checks chain allowance. The simulator has no chain balance.
    const facilitator = accepted.extra.facilitatorAddress;
    if (!facilitator) throw new Error("Permit2 requires a facilitator address");
    const now = Math.floor(Date.now() / 1000);
    const nonce = BigInt(`0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`).toString();
    const auth = {
      from: fixtureWallet.address, permitted: { token: accepted.asset, amount: accepted.amount },
      spender: x402UptoPermit2ProxyAddress, nonce, deadline: String(now + accepted.maxTimeoutSeconds),
      witness: { to: accepted.payTo, facilitator, validAfter: String(now - 1) },
    };
    const signature = await fixtureWallet.signTypedData(permitTypedData(auth, accepted));
    return { x402Version: 2, resource: challenge.resource, accepted, payload: { signature, permit2Authorization: auth } };
  }
  const { payload } = await new ExactEvmScheme(fixtureWallet).createPaymentPayload(2, accepted);
  return { x402Version: 2, resource: challenge.resource, accepted, payload };
}

export async function signWalletPayment(challenge: Challenge, signer: ConstructorParameters<typeof ExactEvmScheme>[0]): Promise<Payment> {
  const accepted = challenge.accepts[0];
  const scheme = accepted.scheme === "upto" ? new UptoEvmScheme(signer) : new ExactEvmScheme(signer);
  const { payload } = await scheme.createPaymentPayload(2, accepted);
  return { x402Version: 2, resource: challenge.resource, accepted, payload };
}

const same = (first: string, second: string) => first.toLowerCase() === second.toLowerCase();

function permitTypedData(auth: ReturnType<typeof permitAuthorization.parse>, requirements: Requirements) {
  return {
    domain: { name: "Permit2", chainId: networks[requirements.network].chainId, verifyingContract: PERMIT2_ADDRESS },
    types: uptoPermit2WitnessTypes, primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: { token: auth.permitted.token, amount: BigInt(auth.permitted.amount) },
      spender: auth.spender, nonce: BigInt(auth.nonce), deadline: BigInt(auth.deadline),
      witness: { ...auth.witness, validAfter: BigInt(auth.witness.validAfter) },
    },
  } as const;
}

export async function verifyEvmPayment(payment: Payment, required: Requirements) {
  const offered = payment.accepted;
  if (offered.scheme !== required.scheme || offered.network !== required.network ||
      !same(offered.asset, required.asset) || !same(offered.payTo, required.payTo) ||
      offered.amount !== required.amount || offered.maxTimeoutSeconds !== required.maxTimeoutSeconds ||
      offered.extra.assetTransferMethod !== required.extra.assetTransferMethod ||
      offered.extra.name !== required.extra.name || offered.extra.version !== required.extra.version ||
      (offered.extra.facilitatorAddress ?? "").toLowerCase() !== (required.extra.facilitatorAddress ?? "").toLowerCase()) {
    throw new Error("Payment does not match current terms");
  }

  const signature = hexSignature.parse(payment.payload.signature);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const limit = now + BigInt(required.maxTimeoutSeconds + 15);
  if (required.scheme === "upto") {
    const auth = permitAuthorization.parse(payment.payload.permit2Authorization);
    if (!same(auth.permitted.token, required.asset) || !same(auth.witness.to, required.payTo) ||
        !same(auth.witness.facilitator, required.extra.facilitatorAddress ?? "") ||
        !same(auth.spender, x402UptoPermit2ProxyAddress) || auth.permitted.amount !== required.amount ||
        BigInt(auth.deadline) <= now || BigInt(auth.deadline) > limit || BigInt(auth.witness.validAfter) > now) {
      throw new Error("Invalid Permit2 authorization");
    }
    const recovered = await recoverTypedDataAddress({ ...permitTypedData(auth, required), signature });
    if (!same(recovered, auth.from)) throw new Error("Permit2 signature does not match payer");
    return { payer: auth.from.toLowerCase() as `0x${string}`, nonce: auth.nonce, expiresAt: Number(auth.deadline) * 1000 };
  }
  const auth = eipAuthorization.parse(payment.payload.authorization);
  if (!same(auth.to, required.payTo) || auth.value !== required.amount || BigInt(auth.validAfter) >= now ||
      BigInt(auth.validBefore) <= now || BigInt(auth.validBefore) > limit) {
    throw new Error("Invalid EIP-3009 authorization");
  }
  const recovered = await recoverTypedDataAddress({
    domain: { name: required.extra.name, version: required.extra.version, chainId: networks[required.network].chainId, verifyingContract: required.asset },
    types: authorizationTypes, primaryType: "TransferWithAuthorization",
    message: { ...auth, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore) }, signature,
  });
  if (!same(recovered, auth.from)) throw new Error("EIP-3009 signature does not match payer");
  return { payer: auth.from.toLowerCase() as `0x${string}`, nonce: auth.nonce.toLowerCase(), expiresAt: Number(auth.validBefore) * 1000 };
}
