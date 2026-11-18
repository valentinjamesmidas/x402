# x402 monorepo

- Keep wire schemas, tool contracts and database types in `packages/shared`. The Hono Worker lives in `workers/x402-gateway` and React PWA in `apps/web`.
- Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build` in the cloud workspace or GitHub Actions. Deploy Worker and Static Assets together with the GitHub workflow.
- Keep x402 v2 amounts as decimal strings in USDC base units and use CAIP-2 chain identifiers on the wire. External facilitator results, tool input, and database writes must be validated.
- Separate fixture and live payment modes. Never log credentials, raw signatures, original contracts, or facilitator authorization headers.
- Use forward-only Supabase migrations and preserve operator-only policies. KV is a cache; atomic payment and signed-request replay claims use strongly consistent storage.
