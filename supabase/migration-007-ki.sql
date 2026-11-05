-- Heizung München – Migration 007: KI – Raummodell, Vorschläge, Hinweise (05.11.2026)
-- Voraussetzung: migration-002 bis -006. Im Supabase SQL-Editor ausführen, kann gefahrlos mehrfach
-- ausgeführt werden. Ändert nur muc_-Objekte, Venediger bleibt unberührt. Am Collector ändert sich nichts.
--
-- Übernommen aus Venediger (KONZEPT-RAUMMODELL / KONZEPT-KI-VORSCHLAEGE, 02.–04.11.2026):
--   * Die KI misst und schlägt vor – Uli entscheidet. Geschrieben wird erst nach „Ja“.
--   * Texte aus festen Satzbausteinen mit gemessenen Zahlen – nachprüfbar, nichts erfunden.
--     (Die stündlichen Sprachmodell-Vorschläge in Venediger waren widersprüchlich und sind dort abgeschaltet.)
--   * Höchstens 3 Vorschläge am Tag, nur wenn mindestens 3 Tage dafür sprechen (Ausnahme: Einstellungsfehler).
--   * Abgelehnt → frühestens nach 7 Tagen wieder (Einstellungsfehler: 30 Tage).
--   * 3 Tage nach dem Übernehmen: Wirkungsbericht; schlechter → Rücknahme-Vorschlag.
--   * Vorschlagsfähig nur Absenk (temp_night) und PV-Laden (temp_pv) je Raum. Normal ist Ulis Wunschwert,
--     Nachtzeiten, Akku-Reserve und PV-Schwellen sind gesperrt.
--
-- Teile:
--   1. Raummodell   muc_room_nights (je Raum und Nacht: Abkühlung, nachgeheizt?, k), muc_room_model(),
--                   muc_room_outlook() (Vorhersage für die kommende Nacht)
--   2. Vorschläge   muc_ki_suggestions, muc_ki_runs, muc_ki_analyse() täglich ab „Morgen ab“ (09:00)
--   3. Hinweise     muc_ki_hints_check() alle 15 min (Wärmepumpe liefert nicht, Raumwerte fehlen, …)
--   4. Entscheiden  muc_ki_decide() – einziger Schreibweg aus der App
--   5. Takt         pg_cron „muc-ki-tick“ alle 15 min

-- ---------------------------------------------------------------------------
-- 0) Hilfsfunktionen
-- ---------------------------------------------------------------------------
create or replace function public.muc_ki_at(p_day date, p_time text)
returns timestamptz language sql immutable set search_path = public as $$
  select (p_day + coalesce(nullif(p_time, ''), '00:00')::time) at time zone 'Europe/Berlin'
$$;

-- Zahl mit Komma: muc_ki_num(21.5) = '21,5'
create or replace function public.muc_ki_num(p numeric, p_digits int default 1)
returns text language sql immutable set search_path = public as $$
  select case when p is null then '–' else replace(round(p, p_digits)::text, '.', ',') end
$$;

-- „Mi 04.11.“
create or replace function public.muc_ki_day(p date)
returns text language sql immutable set search_path = public as $$
  select (array['So','Mo','Di','Mi','Do','Fr','Sa'])[extract(dow from p)::int + 1] || ' ' || to_char(p, 'DD.MM.')
$$;

create or replace function public.muc_ki_today()
returns date language sql stable set search_path = public as $$
  select (now() at time zone 'Europe/Berlin')::date
$$;

-- ---------------------------------------------------------------------------
-- 1) Raummodell
--    Ohne Heizen nähert sich ein Raum der Außentemperatur (Newton):
--      T(t) = T_außen + (T_start − T_außen) · e^(−k·t)
--      k    = ln((T_abends − T_außen) / (T_morgens − T_außen)) / Stunden      [1/h]
--    k ist eine Eigenschaft des Raums (Estrich, Fenster, Lage) und gilt für jede Jahreszeit.
--    Nacht = night_start bis morning_start. „Nachgeheizt“ = Ventil offen, während die Wärmepumpe lief
--    (Heizstrom = Verbrauch − Auto − Grundlast > 800 W). Nächte mit offenem Ventil, aber stehender
--    Wärmepumpe (z. B. 30.10.–04.11.2026) sind damit gültige Abkühl-Nächte.
-- ---------------------------------------------------------------------------
create table if not exists public.muc_room_nights (
  night         date not null,          -- Datum des Abends
  room_id       text not null,
  t0            timestamptz,
  t1            timestamptz,
  hours         numeric,
  n             int,                    -- Messwerte
  t_start       numeric,                -- Ø erste 20 min
  t_end         numeric,                -- Ø letzte 20 min
  t_min         numeric,
  outdoor_avg   numeric,
  valve_min     int,                    -- Minuten Ventil offen
  heat_min      int,                    -- Minuten Ventil offen UND Wärmepumpe lief
  wp_min        int,                    -- Minuten Wärmepumpe lief (Haus)
  drop          numeric,                -- t_start − t_end
  k             numeric,
  valid         boolean not null default false,
  reason        text,
  temp_night    numeric,                -- Absenk zum Zeitpunkt der Berechnung
  temp_normal   numeric,
  predicted_end numeric,                -- Vorhersage bei Nachtbeginn (muc_ki_store_predictions)
  predicted_at  timestamptz,
  computed_at   timestamptz,
  primary key (night, room_id)
);

create or replace function public.muc_room_night_calc(p_night date)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_t0 timestamptz; v_t1 timestamptz; v_base int; v_hours numeric; v_out numeric; v_wp int; v_n int;
begin
  select muc_ki_at(p_night, night_start), muc_ki_at(p_night + 1, morning_start), coalesce(baseload_w, 350)
    into v_t0, v_t1, v_base from muc_settings where id = 1;
  if v_t0 is null or v_t1 <= v_t0 or now() < v_t1 then return 0; end if;
  v_hours := extract(epoch from v_t1 - v_t0) / 3600.0;

  create temp table if not exists _muc_e (m timestamptz primary key, o numeric, hw numeric) on commit drop;
  truncate _muc_e;
  insert into _muc_e
  select date_trunc('minute', ts), avg(outdoor_c), avg(greatest(consumption_w - coalesce(car_w, 0) - v_base, 0))
    from muc_energy_readings where ts >= v_t0 and ts < v_t1 group by 1;
  select avg(o), count(*) filter (where hw > 800) into v_out, v_wp from _muc_e;

  with r as (
    select rr.room_id, rr.ts, rr.temp, rr.valve,
           rr.temp - min(rr.temp) over (partition by rr.room_id order by rr.ts rows unbounded preceding) as rise,
           e.hw
      from muc_room_readings rr
      left join _muc_e e on e.m = date_trunc('minute', rr.ts)
     where rr.ts >= v_t0 and rr.ts < v_t1 and rr.temp is not null
  ), a as (
    select room_id, count(*)::int n,
           avg(temp) filter (where ts < v_t0 + interval '20 minutes') t_start,
           avg(temp) filter (where ts >= v_t1 - interval '20 minutes') t_end,
           min(temp) t_min, max(rise) rise,
           count(*) filter (where valve = 1)::int valve_min,
           count(*) filter (where valve = 1 and hw > 800)::int heat_min
      from r group by room_id
  ), x as (
    select ro.id room_id, ro.temp_night, ro.temp_normal, a.n, a.t_start, a.t_end, a.t_min, a.rise, a.valve_min, a.heat_min,
           case
             when a.n is null or a.n < v_hours * 60 * 0.6 then 'zu wenige Messwerte'
             when a.t_start is null or a.t_end is null then 'Anfang oder Ende fehlt'
             when a.heat_min > 10 then format('nachgeheizt (%s min)', a.heat_min)
             when a.rise > 0.3 then 'Temperatur zwischendurch gestiegen'
             when v_out is null then 'keine Außentemperatur'
             when a.t_start - v_out < 3 then 'zu nah an der Außentemperatur'
             else null
           end as why_invalid
      from muc_rooms ro left join a on a.room_id = ro.id
     where ro.enabled
  )
  insert into muc_room_nights as t (night, room_id, t0, t1, hours, n, t_start, t_end, t_min, outdoor_avg,
                                    valve_min, heat_min, wp_min, drop, k, valid, reason, temp_night, temp_normal, computed_at)
  select p_night, x.room_id, v_t0, v_t1, round(v_hours, 2), coalesce(x.n, 0), round(x.t_start, 2), round(x.t_end, 2), x.t_min,
         round(v_out, 1), coalesce(x.valve_min, 0), coalesce(x.heat_min, 0), v_wp, round(x.t_start - x.t_end, 2),
         case when x.why_invalid is null then
           case when x.t_end >= x.t_start then 0
                else round((ln((x.t_start - v_out) / greatest(x.t_end - v_out, 0.5)) / v_hours)::numeric, 5) end
         end,
         x.why_invalid is null, coalesce(x.why_invalid, 'gültig'), x.temp_night, x.temp_normal, now()
    from x
  on conflict (night, room_id) do update set
    t0 = excluded.t0, t1 = excluded.t1, hours = excluded.hours, n = excluded.n, t_start = excluded.t_start,
    t_end = excluded.t_end, t_min = excluded.t_min, outdoor_avg = excluded.outdoor_avg, valve_min = excluded.valve_min,
    heat_min = excluded.heat_min, wp_min = excluded.wp_min, drop = excluded.drop, k = excluded.k, valid = excluded.valid,
    reason = excluded.reason, temp_night = coalesce(t.temp_night, excluded.temp_night),
    temp_normal = coalesce(t.temp_normal, excluded.temp_normal), computed_at = excluded.computed_at;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Mehrere Nächte (Erstbefüllung und Nachholen). Messwerte gibt es 90 Tage.
create or replace function public.muc_room_nights_rebuild(p_from date, p_to date)
returns int
language plpgsql security definer set search_path = public as $$
declare d date := p_from; n int := 0;
begin
  while d <= p_to loop
    n := n + muc_room_night_calc(d);
    d := d + 1;
  end loop;
  return n;
end $$;

-- Je Raum: gelernte Werte aus den letzten 60 gültigen Nächten + Nachtheizung der letzten 7 Nächte
create or replace function public.muc_room_model()
returns table (room_id text, name text, sort int, nights int, k_med numeric, k_p75 numeric,
               drop_med numeric, outdoor_med numeric, hours_med numeric,
               nights7 int, heated7 int, heat_min7 numeric, last_night date, last_reason text,
               pred_last numeric, real_last numeric)
language sql stable security definer set search_path = public as $$
  with v as (
    select n.*, row_number() over (partition by n.room_id order by n.night desc) rn
      from muc_room_nights n where n.valid
  ), m as (
    select v.room_id, count(*)::int nights,
           percentile_cont(0.5) within group (order by v.k) k_med,
           percentile_cont(0.75) within group (order by v.k) k_p75,
           percentile_cont(0.5) within group (order by v.drop) drop_med,
           percentile_cont(0.5) within group (order by v.outdoor_avg) outdoor_med,
           percentile_cont(0.5) within group (order by v.hours) hours_med
      from v where v.rn <= 60 group by v.room_id
  ), s as (
    select n.room_id, count(*)::int nights7,
           count(*) filter (where n.heat_min > 30)::int heated7,
           avg(n.heat_min) filter (where n.wp_min > 0) heat_min7
      from muc_room_nights n
     where n.night >= muc_ki_today() - 7 and n.n > 0
     group by n.room_id
  ), l as (
    select distinct on (n.room_id) n.room_id, n.night, n.reason, n.predicted_end, n.t_end
      from muc_room_nights n where n.computed_at is not null order by n.room_id, n.night desc
  )
  select r.id, r.name, r.sort, coalesce(m.nights, 0), round(m.k_med::numeric, 5), round(m.k_p75::numeric, 5),
         round(m.drop_med::numeric, 2), round(m.outdoor_med::numeric, 1), round(m.hours_med::numeric, 1),
         coalesce(s.nights7, 0), coalesce(s.heated7, 0), round(s.heat_min7, 0),
         l.night, l.reason, l.predicted_end, l.t_end
    from muc_rooms r
    left join m on m.room_id = r.id
    left join s on s.room_id = r.id
    left join l on l.room_id = r.id
   where r.enabled
   order by r.sort
$$;

-- Vorausschau für die kommende (oder laufende) Nacht, vorsichtig gerechnet (k 75 %)
create or replace function public.muc_room_outlook()
returns table (room_id text, name text, sort int, temp_now numeric, temp_night numeric, temp_normal numeric,
               k numeric, nights int, outdoor_fc numeric, night_from timestamptz, night_to timestamptz,
               hours_left numeric, predicted_morning numeric, need_at_night_start numeric, ok boolean)
language plpgsql stable security definer set search_path = public as $$
declare
  v_today date := muc_ki_today();
  v_nb timestamptz; v_ne timestamptz; v_start timestamptz; v_out numeric;
  s muc_settings%rowtype; f muc_forecast%rowtype;
begin
  select * into s from muc_settings where id = 1;
  if now() < muc_ki_at(v_today, s.morning_start) then
    v_nb := muc_ki_at(v_today - 1, s.night_start); v_ne := muc_ki_at(v_today, s.morning_start);
  else
    v_nb := muc_ki_at(v_today, s.night_start); v_ne := muc_ki_at(v_today + 1, s.morning_start);
  end if;
  v_start := greatest(now(), v_nb);

  -- Außentemperatur für die Nacht: Prognosepunkte (in 4/8/…/24 h), die in die Nacht fallen
  select * into f from muc_forecast order by ts desc limit 1;
  select avg(p.t) into v_out from (values
      (f.ts + interval '4 hours', f.temp_4h), (f.ts + interval '8 hours', f.temp_8h),
      (f.ts + interval '12 hours', f.temp_12h), (f.ts + interval '16 hours', f.temp_16h),
      (f.ts + interval '20 hours', f.temp_20h), (f.ts + interval '24 hours', f.temp_24h)) p(at, t)
   where p.at between v_nb and v_ne and p.t is not null;
  if v_out is null then
    v_out := coalesce(f.today_min_c, f.outdoor_c,
                      (select e.outdoor_c from muc_energy_readings e where e.outdoor_c is not null order by e.ts desc limit 1));
  end if;

  return query
  with last as (
    select distinct on (rr.room_id) rr.room_id, rr.temp from muc_room_readings rr
     where rr.ts > now() - interval '2 hours' and rr.temp is not null
     order by rr.room_id, rr.ts desc
  )
  select m.room_id, m.name, m.sort, l.temp, r.temp_night, r.temp_normal,
         case when m.nights >= 3 then m.k_p75 end, m.nights, round(v_out, 1), v_nb, v_ne,
         round((extract(epoch from v_ne - v_start) / 3600.0)::numeric, 1),
         case when m.nights >= 3 and l.temp is not null and v_out is not null then
           round(v_out + (l.temp - v_out) * exp(-m.k_p75 * extract(epoch from v_ne - v_start) / 3600.0), 1) end,
         case when m.nights >= 3 and v_out is not null then
           round(v_out + (r.temp_night - v_out) * exp(m.k_p75 * extract(epoch from v_ne - v_nb) / 3600.0), 1) end,
         case when m.nights >= 3 and l.temp is not null and v_out is not null then
           v_out + (l.temp - v_out) * exp(-m.k_p75 * extract(epoch from v_ne - v_start) / 3600.0) >= r.temp_night end
    from muc_room_model() m
    join muc_rooms r on r.id = m.room_id
    left join last l on l.room_id = m.room_id
   order by m.sort;
end $$;

-- Bei Nachtbeginn die Vorhersage festhalten (wird morgens mit der Messung verglichen)
create or replace function public.muc_ki_store_predictions()
returns int
language plpgsql security definer set search_path = public as $$
declare v_nb timestamptz; v_night date; v_cnt int;
begin
  select muc_ki_at(muc_ki_today(), night_start) into v_nb from muc_settings where id = 1;
  if now() < v_nb or now() > v_nb + interval '30 minutes' then return 0; end if;
  v_night := muc_ki_today();
  insert into muc_room_nights as t (night, room_id, predicted_end, predicted_at)
  select v_night, o.room_id, o.predicted_morning, now() from muc_room_outlook() o where o.predicted_morning is not null
  on conflict (night, room_id) do update set predicted_end = excluded.predicted_end, predicted_at = excluded.predicted_at
   where t.predicted_at is null;
  get diagnostics v_cnt = row_count;
  return v_cnt;
end $$;

-- ---------------------------------------------------------------------------
-- 2) Tageswerte je Raum für die Regeln
--    kalt_min = Minuten unter Soll − 0,3 °C, während der Raum warm sein sollte
--               (Normal/Manuell: Sollwert, PV/Voll: Normaltemperatur)
--    pv_reached = in einer PV-Phase den PV-Sollwert (−0,2 °C) erreicht
-- ---------------------------------------------------------------------------
create or replace function public.muc_ki_room_day(p_day date)
returns table (room_id text, n int, cold_min int, warm_min int, pv_min int, pv_reached boolean,
               t_morning numeric, t_max numeric, valve_min int)
language sql stable security definer set search_path = public as $$
  with s as (select * from muc_settings where id = 1),
  w as (select muc_ki_at(p_day, s.morning_start) t0, muc_ki_at(p_day, s.night_start) t1 from s)
  select rr.room_id, count(*)::int,
         count(*) filter (where rr.mode in ('NORMAL','OVERRIDE','PV','VOLL','BATTERIE_VOLL','PV_LADEN')
                            and rr.temp < (case when rr.mode in ('NORMAL','OVERRIDE') then rr.target else ro.temp_normal end) - 0.3)::int,
         count(*) filter (where rr.mode in ('NORMAL','OVERRIDE','PV','VOLL','BATTERIE_VOLL','PV_LADEN'))::int,
         count(*) filter (where rr.mode in ('PV','VOLL','BATTERIE_VOLL','PV_LADEN'))::int,
         coalesce(bool_or(rr.mode in ('PV','VOLL','BATTERIE_VOLL','PV_LADEN') and rr.temp >= rr.target - 0.2), false),
         round(avg(rr.temp) filter (where rr.ts < w.t0 + interval '15 minutes'), 1),
         max(rr.temp),
         count(*) filter (where rr.valve = 1)::int
    from muc_room_readings rr
    cross join w
    join muc_rooms ro on ro.id = rr.room_id
   where rr.ts >= w.t0 and rr.ts < w.t1 and rr.temp is not null
   group by rr.room_id
$$;

-- Einspeisung eines Tages (gespeichert oder frisch gerechnet)
create or replace function public.muc_ki_feed(p_day date)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce((select feed_kwh from muc_daily_stats where day = p_day),
                  (select feed_kwh from muc_day_summary(p_day) limit 1))
$$;

-- ---------------------------------------------------------------------------
-- 3) Vorschläge, Hinweise, Tagesrückblick
-- ---------------------------------------------------------------------------
create table if not exists public.muc_ki_suggestions (
  id            bigserial primary key,
  created_at    timestamptz not null default now(),
  day           date not null default ((now() at time zone 'Europe/Berlin')::date),
  kind          text not null check (kind in ('vorschlag', 'ruecknahme', 'info', 'hinweis')),
  rule          text not null,
  room_id       text,
  param         text check (param is null or param in ('temp_night', 'temp_pv')),
  old_value     numeric,
  new_value     numeric,
  title         text not null,
  what          text,      -- Was sich ändert
  why           text,      -- Warum (mit Zahlen)
  effect        text,      -- Was es bringt – und kostet
  days          int,       -- so viele Tage/Nächte sprechen dafür
  evidence      jsonb,
  status        text not null default 'offen'
                check (status in ('offen', 'genehmigt', 'geaendert', 'abgelehnt', 'erledigt', 'veraltet')),
  decided_at    timestamptz,
  decided_value numeric,
  note          text,
  check_after   date,      -- Wirkungsbericht ab diesem Tag
  effect_text   text,
  effect_at     timestamptz,
  parent_id     bigint references public.muc_ki_suggestions(id)
);
create index if not exists muc_ki_suggestions_open on public.muc_ki_suggestions (status, kind);
create index if not exists muc_ki_suggestions_rule on public.muc_ki_suggestions (rule, room_id, created_at desc);

create table if not exists public.muc_ki_runs (
  day        date primary key,          -- Tag der Analyse (Rückblick auf den Vortag)
  created_at timestamptz not null default now(),
  summary    text,
  stats      jsonb,
  result     text
);

-- Darf für (Regel, Raum) ein neuer Eintrag entstehen?
create or replace function public.muc_ki_allowed(p_rule text, p_room text, p_block_days int)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (
    select 1 from muc_ki_suggestions s
     where s.rule = p_rule and s.room_id is not distinct from p_room
       and (s.status = 'offen'
            or (s.status = 'abgelehnt' and s.decided_at > now() - make_interval(days => p_block_days))
            or (s.kind = 'info' and s.created_at > now() - make_interval(days => p_block_days)))
  )
$$;

-- Tägliche Analyse (Rückblick auf p_day = gestern und die Nacht bis heute früh)
create or replace function public.muc_ki_analyse(p_day date default null)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_day   date := coalesce(p_day, muc_ki_today() - 1);
  v_run   date := v_day + 1;
  v_from  date := v_day - 6;               -- 7 Tage
  r record; x record;
  v_cnt int := 0; v_cfg int := 0; v_info int := 0; v_hint int; v_new numeric; v_cap numeric;
  v_sum text; v_stats jsonb; v_feed numeric; v_heat numeric; v_ds record; v_nights text; v_cold text; v_missing int; v_n_rooms int;
begin
  -- a) Nächte der letzten 8 Tage (neu) rechnen
  perform muc_room_nights_rebuild(v_day - 7, v_day);

  -- b) Offene Vorschläge, deren Ausgangswert nicht mehr stimmt → veraltet
  update muc_ki_suggestions s set status = 'veraltet', decided_at = now(),
         note = 'Wert wurde inzwischen anders eingestellt'
    from muc_rooms ro
   where s.status = 'offen' and s.kind in ('vorschlag', 'ruecknahme') and ro.id = s.room_id
     and s.old_value is distinct from (case s.param when 'temp_night' then ro.temp_night else ro.temp_pv end);

  -- c) Tageswerte der letzten 7 Tage
  create temp table if not exists _muc_days (day date, room_id text, n int, cold_min int, warm_min int, pv_min int,
                                             pv_reached boolean, t_morning numeric, t_max numeric, valve_min int, feed numeric, heat numeric) on commit drop;
  truncate _muc_days;
  for x in select generate_series(v_from, v_day, interval '1 day')::date d loop
    select coalesce(ds.feed_kwh, sm.feed_kwh), coalesce(ds.heat_kwh, sm.heat_kwh) into v_feed, v_heat
      from (select 1) one
      left join muc_daily_stats ds on ds.day = x.d
      left join lateral (select * from muc_day_summary(x.d) limit 1) sm on ds.day is null;
    insert into _muc_days select x.d, t.*, v_feed, v_heat from muc_ki_room_day(x.d) t;
  end loop;

  -- d) Wirkungsberichte (3 Tage nach dem Übernehmen)
  for r in
    select s.*, ro.name, ro.temp_night cur_night, ro.temp_pv cur_pv
      from muc_ki_suggestions s join muc_rooms ro on ro.id = s.room_id
     where s.status in ('genehmigt', 'geaendert') and s.kind = 'vorschlag'
       and s.check_after is not null and s.check_after <= v_run and s.effect_at is null
  loop
    declare
      d0 date := (r.decided_at at time zone 'Europe/Berlin')::date;
      hb numeric; ha numeric; cb numeric; ca numeric; verdict text; worse boolean;
    begin
      select avg(heat_min) filter (where night between d0 - 3 and d0 - 1),
             avg(heat_min) filter (where night between d0 and d0 + 2)
        into hb, ha from muc_room_nights where room_id = r.room_id and n > 0;
      select avg(t.cold_min) into cb from generate_series(d0 - 3, d0 - 1, interval '1 day') g(d), muc_ki_room_day(g.d::date) t where t.room_id = r.room_id;
      select avg(t.cold_min) into ca from generate_series(d0 + 1, d0 + 3, interval '1 day') g(d), muc_ki_room_day(g.d::date) t where t.room_id = r.room_id;
      worse := coalesce(ca, 0) - coalesce(cb, 0) > 60;
      verdict := case
        when worse then 'schlechter: der Raum lag danach deutlich länger unter Soll'
        when ha is not null and hb is not null and ha < hb - 15 then 'wie erwartet: nachts weniger nachgeheizt'
        else 'keine klare Wirkung erkennbar (Wetter und Sonne waren anders)' end;
      update muc_ki_suggestions set effect_at = now(),
             effect_text = format('%s: %s. Nachts nachgeheizt vorher Ø %s min, nachher Ø %s min. Unter Soll tagsüber vorher Ø %s min, nachher Ø %s min.',
                                  r.name, verdict, muc_ki_num(hb, 0), muc_ki_num(ha, 0), muc_ki_num(cb, 0), muc_ki_num(ca, 0))
       where id = r.id;
      if worse and muc_ki_allowed('ruecknahme', r.room_id, 7)
         and (case r.param when 'temp_night' then r.cur_night else r.cur_pv end) = r.decided_value then
        insert into muc_ki_suggestions (day, kind, rule, room_id, param, old_value, new_value, title, what, why, effect, days, parent_id, evidence)
        values (v_run, 'ruecknahme', 'ruecknahme', r.room_id, r.param, r.decided_value, r.old_value,
                format('%s: Änderung zurücknehmen?', r.name),
                format('%s %s → %s °C (wie vorher)', case r.param when 'temp_night' then 'Absenk' else 'PV-Laden' end,
                       muc_ki_num(r.decided_value), muc_ki_num(r.old_value)),
                format('Seit der Änderung lag der Raum tagsüber im Schnitt %s min unter Soll, vorher %s min.', muc_ki_num(ca, 0), muc_ki_num(cb, 0)),
                'Der alte Wert war wärmer – zurück auf den bewährten Stand.', 3, r.id,
                jsonb_build_object('heat_before', hb, 'heat_after', ha, 'cold_before', cb, 'cold_after', ca));
        v_cnt := v_cnt + 1;
      end if;
    end;
  end loop;

  -- e) Regeln je Raum
  for r in
    select ro.*, m.nights, m.drop_med, m.k_p75, m.heated7, m.heat_min7, m.nights7,
           (select count(*) from _muc_days d where d.room_id = ro.id and d.cold_min > 120 and d.heat >= 3) cold_days,
           (select round(avg(d.cold_min) filter (where d.cold_min > 120) / 60.0, 1) from _muc_days d where d.room_id = ro.id and d.heat >= 3) cold_h,
           (select count(*) from _muc_days d where d.room_id = ro.id and d.feed >= 2 and d.heat >= 3 and d.pv_reached) pv_full_days,
           (select string_agg(muc_ki_day(d.day), ', ' order by d.day) from _muc_days d where d.room_id = ro.id and d.feed >= 2 and d.heat >= 3 and d.pv_reached) pv_full_list,
           (select count(distinct d.day) from _muc_days d where d.feed >= 2 and d.heat >= 3) sunny_days,
           (select count(*) from muc_room_nights n where n.room_id = ro.id and n.night between v_from - 1 and v_day and n.heat_min > 30) night_heat_n,
           (select round(avg(n.heat_min) filter (where n.heat_min > 30)) from muc_room_nights n where n.room_id = ro.id and n.night between v_from - 1 and v_day) night_heat_avg,
           (select count(*) from muc_room_nights n where n.room_id = ro.id and n.night between v_from - 1 and v_day and n.n > 0) nights_seen
      from muc_rooms ro left join muc_room_model() m on m.room_id = ro.id
     where ro.enabled
     order by ro.sort
  loop
    -- R1 Einstellungsfehler: Absenk ≥ Normal → Absenk = Normal − 1 (Ulis Regel, 05.11.2026)
    if r.temp_night >= r.temp_normal and muc_ki_allowed('absenk_fehlt', r.id, 30) then
      v_new := greatest(r.temp_normal - 1, r.min_temp);
      insert into muc_ki_suggestions (day, kind, rule, room_id, param, old_value, new_value, title, what, why, effect, days, evidence)
      values (v_run, 'vorschlag', 'absenk_fehlt', r.id, 'temp_night', r.temp_night, v_new,
              case when r.temp_night > r.temp_normal then format('%s: Absenk liegt über Normal – vertauscht?', r.name)
                   else format('%s: nachts 1 °C absenken?', r.name) end,
              format('Absenk %s → %s °C (Normal bleibt %s °C)', muc_ki_num(r.temp_night), muc_ki_num(v_new), muc_ki_num(r.temp_normal)),
              case when r.temp_night > r.temp_normal then
                     format('Absenk (%s °C) ist höher als Normal (%s °C). Nachts wird der Raum damit wärmer gehalten als tagsüber. Ist eigentlich Normal zu niedrig, stell Normal selbst höher.',
                            muc_ki_num(r.temp_night), muc_ki_num(r.temp_normal))
                   when r.night_heat_n > 0 then
                     format('Absenk und Normal sind gleich (%s °C). Der Raum wird deshalb nachts schon nachgeheizt, wenn er wenige Zehntelgrad abkühlt – gemessen in %s von %s der letzten Nächte, im Schnitt %s min.',
                            muc_ki_num(r.temp_normal), r.night_heat_n, r.nights_seen, r.night_heat_avg)
                   else format('Absenk und Normal sind gleich (%s °C). Damit heizt die Wärmepumpe nachts nach, sobald der Raum wenige Zehntelgrad abkühlt. In den letzten Nächten kam das noch nicht vor – der Vorschlag folgt deiner Regel „Absenk = Normal − 1 °C“.',
                            muc_ki_num(r.temp_normal))
              end,
              case when r.nights >= 3 then
                     format('Gemessen kühlt der Raum ohne Heizen pro Nacht etwa %s °C ab. 1 °C Puffer reicht, damit die Wärmepumpe nachts meist aus bleibt und der Estrich die Nacht überbrückt. Morgens ist der Raum dafür bis zu 1 °C kühler, bis die Heizzeit beginnt.',
                            muc_ki_num(r.drop_med))
                   else 'Mit 1 °C Puffer überbrückt der Estrich die Nacht, die Wärmepumpe bleibt nachts meist aus. Morgens ist der Raum dafür bis zu 1 °C kühler, bis die Heizzeit beginnt.'
              end,
              r.nights_seen, jsonb_build_object('nights_heated', r.night_heat_n, 'nights_seen', r.nights_seen, 'heat_min_avg', r.night_heat_avg, 'drop_med', r.drop_med));
      v_cfg := v_cfg + 1;
      continue;
    end if;

    -- R3 Estrich laden: an ≥ 3 Sonnentagen PV-Wert erreicht, trotzdem ≥ 2 kWh eingespeist → PV-Laden + 0,5
    if r.pv_prio > 0 and r.pv_full_days >= 3 and v_cnt < 3 then
      v_cap := least(r.temp_normal + 2, r.max_temp, 26);
      if r.temp_pv + 0.5 <= v_cap and muc_ki_allowed('estrich_mehr', r.id, 7) then
        insert into muc_ki_suggestions (day, kind, rule, room_id, param, old_value, new_value, title, what, why, effect, days, evidence)
        values (v_run, 'vorschlag', 'estrich_mehr', r.id, 'temp_pv', r.temp_pv, r.temp_pv + 0.5,
                format('%s: mit Sonne etwas mehr laden?', r.name),
                format('PV-Laden %s → %s °C', muc_ki_num(r.temp_pv), muc_ki_num(r.temp_pv + 0.5)),
                format('An %s Sonnentagen (%s) hat der Raum seinen PV-Wert erreicht, und trotzdem gingen jeweils mindestens 2 kWh ins Netz.', r.pv_full_days, r.pv_full_list),
                'Mehr Sonnenwärme im Estrich, die abends und nachts nachwirkt – weniger Netzstrom für die Heizung. Der Raum wird an Sonnentagen bis zu 0,5 °C wärmer.',
                r.pv_full_days, jsonb_build_object('days', r.pv_full_list));
        v_cnt := v_cnt + 1;
        continue;
      end if;
    end if;

    -- R2 Nacht reicht nicht: an ≥ 3 Nächten > 30 min nachgeheizt (obwohl Absenk < Normal)
    if r.temp_night < r.temp_normal and r.night_heat_n >= 3 then
      if r.pv_prio > 0 and r.sunny_days >= 2 and v_cnt < 3 and r.temp_pv + 0.5 <= least(r.temp_normal + 2, r.max_temp, 26)
         and muc_ki_allowed('nacht_nachgeheizt', r.id, 7) and muc_ki_allowed('estrich_mehr', r.id, 7) then
        insert into muc_ki_suggestions (day, kind, rule, room_id, param, old_value, new_value, title, what, why, effect, days, evidence)
        values (v_run, 'vorschlag', 'nacht_nachgeheizt', r.id, 'temp_pv', r.temp_pv, r.temp_pv + 0.5,
                format('%s: tagsüber mehr Wärme speichern?', r.name),
                format('PV-Laden %s → %s °C', muc_ki_num(r.temp_pv), muc_ki_num(r.temp_pv + 0.5)),
                format('In %s der letzten %s Nächte wurde der Raum nachgeheizt (im Schnitt %s min). Der Estrich reicht nicht über die Nacht.',
                       r.night_heat_n, r.nights_seen, r.night_heat_avg),
                'An Sonnentagen mehr Wärme in den Estrich – nachts weniger Netzstrom. An trüben Tagen ändert sich nichts.',
                r.night_heat_n, jsonb_build_object('nights_heated', r.night_heat_n, 'heat_min_avg', r.night_heat_avg));
        v_cnt := v_cnt + 1;
      elsif muc_ki_allowed('nacht_nachgeheizt_info', r.id, 7) then
        insert into muc_ki_suggestions (day, kind, rule, room_id, title, why, days, evidence, status)
        values (v_run, 'info', 'nacht_nachgeheizt_info', r.id,
                format('%s wird nachts nachgeheizt', r.name),
                format('In %s der letzten %s Nächte (im Schnitt %s min). Ohne Sonne lässt sich der Estrich tagsüber nicht vorladen – das ist dann normal. Bleibt es so, Absenk prüfen.',
                       r.night_heat_n, r.nights_seen, r.night_heat_avg),
                r.night_heat_n, jsonb_build_object('nights_heated', r.night_heat_n), 'erledigt');
        v_info := v_info + 1;
      end if;
    end if;

    -- R4 Beobachtung: an ≥ 3 Tagen > 2 h unter Soll, obwohl der Raum warm sein sollte
    if r.cold_days >= 3 and muc_ki_allowed('zu_kalt', r.id, 7) then
      insert into muc_ki_suggestions (day, kind, rule, room_id, title, why, days, evidence, status)
      values (v_run, 'info', 'zu_kalt', r.id,
              format('%s erreicht seinen Sollwert nicht', r.name),
              format('An %s der letzten 7 Tage lag der Raum während seiner Heizzeit mehr als 2 h unter Soll (im Schnitt %s h). Mögliche Ursachen: Wärmepumpe lieferte nicht, Ventil oder Heizkreis. Einen Wert ändert die KI dafür nicht.',
                     r.cold_days, muc_ki_num(r.cold_h)),
              r.cold_days, jsonb_build_object('cold_days', r.cold_days, 'cold_h', r.cold_h), 'erledigt');
      v_info := v_info + 1;
    end if;
  end loop;

  -- f) Rückblick auf gestern
  select * into v_ds from muc_daily_stats where day = v_day;
  if not found then select * into v_ds from muc_day_summary(v_day) limit 1; end if;
  select string_agg(format('%s %s min', ro.name, n.heat_min), ', ' order by n.heat_min desc)
    into v_nights
    from (select * from muc_room_nights where night = v_day and heat_min > 30 order by heat_min desc limit 3) n
    join muc_rooms ro on ro.id = n.room_id;
  select string_agg(format('%s %s h', ro.name, muc_ki_num(d.cold_min / 60.0)), ', ' order by d.cold_min desc)
    into v_cold
    from (select * from _muc_days where day = v_day and cold_min > 60 order by cold_min desc limit 3) d
    join muc_rooms ro on ro.id = d.room_id;
  select count(*) into v_hint from muc_ki_suggestions where kind = 'hinweis' and status = 'offen';
  select count(*) into v_n_rooms from muc_rooms where enabled;
  select v_n_rooms - count(*) into v_missing from _muc_days where day = v_day and n >= 576;

  v_sum := format('%s: außen Ø %s °C, Sonne %s kWh, davon %s kWh ins Netz. Wärmepumpe ca. %s kWh, davon %s kWh aus dem Netz.',
                  muc_ki_day(v_day), muc_ki_num(v_ds.outdoor_avg), muc_ki_num(v_ds.pv_kwh), muc_ki_num(v_ds.feed_kwh),
                  muc_ki_num(v_ds.heat_kwh), muc_ki_num(v_ds.heat_grid_kwh))
        || case when v_cold is not null then ' Unter Soll: ' || v_cold || '.' else ' Alle Räume lagen in ihrer Heizzeit im Rahmen.' end
        || case when v_nights is not null then ' Letzte Nacht nachgeheizt: ' || v_nights || '.' else ' Letzte Nacht wurde kein Raum nachgeheizt.' end
        || case when coalesce(v_ds.heat_kwh, 0) < 3 and coalesce(v_ds.outdoor_avg, 0) < 15 then ' Die Wärmepumpe hat praktisch nicht geheizt.' else '' end
        || case when v_missing > 0 then format(' Für %s von %s Räumen fehlen Messwerte – die Aussagen dazu sind unvollständig.', v_missing, v_n_rooms) else '' end;

  v_stats := jsonb_build_object('outdoor_avg', v_ds.outdoor_avg, 'pv_kwh', v_ds.pv_kwh, 'feed_kwh', v_ds.feed_kwh,
                                'heat_kwh', v_ds.heat_kwh, 'heat_grid_kwh', v_ds.heat_grid_kwh,
                                'suggestions', v_cnt + v_cfg, 'infos', v_info, 'hints_open', v_hint, 'rooms_missing', v_missing);

  insert into muc_ki_runs (day, summary, stats, result, created_at)
  values (v_run, v_sum, v_stats, format('%s Vorschläge, %s Infos', v_cnt + v_cfg, v_info), now())
  on conflict (day) do update set summary = excluded.summary, stats = excluded.stats, result = excluded.result, created_at = now();

  return v_sum;
end $$;

-- ---------------------------------------------------------------------------
-- 4) Sofort-Hinweise (alle 15 min) – erledigen sich selbst, wenn der Grund weg ist
-- ---------------------------------------------------------------------------
create or replace function public.muc_ki_hint(p_rule text, p_title text, p_why text, p_effect text, p_active boolean, p_done text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_active, false) then
    if not exists (select 1 from muc_ki_suggestions where kind = 'hinweis' and rule = p_rule
                    and (status = 'offen' or (status = 'abgelehnt' and decided_at > now() - interval '24 hours'))) then
      insert into muc_ki_suggestions (kind, rule, title, why, effect) values ('hinweis', p_rule, p_title, p_why, p_effect);
    else
      update muc_ki_suggestions set why = p_why where kind = 'hinweis' and rule = p_rule and status = 'offen';
    end if;
  else
    update muc_ki_suggestions set status = 'erledigt', decided_at = now(),
           effect_text = p_done || ' (' || to_char(now() at time zone 'Europe/Berlin', 'DD.MM. HH24:MI') || ')'
     where kind = 'hinweis' and rule = p_rule and status = 'offen';
  end if;
end $$;

create or replace function public.muc_ki_hints_check()
returns int
language plpgsql security definer set search_path = public as $$
declare
  s muc_settings%rowtype;
  v_last_e timestamptz; v_last_r timestamptz; v_open int; v_hw numeric; v_hw30 numeric; v_out numeric; v_ne int;
  v_cold text;
begin
  select * into s from muc_settings where id = 1;
  select max(ts) into v_last_e from muc_energy_readings where ts > now() - interval '3 days';
  select max(ts) into v_last_r from muc_room_readings where ts > now() - interval '3 days';

  -- Collector meldet sich nicht
  perform muc_ki_hint('collector_still', 'Collector meldet sich nicht',
    format('Letzte Messwerte vom Mini-PC: %s. Ohne Collector wird nichts geregelt und nichts gemessen.',
           coalesce(to_char(v_last_e at time zone 'Europe/Berlin', 'DD.MM. HH24:MI'), 'keine')),
    'Mini-PC und Dienst „HeizungMuenchen“ prüfen (nssm status HeizungMuenchen).',
    v_last_e is null or v_last_e < now() - interval '15 minutes', 'Collector liefert wieder Werte');

  -- Raumwerte fehlen, obwohl der Collector läuft
  perform muc_ki_hint('raumwerte_fehlen', 'Keine Raumwerte von Loxone',
    format('Seit %s kommen keine Raumtemperaturen mehr an, die Energiewerte schon. Die Räume werden dann nicht geregelt.',
           coalesce(to_char(v_last_r at time zone 'Europe/Berlin', 'DD.MM. HH24:MI'), 'längerem')),
    'Loxone-Verbindung prüfen (App oben „Letzter Fehler“, Collector-Log).',
    v_last_e > now() - interval '10 minutes' and (v_last_r is null or v_last_r < now() - interval '30 minutes'),
    'Raumwerte kommen wieder');

  -- Automatik / Testmodus länger aus
  perform muc_ki_hint('automatik_aus', 'Automatik ist aus',
    format('Seit %s schreibt die App keine Sollwerte. Loxone behält die zuletzt gesetzten Werte.',
           to_char(s.updated_at at time zone 'Europe/Berlin', 'DD.MM. HH24:MI')),
    'Wenn nicht gewollt: Einstellungen → Automatik an.',
    not s.automation_enabled and s.updated_at < now() - interval '6 hours', 'Automatik wieder an');
  perform muc_ki_hint('testmodus', 'Testmodus ist an',
    'Die App rechnet nur, schreibt aber nichts nach Loxone.',
    'Wenn nicht gewollt: Einstellungen → Testmodus aus.',
    s.dry_run and s.updated_at < now() - interval '6 hours', 'Testmodus aus');

  -- Wärmepumpe liefert keine Wärme: 2 h lang ≥ 3 Ventile fast durchgehend offen, Heizstrom ≈ 0
  select avg(greatest(e.consumption_w - coalesce(e.car_w, 0) - coalesce(s.baseload_w, 350), 0)), avg(e.outdoor_c), count(*)
    into v_hw, v_out, v_ne
    from muc_energy_readings e where e.ts > now() - interval '2 hours';
  select avg(greatest(e.consumption_w - coalesce(e.car_w, 0) - coalesce(s.baseload_w, 350), 0))
    into v_hw30 from muc_energy_readings e where e.ts > now() - interval '30 minutes';
  select count(*) into v_open from (
    select rr.room_id from muc_room_readings rr where rr.ts > now() - interval '2 hours'
     group by rr.room_id having count(*) >= 90 and avg(rr.valve) >= 0.8) q;
  select string_agg(format('%s %s °C', ro.name, muc_ki_num(l.temp)), ', ' order by l.temp)
    into v_cold
    from (select distinct on (rr.room_id) rr.room_id, rr.temp from muc_room_readings rr
           where rr.ts > now() - interval '15 minutes' and rr.valve = 1 order by rr.room_id, rr.ts desc) l
    join muc_rooms ro on ro.id = l.room_id
   where l.temp is not null and l.temp < ro.temp_normal - 1;

  if exists (select 1 from muc_ki_suggestions where kind = 'hinweis' and rule = 'wp_keine_waerme' and status = 'offen') then
    -- erst erledigt, wenn die Wärmepumpe 30 min deutlich läuft
    perform muc_ki_hint('wp_keine_waerme', 'Wärmepumpe liefert keine Wärme',
      format('%s Raumventile sind offen, der Heizstrom liegt aber nur bei etwa %s W (Verbrauch ohne Auto und Grundlast). Außen %s °C.%s',
             v_open, muc_ki_num(v_hw, 0), muc_ki_num(v_out), coalesce(' Kalt: ' || v_cold || '.', '')),
      'Wärmepumpe am Bedienteil prüfen: Störung, Sommerbetrieb, Heizgrenze, Sperrzeit oder Sicherung.',
      not coalesce(v_hw30 > 800, false), 'Wärmepumpe läuft wieder');
  else
    perform muc_ki_hint('wp_keine_waerme', 'Wärmepumpe liefert keine Wärme',
      format('Seit mindestens 2 Stunden sind %s Raumventile offen, der Heizstrom liegt aber nur bei etwa %s W (Verbrauch ohne Auto und Grundlast). Außen %s °C.%s',
             v_open, muc_ki_num(v_hw, 0), muc_ki_num(v_out), coalesce(' Kalt: ' || v_cold || '.', '')),
      'Wärmepumpe am Bedienteil prüfen: Störung, Sommerbetrieb, Heizgrenze, Sperrzeit oder Sicherung.',
      v_ne >= 90 and v_open >= 3 and v_hw < 300 and coalesce(v_out, 0) < 15, 'Wärmepumpe läuft wieder');
  end if;

  select count(*) into v_open from muc_ki_suggestions where kind = 'hinweis' and status = 'offen';
  return v_open;
end $$;

-- ---------------------------------------------------------------------------
-- 5) Entscheiden (einziger Schreibweg aus der App)
--    p_action: 'ja' (Vorschlag übernehmen) · 'wert' (eigenen Wert übernehmen) · 'nein' (ablehnen / Hinweis ausblenden)
-- ---------------------------------------------------------------------------
create or replace function public.muc_ki_decide(p_id bigint, p_action text, p_value numeric default null, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s muc_ki_suggestions%rowtype; ro muc_rooms%rowtype; v numeric; cur numeric; lo numeric; hi numeric; lbl text;
begin
  select * into s from muc_ki_suggestions where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'msg', 'Eintrag nicht gefunden'); end if;
  if s.status <> 'offen' then return jsonb_build_object('ok', false, 'msg', 'Wurde bereits entschieden'); end if;

  if p_action = 'nein' then
    update muc_ki_suggestions set status = 'abgelehnt', decided_at = now(), note = nullif(p_note, '') where id = p_id;
    return jsonb_build_object('ok', true, 'msg', case when s.kind = 'hinweis' then 'Ausgeblendet' else 'Abgelehnt – kommt frühestens in 7 Tagen wieder' end);
  end if;

  if s.kind not in ('vorschlag', 'ruecknahme') or s.param is null then
    return jsonb_build_object('ok', false, 'msg', 'Hier gibt es nichts zu übernehmen');
  end if;
  if p_action not in ('ja', 'wert') then return jsonb_build_object('ok', false, 'msg', 'Unbekannte Aktion'); end if;

  select * into ro from muc_rooms where id = s.room_id for update;
  v := round(case when p_action = 'ja' then s.new_value else p_value end, 1);
  if v is null then return jsonb_build_object('ok', false, 'msg', 'Kein Wert angegeben'); end if;

  if s.param = 'temp_night' then
    cur := ro.temp_night; lo := greatest(ro.min_temp, 5); hi := ro.temp_normal; lbl := 'Absenk';
  else
    cur := ro.temp_pv; lo := ro.temp_normal; hi := least(ro.max_temp, 26); lbl := 'PV-Laden';
  end if;
  if cur is distinct from s.old_value then
    update muc_ki_suggestions set status = 'veraltet', decided_at = now(), note = 'Wert war inzwischen anders eingestellt' where id = p_id;
    return jsonb_build_object('ok', false, 'msg', format('%s steht inzwischen auf %s °C – Vorschlag verworfen.', lbl, muc_ki_num(cur)));
  end if;
  if v < lo or v > hi then
    return jsonb_build_object('ok', false, 'msg', format('%s muss zwischen %s und %s °C liegen.', lbl, muc_ki_num(lo), muc_ki_num(hi)));
  end if;

  if s.param = 'temp_night' then
    update muc_rooms set temp_night = v where id = ro.id;
  else
    update muc_rooms set temp_pv = v where id = ro.id;
  end if;

  insert into muc_decisions (kind, room_id, mode, target, reason, dry_run)
  values ('ki', ro.id, null, v, format('KI-%s übernommen: %s %s → %s °C. %s',
          case s.kind when 'ruecknahme' then 'Rücknahme' else 'Vorschlag' end, lbl, muc_ki_num(cur), muc_ki_num(v), coalesce(s.why, '')), false);

  update muc_ki_suggestions
     set status = case when v = s.new_value then 'genehmigt' else 'geaendert' end,
         decided_at = now(), decided_value = v, note = nullif(p_note, ''),
         check_after = case when s.kind = 'vorschlag' then muc_ki_today() + 4 end
   where id = p_id;
  return jsonb_build_object('ok', true, 'msg', format('%s: %s %s → %s °C übernommen. Der Collector setzt es innerhalb einer Minute um.',
                                                       ro.name, lbl, muc_ki_num(cur), muc_ki_num(v)));
end $$;

-- ---------------------------------------------------------------------------
-- 6) Takt: alle 15 min Hinweise; bei Nachtbeginn Vorhersage; ab „Morgen ab“ einmal täglich die Analyse
-- ---------------------------------------------------------------------------
create or replace function public.muc_ki_tick()
returns text
language plpgsql security definer set search_path = public as $$
declare v_hints int; v_pred int; v_res text := null; v_today date := muc_ki_today(); v_me timestamptz;
begin
  v_hints := muc_ki_hints_check();
  v_pred := muc_ki_store_predictions();
  select muc_ki_at(v_today, morning_end) into v_me from muc_settings where id = 1;
  if now() >= v_me and not exists (select 1 from muc_ki_runs where day = v_today) then
    v_res := muc_ki_analyse(v_today - 1);
  end if;
  return format('Hinweise offen: %s · Vorhersagen: %s%s', v_hints, v_pred, coalesce(' · Analyse: ' || v_res, ''));
end $$;

-- Aus der App: „Jetzt neu analysieren“ (heute noch einmal)
create or replace function public.muc_ki_run_now()
returns text
language plpgsql security definer set search_path = public as $$
begin
  perform muc_ki_hints_check();
  return muc_ki_analyse(muc_ki_today() - 1);
end $$;

-- ---------------------------------------------------------------------------
-- 7) Rechte
-- ---------------------------------------------------------------------------
alter table public.muc_room_nights enable row level security;
alter table public.muc_ki_suggestions enable row level security;
alter table public.muc_ki_runs enable row level security;
drop policy if exists "muc auth read" on public.muc_room_nights;
create policy "muc auth read" on public.muc_room_nights for select to authenticated using (true);
drop policy if exists "muc auth read" on public.muc_ki_suggestions;
create policy "muc auth read" on public.muc_ki_suggestions for select to authenticated using (true);
drop policy if exists "muc auth read" on public.muc_ki_runs;
create policy "muc auth read" on public.muc_ki_runs for select to authenticated using (true);
grant select on public.muc_room_nights, public.muc_ki_suggestions, public.muc_ki_runs to authenticated;
grant all on public.muc_room_nights, public.muc_ki_suggestions, public.muc_ki_runs to service_role;
grant usage, select on sequence public.muc_ki_suggestions_id_seq to service_role;

do $$
declare f text;
begin
  -- interne Funktionen: nicht für anon/authenticated
  foreach f in array array[
    'muc_room_night_calc(date)', 'muc_room_nights_rebuild(date, date)', 'muc_ki_store_predictions()',
    'muc_ki_analyse(date)', 'muc_ki_hint(text, text, text, text, boolean, text)', 'muc_ki_hints_check()',
    'muc_ki_tick()', 'muc_ki_allowed(text, text, int)', 'muc_ki_room_day(date)', 'muc_ki_feed(date)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  -- für die App
  foreach f in array array[
    'muc_room_model()', 'muc_room_outlook()', 'muc_ki_decide(bigint, text, numeric, text)', 'muc_ki_run_now()'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 8) Takt einplanen (pg_cron) und Erstbefüllung
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'muc-ki-tick') then
    perform cron.unschedule('muc-ki-tick');
  end if;
  perform cron.schedule('muc-ki-tick', '*/15 * * * *', 'select public.muc_ki_tick()');
end $$;

-- Nächte seit Beginn der Messung (90 Tage Messwerte) einmal rechnen
select public.muc_room_nights_rebuild(
  coalesce((select (min(ts) at time zone 'Europe/Berlin')::date from public.muc_room_readings), public.muc_ki_today() - 14),
  public.muc_ki_today() - 1);
