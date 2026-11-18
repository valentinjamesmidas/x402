# x402 Operator Command Center

Cloudflare Worker s Hono a stateless MCP, platební brána x402 v2, databáze Supabase a React PWA na Cloudflare Workers Static Assets. PWA je v angličtině. Vývoj a kontrola probíhají v cloudovém workspace a GitHub Actions.

## Sandbox a protokol

Výchozí konfigurace Workeru je sandbox. Prohlížeč bez konfigurace Supabase zobrazí demo telemetrii, dovolí zkoušet správu katalogu a registru a nabídne simulaci i bez Workeru. Pokud je Worker dostupný, inspektor volá skutečný endpoint `/sandbox/mcp`. Oba sandboxy vytvářejí a ověřují EIP-712 podpisy veřejnou demonstrační peněženkou, vypořádání vrací syntetický hash a nepoužívá blockchain. Reálné platby lze v produkční PWA vyzkoušet připojenou EIP-1193 peněženkou s příslušným USDC, u Permit2 i se schváleným allowance.

- `POST /mcp` podporuje MCP 2026-07-28 a kompatibilní inicializaci 2025-11-25. Pro verzi 2026 nastavte `MCP-Protocol-Version`, `Mcp-Method`, u `tools/call` i `Mcp-Name`. V `params._meta` pošlete `io.modelcontextprotocol/protocolVersion` a `io.modelcontextprotocol/clientCapabilities`.
- `server/discover` a `tools/list` jsou bez platby. `tools/call` používá x402 v2 HTTP transport. Výzva je `402` s `PAYMENT-REQUIRED`, klient opakuje požadavek s `PAYMENT-SIGNATURE` nebo aliasem `X-PAYMENT`. Úspěch vrací `PAYMENT-RESPONSE` a `X-PAYMENT-RESPONSE`. Alias hlavičky používá formát v2.
- `exact` podporuje EIP-3009 podpisy EOA. `upto` používá Permit2, adresu facilitátora z `/supported` a účtuje desetinu stropu plus dvě miliontiny USDC za bajt vstupu, nejvýš však schválený strop. Worker ověří podpis lokálně a v živém režimu volá `/verify` a `/settle`.
- Katalog se ukládá do KV na 60 sekund. Replay klíče v KV urychlují odmítnutí opakovaných požadavků, jejich atomické získání hlídají Durable Objects. Agenti s ověřeným KYA a alespoň deseti zaplacenými voláními dostanou desetiprocentní slevu až k minimální ceně. Audit nejistého výsledku facilitátora je veden jako nepotvrzené zúčtování, opakování použité autorizace je zablokováno.
- Veřejné manifesty jsou na `/agent-manifest.txt` a `/.well-known/x402.json`. V prohlížečích s WebMCP (`document.modelContext` nebo `navigator.modelContext`) se registrují nástroje `get_x402_catalog` a `calculate_batch_quote`.

## Data nástrojů

| Nástroj | Zdroj a rozsah |
| --- | --- |
| Cross-border Price Arbitrage | Nabídky ve vstupu nebo `MARKET_QUOTES_URL`. Provider dostane `item` a `quantity` a vrací `{ "offers": [...] }` podle schématu nástroje. Výpočet zahrnuje logistiku, poplatky, čistou marži a rizikovou korekci. |
| Contract & Tender Risk Audit | Deterministická pravidla pro anglické a české smluvní formulace. Stažené normy vyhodnocuje ze vstupního seznamu `standards` s daty a zdroji. Výsledky obsahují konkrétní úryvky. |
| Verified Entity KYB Oracle | České IČO a evidované DIČ ověřuje přes [ARES](https://ares.gov.cz/). Pro insolvenci, reputaci a platební morálku lze připojit `KYB_RISK_URL`. Provider dostane `country` a `companyId` a vrací `insolvency`, `reputationScore`, `paymentMorale` a `sources` podle výstupního schématu. Chybějící údaje se zobrazí jako nedostupné. |

## Produkční prostředí GitHub Actions

Workflow ověřuje pull requesty i větev `main`. Nasazení z `main` probíhá po nastavení repozitářové proměnné `X402_DEPLOY_ENABLED=true`. Událost `workflow_dispatch` umožňuje nasazení zopakovat. Supabase migrace se aplikuje před společným nasazením Workeru a PWA. Ruční cíl `sandbox` na větvi `main` nasadí Worker `x402-gateway-sandbox` s PWA. Používá `CLOUDFLARE_ACCOUNT_ID` a `CLOUDFLARE_API_TOKEN` prostředí `sandbox` a běží i bez Supabase.

| Typ | Nastavení |
| --- | --- |
| Repository variables | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_KV_NAMESPACE_ID` pro binding `X402_NONCE_STORE`, `SUPABASE_PROJECT_REF`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `OPERATOR_WALLET_ADDRESS`, `FACILITATOR_URL` pro Base mainnet |
| Secrets prostředí `production` | `CLOUDFLARE_API_TOKEN` s oprávněními pro nasazení Workeru a Static Assets, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_SERVICE_ROLE_KEY` |
| Volitelné proměnné | `X402_NETWORK` (výchozí `eip155:8453`), `ENABLE_PROTOCOL_SANDBOX`, `ALLOWED_ORIGINS`, `MARKET_QUOTES_URL`, `KYB_RISK_URL`, `X402_PUBLIC_URL` pro kontrolu po nasazení |
| Volitelná tajemství | `CDP_API_KEY_ID` a `CDP_API_KEY_SECRET` pro autorizaci Coinbase CDP nebo `FACILITATOR_TOKEN` pro konfigurovaného providera; `DATA_PROVIDER_TOKEN` pro externí data |

Pro Base mainnet použijte facilitátora, jehož `/supported` podporuje `exact` i `upto` na `eip155:8453`. Veřejný `https://x402.org/facilitator` je výchozí pro sandboxovou konfiguraci a vývoj na testnetu. Název Workeru je `x402-gateway`.

Operátora založte v Supabase Auth, přidělte mu pomocí Admin API `app_metadata.x402_role = "operator"` a přidejte origin Workeru mezi povolené Auth redirect URL. PWA používá přihlašovací odkaz. RLS zpřístupňuje operátorská data a Realtime jen odpovídajícímu účtu. Změny cen, schémat a limitů zapisuje autorizovaná Worker API. Servisní klíč zůstává v prostředí Workeru.

RFC 9421 identita se zakládá v `agent_identities` s veřejným Ed25519 klíčem jako Base64 raw 32 bajtů a volitelným `signature_key_id`. Hlavička `Signature-Input` používá tento identifikátor nebo UUID registru, časy `created` a `expires` a unikátní `nonce`. Podepište `@method`, `@target-uri` (alternativně autoritu, cestu a případný query) a `content-digest` ve formátu RFC 9530 `sha-256=:…:`.

## Kontrola v cloudovém workspace

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run dev:edge
```

`npm run dev:edge` obslouží PWA a skutečný simulovaný Worker. `npm run dev` spustí samostatnou PWA s prohlížečovým fallbackem.
