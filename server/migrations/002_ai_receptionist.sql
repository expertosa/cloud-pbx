-- AI receptionist: per-tenant service tokens (hash only) and call handoff columns.
-- Destination jsonb may now also be {"type":"ai_receptionist","fallback":{...}}.
-- The feature stays inert until AI_RECEPTIONIST_ENABLED=true.

alter table calls add column if not exists handled_by_ai boolean not null default false;
alter table calls add column if not exists external_ref text;
alter table calls add column if not exists transferred_at timestamptz;

-- Replace the inline status check so 'ai' is a legal in-progress state
-- (the caller is on the line with the receptionist, not yet with a human).
do $$
declare cname text;
begin
  select con.conname into cname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  where rel.relname = 'calls' and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%status%';
  if cname is not null then
    execute format('alter table calls drop constraint %I', cname);
  end if;
end $$;

alter table calls add constraint calls_status_check
  check (status in ('ringing','answered','missed','voicemail','failed','rejected','abandoned','ai'));

create table if not exists tenant_integrations (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  name         text not null,
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index if not exists tenant_integrations_tenant_idx on tenant_integrations(tenant_id);
