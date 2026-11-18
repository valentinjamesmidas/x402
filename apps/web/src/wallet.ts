import { createWalletClient, custom } from "viem";
import type { EIP1193Provider } from "viem";
import { base, baseSepolia } from "viem/chains";
import { signWalletPayment } from "@platform/shared/payment-evm";
import type { Challenge } from "@platform/shared/x402";

export async function signWithConnectedWallet(challenge: Challenge) {
  const provider = (window as Window & { ethereum?: EIP1193Provider }).ethereum;
  if (!provider) throw new Error("An EIP-1193 wallet is required for live payments.");
  const chain = challenge.accepts[0].network === "eip155:8453" ? base : baseSepolia;
  const wallet = createWalletClient({ chain, transport: custom(provider) });
  const [account] = await wallet.requestAddresses();
  if (!account || await wallet.getChainId() !== chain.id) throw new Error(`Switch your wallet to ${chain.name} and try again.`);
  return signWalletPayment(challenge, { address: account, signTypedData: (params) => wallet.signTypedData({ ...params, account }) });
}
