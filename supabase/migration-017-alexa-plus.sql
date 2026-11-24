-- migration-017-alexa-plus.sql (24.11.2026)
-- Alexa+-Add-on „Meine Heizung“ (MCP-Server, Edge Function mcp-heizung) – Anleitung doc/ALEXA-PLUS.md
--
-- Eine Tabelle für die OAuth-Anmeldung von Alexa+: offene Anfragen, Codes, Zugangs- und Refresh-Tokens.
-- Gespeichert wird nur der SHA-256-Hash. Nur die Edge Function (service_role) darf lesen und schreiben.
-- Venediger-Tabellen bleiben unverändert.

create table if not exists public.muc_mcp_oauth (
  id          text primary key,                      -- SHA-256 (base64url) des Codes bzw. Tokens
  kind        text not null check (kind in ('request', 'code', 'access', 'refresh')),
  user_id     uuid,                                  -- Supabase-Benutzer nach der Kontoverknüpfung (null = Alexa+ selbst)
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists muc_mcp_oauth_expires on public.muc_mcp_oauth (expires_at);

alter table public.muc_mcp_oauth enable row level security;
revoke all on public.muc_mcp_oauth from anon, authenticated;

comment on table public.muc_mcp_oauth is
  'Alexa+ MCP-Add-on: OAuth-Anfragen/Codes/Tokens (nur Hash). Nur service_role. migration-017, doc/ALEXA-PLUS.md';

-- Protokoll: Sprachbefehle von Alexa+ erscheinen in muc_decisions mit kind = ''alexa_plus''
-- (der Skill schreibt weiter ''alexa''). Keine Schemaänderung nötig, kind ist frei.

-- Kontoverknüpfungen ansehen / alle Alexa+-Zugänge sofort sperren:
--   select kind, user_id, created_at, expires_at from muc_mcp_oauth order by created_at desc;
--   delete from muc_mcp_oauth;
