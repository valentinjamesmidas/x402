create table public.x402_endpoints (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  tool_name text not null unique,
  description text not null check (length(description) between 1 and 500),
  price_usdc numeric(12,6) not null check (price_usdc between 0.001 and 10),
  pricing_scheme text not null check (pricing_scheme in ('exact', 'upto')),
  is_active boolean not null default true,
  input_schema jsonb not null check (jsonb_typeof(input_schema) = 'object'),
  axo_metadata jsonb not null default '{}' check (jsonb_typeof(axo_metadata) = 'object'),
  updated_at timestamptz not null default now()
);

create table public.agent_identities (
  id uuid primary key default gen_random_uuid(),
  agent_name text not null,
  user_agent text,
  ed25519_pubkey text unique,
  signature_key_id text unique,
  wallet_address text check (wallet_address ~ '^0x[0-9a-f]{40}$'),
  kya_verified boolean not null default false check (not kya_verified or ed25519_pubkey is not null),
  total_spent_usdc numeric(20,6) not null default 0 check (total_spent_usdc >= 0),
  total_calls integer not null default 0 check (total_calls >= 0),
  rate_limit_rpm integer not null default 60 check (rate_limit_rpm between 1 and 10000),
  is_blocked boolean not null default false,
  last_seen_at timestamptz
);
create unique index agent_wallet_idx on public.agent_identities(lower(wallet_address)) where wallet_address is not null;
create index agent_last_seen_idx on public.agent_identities(last_seen_at desc nulls last);

create table public.x402_transactions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  endpoint_id uuid references public.x402_endpoints(id) on delete set null,
  tool_name text,
  agent_id text,
  wallet_address text check (wallet_address ~ '^0x[0-9a-f]{40}$'),
  network text not null check (network in ('eip155:8453', 'eip155:84532')),
  amount_usdc numeric(12,6) not null default 0 check (amount_usdc >= 0),
  tx_hash text check (tx_hash ~* '^0x[0-9a-f]{64}$'),
  status text not null check (status in ('challenge_402', 'settled_200', 'failed_signature', 'rate_limited', 'discovery_200', 'failed_execution')),
  latency_ms integer not null default 0 check (latency_ms >= 0),
  request_meta jsonb not null default '{}' check (jsonb_typeof(request_meta) = 'object'),
  check (status <> 'settled_200' or (tx_hash is not null and amount_usdc > 0))
);
create index x402_transactions_time_idx on public.x402_transactions(created_at desc, id desc);
create index x402_transactions_endpoint_idx on public.x402_transactions(endpoint_id, created_at desc);
create unique index x402_transactions_hash_idx on public.x402_transactions(network, lower(tx_hash)) where tx_hash is not null;

create function public.stamp_x402_endpoint() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger x402_endpoint_stamp before update on public.x402_endpoints
for each row execute function public.stamp_x402_endpoint();

alter table public.x402_endpoints enable row level security;
alter table public.x402_transactions enable row level security;
alter table public.agent_identities enable row level security;
revoke all on public.x402_endpoints, public.x402_transactions, public.agent_identities from anon, authenticated;
grant select on public.x402_endpoints, public.x402_transactions, public.agent_identities to authenticated;
grant all on public.x402_endpoints, public.x402_transactions, public.agent_identities to service_role;

create policy operator_read on public.x402_endpoints for select to authenticated using ((select auth.jwt() -> 'app_metadata' ->> 'x402_role') = 'operator');
create policy operator_read on public.x402_transactions for select to authenticated using ((select auth.jwt() -> 'app_metadata' ->> 'x402_role') = 'operator');
create policy operator_read on public.agent_identities for select to authenticated using ((select auth.jwt() -> 'app_metadata' ->> 'x402_role') = 'operator');

create function public.record_x402_event(event jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  inserted_cost numeric;
begin
  insert into public.x402_transactions
    (endpoint_id, tool_name, agent_id, wallet_address, network, amount_usdc, tx_hash, status, latency_ms, request_meta)
  values (
    (event->>'endpoint_id')::uuid, event->>'tool_name', event->>'agent_id', event->>'wallet_address',
    event->>'network', (event->>'amount_usdc')::numeric, event->>'tx_hash', event->>'status',
    (event->>'latency_ms')::integer, event->'request_meta'
  ) on conflict do nothing returning amount_usdc into inserted_cost;

  if inserted_cost is not null and event->>'status' = 'settled_200'
    and (event->'request_meta'->>'sandbox') = 'false'
    and (event->'request_meta'->>'identity_verified') = 'true' then
    update public.agent_identities
      set total_spent_usdc = total_spent_usdc + inserted_cost,
          total_calls = total_calls + 1, last_seen_at = now()
      where id = (event->>'agent_id')::uuid;
  end if;
end $$;
revoke all on function public.record_x402_event(jsonb) from public, anon, authenticated;
grant execute on function public.record_x402_event(jsonb) to service_role;

alter publication supabase_realtime add table public.x402_endpoints, public.x402_transactions, public.agent_identities;

-- The tool seeds below use the shared, versioned protocol schemas.
insert into public.x402_endpoints (id, slug, tool_name, description, price_usdc, pricing_scheme, input_schema, axo_metadata) values
  ('00000000-0000-4000-8000-000000000001', 'cross-border-price-arbitrage', 'cross_border_price_arbitrage', 'Rank European offers by net margin, landed costs and risk.', 0.05, 'exact',
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"item":{"type":"string","minLength":1,"maxLength":120},"quantity":{"type":"integer","minimum":1,"maximum":10000},"offers":{"minItems":1,"maxItems":30,"type":"array","items":{"type":"object","properties":{"country":{"type":"string","enum":["AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE","CH","NO","GB"]},"buyUnitEur":{"type":"number","minimum":0,"maximum":1000000000},"sellUnitEur":{"type":"number","minimum":0,"maximum":1000000000},"shippingEur":{"type":"number","minimum":0,"maximum":1000000000},"feesEur":{"type":"number","minimum":0,"maximum":1000000000},"riskPercent":{"type":"number","minimum":0,"maximum":100}},"required":["country","buyUnitEur","sellUnitEur","shippingEur","feesEur","riskPercent"],"additionalProperties":false}}},"required":["item","quantity"],"additionalProperties":false}'::jsonb,
    '{"average_latency_ms":95,"data_guarantee":"Calculations are traceable to caller-provided or configured market quotes."}'::jsonb),
  ('00000000-0000-4000-8000-000000000002', 'contract-and-tender-risk-audit', 'contract_and_tender_risk_audit', 'Screen contract text for asymmetric terms and referenced withdrawn standards.', 0.12, 'upto',
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"text":{"type":"string","minLength":20,"maxLength":40000},"jurisdiction":{"type":"string","enum":["AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE","CH","NO","GB"]},"asOf":{"type":"string","format":"date"},"standards":{"maxItems":30,"type":"array","items":{"type":"object","properties":{"reference":{"type":"string","minLength":2,"maxLength":100},"withdrawnOn":{"type":"string","format":"date"},"source":{"type":"string","format":"uri"}},"required":["reference","withdrawnOn","source"],"additionalProperties":false}}},"required":["text","jurisdiction","asOf"],"additionalProperties":false}'::jsonb,
    '{"average_latency_ms":182,"data_guarantee":"Versioned rules return source excerpts and explicit evidence for every finding."}'::jsonb),
  ('00000000-0000-4000-8000-000000000003', 'verified-entity-kyb-oracle', 'verified_entity_kyb_oracle', 'Verify a Czech business against ARES and available risk-data sources.', 0.075, 'exact',
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"country":{"type":"string","const":"CZ"},"companyId":{"type":"string","pattern":"^\\d{8}$"},"vatId":{"type":"string","pattern":"^CZ\\d{8,10}$"}},"required":["country","companyId"],"additionalProperties":false}'::jsonb,
    '{"average_latency_ms":264,"data_guarantee":"Registry and risk results remain attributable, with unavailable fields marked explicitly."}'::jsonb);

-- Simulated records are explicitly marked and excluded from live revenue.
insert into public.x402_transactions
  (created_at, endpoint_id, tool_name, network, amount_usdc, tx_hash, status, latency_ms, request_meta)
values
  (now() - interval '8 minutes', null, null, 'eip155:84532', 0, null, 'discovery_200', 23,
    '{"seed":true,"sandbox":true,"agent_name":"OAI-SearchBot"}'),
  (now() - interval '6 minutes', '00000000-0000-4000-8000-000000000001', 'cross_border_price_arbitrage', 'eip155:84532', 0, null, 'challenge_402', 19,
    '{"seed":true,"sandbox":true,"agent_name":"Arbitrage-Agent","flow_id":"seed-price-arbitrage"}'),
  (now() - interval '4 minutes', '00000000-0000-4000-8000-000000000001', 'cross_border_price_arbitrage', 'eip155:84532', 0.05,
    '0x0000000000000000000000000000000000000000000000000000000000000402', 'settled_200', 187,
    '{"seed":true,"sandbox":true,"settlement_ms":133,"agent_name":"Arbitrage-Agent","flow_id":"seed-price-arbitrage"}'),
  (now() - interval '2 minutes', '00000000-0000-4000-8000-000000000002', 'contract_and_tender_risk_audit', 'eip155:84532', 0, null, 'failed_signature', 38,
    '{"seed":true,"sandbox":true,"agent_name":"Claude-MCP"}');
