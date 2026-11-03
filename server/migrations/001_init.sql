-- Cloud PBX — initial schema
create extension if not exists pgcrypto;

create table tenants (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  slug                  text not null unique,           -- short id used in SIP usernames
  timezone              text not null default 'Asia/Riyadh',
  record_calls          boolean not null default false,
  allow_international   boolean not null default false,
  allowed_country_codes text[] not null default '{966}', -- E.164 prefixes allowed for outbound
  outbound_caller_id    text,                            -- E.164 of a number owned by the tenant
  daily_outbound_minutes integer not null default 600,   -- fraud / spend guard
  webhook_url           text,
  webhook_secret        text not null default encode(gen_random_bytes(24), 'hex'),
  disabled              boolean not null default false,
  created_at            timestamptz not null default now()
);

create table users (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references tenants(id) on delete cascade,
  name          text not null,
  email         text not null unique,
  password_hash text not null,
  role          text not null check (role in ('owner','admin','agent','superadmin')),
  created_at    timestamptz not null default now()
);
create index on users(tenant_id);

create table extensions (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  number            text not null check (number ~ '^[1-9][0-9]{1,4}$'),
  name              text not null,
  user_id           uuid references users(id) on delete set null,
  sip_username      text not null unique,   -- for softphones / desk phones
  sip_password      text not null,
  web_username      text not null unique,   -- for the browser phone (WebRTC)
  web_password      text not null,
  voicemail_enabled boolean not null default true,
  outbound_allowed  boolean not null default true,
  created_at        timestamptz not null default now(),
  unique (tenant_id, number)
);

create table audio_files (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  name       text not null,
  path       text not null,          -- absolute path without extension, playable by Asterisk
  duration_s numeric,
  created_at timestamptz not null default now()
);

-- A destination is jsonb of one of:
--  {"type":"extension","id":uuid} | {"type":"ring_group","id":uuid} | {"type":"ivr","id":uuid}
--  {"type":"voicemail","id":uuid (extension)} | {"type":"hangup"}

create table ring_groups (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  name          text not null,
  number        text check (number ~ '^[1-9][0-9]{1,4}$'),
  strategy      text not null default 'simultaneous' check (strategy in ('simultaneous','sequential')),
  ring_seconds  integer not null default 25 check (ring_seconds between 5 and 120),
  member_ids    uuid[] not null default '{}',   -- extension ids, in order
  fallback      jsonb not null default '{"type":"hangup"}',
  created_at    timestamptz not null default now(),
  unique (tenant_id, number)
);

create table ivrs (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  name           text not null,
  greeting_id    uuid references audio_files(id) on delete set null,
  options        jsonb not null default '{}',      -- {"1": destination, ...}
  allow_direct_dial boolean not null default true, -- caller may dial an extension number
  timeout_s      integer not null default 6,
  timeout_dest   jsonb not null default '{"type":"hangup"}',
  created_at     timestamptz not null default now()
);

create table phone_numbers (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid references tenants(id) on delete set null,
  e164             text not null unique check (e164 ~ '^\+[1-9][0-9]{6,14}$'),
  label            text,
  destination      jsonb not null default '{"type":"hangup"}',
  after_hours_dest jsonb,                 -- null = no business-hours routing
  business_hours   jsonb,                 -- {"0":[["08:00","17:00"]], ... } keys = weekday 0(Sun)-6
  created_at       timestamptz not null default now()
);
create index on phone_numbers(tenant_id);

create table calls (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid references tenants(id) on delete cascade,
  direction        text not null check (direction in ('inbound','outbound','internal')),
  from_number      text,
  from_name        text,
  to_number        text,
  did              text,
  extension_id     uuid references extensions(id) on delete set null,  -- placing ext (out/internal)
  answered_by      uuid references extensions(id) on delete set null,
  status           text not null default 'ringing'
                   check (status in ('ringing','answered','missed','voicemail','failed','rejected','abandoned')),
  hangup_cause     text,
  started_at       timestamptz not null default now(),
  answered_at      timestamptz,
  ended_at         timestamptz,
  duration_s       integer,      -- talk time
  recording_path   text,
  channel_id       text
);
create index on calls(tenant_id, started_at desc);

create table voicemails (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  extension_id uuid references extensions(id) on delete set null,
  call_id      uuid references calls(id) on delete set null,
  caller       text,
  path         text not null,
  duration_s   integer,
  listened     boolean not null default false,
  created_at   timestamptz not null default now()
);
create index on voicemails(tenant_id, created_at desc);

create table webhook_deliveries (
  id          bigserial primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  event       text not null,
  status_code integer,
  error       text,
  created_at  timestamptz not null default now()
);
