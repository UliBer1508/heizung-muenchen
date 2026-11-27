-- migration-021-ki-ventile.sql (27.11.2026)
-- KI prüft die Ventilsteuerung (Uli 27.11.2026, 12:47):
--   1. Werden die Räume richtig aufgeheizt? Auf → Temperatur richtig → zu → nächste Räume.
--   2. Schaltet ein Ventil zu oft, ist die Steuerung falsch → KI meldet → Einstellung ändern (Uli entscheidet).
--
-- Neu:
--   muc_ki_hints_regelung()   Sofort-Hinweise alle 15 min:
--       ventil_oeffnet_nicht  Soll ≥ Ist + 1 °C seit 45 min, Ventil die ganze Zeit zu (Loxone folgt nicht)
--       raum_nicht_warm       Ventil 6 h ≥ 80 % offen, Wärmepumpe lief (Heizstrom ≥ 800 W), Raum nicht wärmer geworden
--       ventil_schaltet_oft   ein Raum öffnet in 6 h ≥ 4-mal; Ursache Automatik (Sollwert gewechselt) oder Loxone
--   muc_ki_schalten(p_day)    tägliche Auswertung nach der Analyse:
--       Vorschlag „Spanne“ (muc_settings.seq_off_delta) + 0,5 °C, wenn ≥ 2 Räume ≥ 6-mal am Tag geöffnet haben
--       Info, wenn die Spanne in diesen Räumen durch Min begrenzt ist (Normal − Min kleiner als Spanne) –
--       Min/Normal stellt nur Uli ein
--       Wirkungsbericht 3 Tage nach dem Übernehmen (Öffnungen je Raum und Tag vorher/nachher)
--   muc_ki_decide             kann jetzt auch den Hauswert seq_off_delta übernehmen (0,5–3 °C)
--   muc_ki_tick               ruft beides auf
-- Eingespielt in Supabase am 27.11.2026 durch Claude.

create or replace function public.muc_ki_hints_regelung()
returns integer language plpgsql security definer set search_path to 'public' as $$
declare
  s muc_settings%rowtype;
  v_list text; v_n int; v_hw numeric; v_total int := 0;
begin
  select * into s from muc_settings where id = 1;

  -- 1. Ventil öffnet nicht: App will heizen, Loxone macht nicht auf
  select string_agg(format('%s (Ist %s °C, Soll %s °C)', ro.name, muc_ki_num(q.t), muc_ki_num(q.sp)), ', ' order by ro.sort), count(*)
    into v_list, v_n
    from (select rr.room_id, avg(rr.temp) t, avg(rr.setpoint) sp
            from muc_room_readings rr
           where rr.ts > now() - interval '45 minutes' and rr.temp is not null and rr.setpoint is not null
           group by rr.room_id
          having count(*) >= 35 and max(rr.valve) = 0 and min(rr.setpoint - rr.temp) >= 1) q
    join muc_rooms ro on ro.id = q.room_id
   where ro.enabled;
  perform muc_ki_hint('ventil_oeffnet_nicht', 'Ventil öffnet nicht',
    format('Seit mindestens 45 Minuten liegt der Sollwert mindestens 1 °C über dem Ist, das Ventil bleibt aber zu: %s. '
           'Der Sollwert kommt in Loxone an, der Raumregler macht trotzdem nicht auf – der Raum belegt einen Kreis, heizt aber nicht.', v_list),
    'In der Raumkarte „Ventil auf (Test)“ drücken. Bleibt es zu: in Loxone Config Raumregler (Betriebsart, Heizen erlaubt), '
    'Ventilausgang und Stellantrieb am Heizkreisverteiler prüfen.',
    coalesce(v_n, 0) > 0, 'Ventile öffnen wieder');
  v_total := v_total + coalesce(v_n, 0);

  -- 2. Raum wird nicht warm, obwohl Ventil offen und Wärmepumpe läuft
  select avg(greatest(e.consumption_w - coalesce(e.car_w, 0) - coalesce(s.baseload_w, 350), 0))
    into v_hw from muc_energy_readings e where e.ts > now() - interval '6 hours';
  select string_agg(format('%s (%s → %s °C, Ziel %s °C)', ro.name, muc_ki_num(q.t0), muc_ki_num(q.t1), muc_ki_num(q.sp)), ', ' order by ro.sort), count(*)
    into v_list, v_n
    from (select rr.room_id,
                 (array_agg(rr.temp order by rr.ts))[1] t0,
                 (array_agg(rr.temp order by rr.ts desc))[1] t1,
                 avg(rr.setpoint) sp
            from muc_room_readings rr
           where rr.ts > now() - interval '6 hours' and rr.temp is not null
           group by rr.room_id
          having count(*) >= 300 and avg((rr.valve > 0)::int) >= 0.8) q
    join muc_rooms ro on ro.id = q.room_id
   where ro.enabled and q.t1 - q.t0 <= 0 and q.t1 < q.sp - 0.3;
  perform muc_ki_hint('raum_nicht_warm', 'Raum wird nicht wärmer, obwohl geheizt wird',
    format('Seit 6 Stunden ist das Ventil fast immer offen und die Wärmepumpe läuft (Heizstrom im Schnitt %s W), '
           'die Temperatur ist aber nicht gestiegen: %s. Die Wärme kommt in diesem Kreis nicht an.', muc_ki_num(v_hw, 0), v_list),
    'Stellantrieb und Durchfluss am Heizkreisverteiler prüfen (Ventil wirklich offen? Durchflussanzeige?), '
    'Vorlauftemperatur der Wärmepumpe prüfen, Fenster/Tür offen?',
    coalesce(v_hw, 0) >= 800 and coalesce(v_n, 0) > 0, 'Räume werden wieder wärmer');
  v_total := v_total + coalesce(v_n, 0);

  -- 3. Ventil schaltet zu oft (Fußbodenheizung: jedes Öffnen braucht Stunden, bis es wirkt)
  select string_agg(format('%s %s× auf%s', q.name, q.auf, case when q.soll < q.auf then ' (Loxone schaltet selbst)' else '' end), ', ' order by q.auf desc), count(*)
    into v_list, v_n
    from (select ro.name, ro.sort,
                 count(*) filter (where x.valve = 1 and x.pv = 0) auf,
                 count(*) filter (where x.setpoint is distinct from x.psp and x.psp is not null) soll
            from (select rr.room_id, rr.valve, rr.setpoint,
                         lag(rr.valve) over w pv, lag(rr.setpoint) over w psp
                    from muc_room_readings rr where rr.ts > now() - interval '6 hours'
                  window w as (partition by rr.room_id order by rr.ts)) x
            join muc_rooms ro on ro.id = x.room_id
           where ro.enabled
           group by ro.name, ro.sort) q
   where q.auf >= 4;
  perform muc_ki_hint('ventil_schaltet_oft', 'Ventile schalten zu oft',
    format('In den letzten 6 Stunden: %s. Bei Fußbodenheizung kommt die Wärme erst nach Stunden im Estrich an – '
           'so oft auf und zu heißt: die Wärme kommt kaum an, die Wärmepumpe taktet. Ursache ist die Steuerung, nicht der Raum.', v_list),
    format('Einstellungen › Ohne PV-Überschuss › „Spanne“ (jetzt %s °C) erhöhen; die KI schlägt das nach dem Tag vor. '
           'Steht „Loxone schaltet selbst“ dabei: Raumregler in Loxone prüfen.', muc_ki_num(s.seq_off_delta)),
    coalesce(v_n, 0) > 0, 'Ventile schalten wieder ruhig');
  v_total := v_total + coalesce(v_n, 0);
  return v_total;
end $$;

-- Öffnungen je Raum an einem Tag (Ortszeit)
create or replace function public.muc_ki_oeffnungen(p_day date)
returns table (room_id text, name text, auf int, spanne_moeglich numeric)
language sql stable security definer set search_path to 'public' as $$
  select ro.id, ro.name,
         count(*) filter (where x.valve = 1 and x.pv = 0)::int,
         ro.temp_normal - ro.temp_night
    from (select rr.room_id, rr.valve, lag(rr.valve) over (partition by rr.room_id order by rr.ts) pv
            from muc_room_readings rr
           where rr.ts >= (p_day::timestamp at time zone 'Europe/Berlin')
             and rr.ts < ((p_day + 1)::timestamp at time zone 'Europe/Berlin')) x
    join muc_rooms ro on ro.id = x.room_id
   where ro.enabled
   group by ro.id, ro.name, ro.temp_normal, ro.temp_night
$$;

create or replace function public.muc_ki_schalten(p_day date)
returns text language plpgsql security definer set search_path to 'public' as $$
declare
  v_span numeric; v_new numeric; v_oft int; v_frei int; v_list text; v_eng text; v_cnt int := 0;
  r record; vb numeric; va numeric; d0 date;
begin
  -- Erst ab dem ersten vollen Tag mit Collector 0.16/0.17 (Prio, fertig heizen, Spanne) – davor hat die alte
  -- Steuerung reihum gewechselt; ein Vorschlag aus diesen Tagen wäre falsch.
  if p_day < date '2026-11-28' then return 'Schalten: erst ab 28.11.2026'; end if;
  select seq_off_delta into v_span from muc_settings where id = 1;
  select count(*), count(*) filter (where o.spanne_moeglich > v_span),
         string_agg(format('%s %s×', o.name, o.auf), ', ' order by o.auf desc),
         string_agg(case when o.spanne_moeglich <= v_span
                         then format('%s (Normal − Min = %s °C)', o.name, muc_ki_num(o.spanne_moeglich)) end, ', ' order by o.auf desc)
    into v_oft, v_frei, v_list, v_eng
    from muc_ki_oeffnungen(p_day) o where o.auf >= 6;

  if coalesce(v_oft, 0) >= 2 then
    -- Vorschlag nur, wenn eine größere Spanne in mindestens einem Raum auch wirkt (nicht durch Min begrenzt)
    if v_frei > 0 and v_span < 3 and muc_ki_allowed('schaltet_oft', null, 7) then
      v_new := least(3, v_span + 0.5);
      insert into muc_ki_suggestions (day, kind, rule, room_id, param, old_value, new_value, title, what, why, effect, days, evidence)
      values (muc_ki_today(), 'vorschlag', 'schaltet_oft', null, 'seq_off_delta', v_span, v_new,
              'Ventile schalten zu oft: Spanne vergrößern?',
              format('Spanne %s → %s °C (nach dem Ziel erst so viel kälter wieder auf, nie unter Min)', muc_ki_num(v_span), muc_ki_num(v_new)),
              format('%s haben die Ventile oft geöffnet: %s.', muc_ki_day(p_day), v_list),
              'Weniger Schaltvorgänge: jedes Öffnen heizt länger am Stück, die Wärme kommt im Estrich an.', 1,
              jsonb_build_object('day', p_day, 'rooms', v_oft, 'list', v_list));
      v_cnt := v_cnt + 1;
    end if;
    -- Info: hier hilft die Spanne nicht, weil Min sie begrenzt – Min/Normal stellt Uli selbst ein
    if v_eng is not null and muc_ki_allowed('spanne_durch_min', null, 7) then
      insert into muc_ki_suggestions (day, kind, rule, room_id, title, what, why, effect, days, evidence)
      values (muc_ki_today(), 'info', 'spanne_durch_min', null,
              'Spanne durch Min begrenzt',
              'Keine Wertänderung durch die KI – Min und Normal stellst du selbst ein.',
              format('%s: In diesen Räumen schalten die Ventile oft, eine größere Spanne wirkt dort aber nicht, weil das Ventil spätestens bei Min wieder aufgeht: %s.',
                     muc_ki_day(p_day), v_eng),
              'Mehr Ruhe gibt es dort nur mit mehr Abstand zwischen Min und Normal (Min tiefer oder Normal höher).', 1,
              jsonb_build_object('day', p_day, 'list', v_eng));
      v_cnt := v_cnt + 1;
    end if;
  end if;

  -- Wirkungsbericht: 3 Tage nach dem Übernehmen
  for r in
    select s.* from muc_ki_suggestions s
     where s.rule = 'schaltet_oft' and s.status in ('genehmigt', 'geaendert')
       and s.check_after <= muc_ki_today() and s.effect_text is null
  loop
    d0 := (r.decided_at at time zone 'Europe/Berlin')::date;
    select avg(o.auf) into vb from generate_series(d0 - 3, d0 - 1, interval '1 day') g, muc_ki_oeffnungen(g::date) o;
    select avg(o.auf) into va from generate_series(d0 + 1, d0 + 3, interval '1 day') g, muc_ki_oeffnungen(g::date) o;
    update muc_ki_suggestions set effect_at = now(),
           effect_text = format('Öffnungen je Raum und Tag: vorher %s, nachher %s.%s', muc_ki_num(vb), muc_ki_num(va),
                                case when va < vb then ' Ventile schalten seltener.' else ' Keine Verbesserung – Ursache weiter suchen.' end)
     where id = r.id;
  end loop;
  return format('Schalten: %s Räume oft, %s Einträge', coalesce(v_oft, 0), v_cnt);
end $$;

-- muc_ki_decide: zusätzlich Hauswert seq_off_delta
create or replace function public.muc_ki_decide(p_id bigint, p_action text, p_value numeric default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
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
  v := round(case when p_action = 'ja' then s.new_value else p_value end, 1);
  if v is null then return jsonb_build_object('ok', false, 'msg', 'Kein Wert angegeben'); end if;

  -- Hauswert: Spanne (migration-021)
  if s.param = 'seq_off_delta' then
    select seq_off_delta into cur from muc_settings where id = 1 for update;
    if cur is distinct from s.old_value then
      update muc_ki_suggestions set status = 'veraltet', decided_at = now(), note = 'Wert war inzwischen anders eingestellt' where id = p_id;
      return jsonb_build_object('ok', false, 'msg', format('Die Spanne steht inzwischen auf %s °C – Vorschlag verworfen.', muc_ki_num(cur)));
    end if;
    if v < 0.5 or v > 3 then return jsonb_build_object('ok', false, 'msg', 'Die Spanne muss zwischen 0,5 und 3 °C liegen.'); end if;
    update muc_settings set seq_off_delta = v, updated_at = now() where id = 1;
    insert into muc_decisions (kind, room_id, mode, target, reason, dry_run)
    values ('ki', null, null, v, format('KI-Vorschlag übernommen: Spanne %s → %s °C. %s', muc_ki_num(cur), muc_ki_num(v), coalesce(s.why, '')), false);
    update muc_ki_suggestions
       set status = case when v = s.new_value then 'genehmigt' else 'geaendert' end,
           decided_at = now(), decided_value = v, note = nullif(p_note, ''), check_after = muc_ki_today() + 4
     where id = p_id;
    return jsonb_build_object('ok', true, 'msg', format('Spanne %s → %s °C übernommen. Der Collector nutzt sie ab dem nächsten Lauf.', muc_ki_num(cur), muc_ki_num(v)));
  end if;

  select * into ro from muc_rooms where id = s.room_id for update;
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

create or replace function public.muc_ki_tick()
returns text language plpgsql security definer set search_path to 'public' as $$
declare v_hints int; v_pred int; v_res text := null; v_sch text := null; v_today date := muc_ki_today(); v_me timestamptz;
begin
  perform muc_ki_hints_ventil();
  perform muc_ki_hints_regelung();
  v_hints := muc_ki_hints_check();
  v_pred := muc_ki_store_predictions();
  select muc_ki_at(v_today, morning_end) into v_me from muc_settings where id = 1;
  if now() >= v_me and not exists (select 1 from muc_ki_runs where day = v_today) then
    perform muc_nacht_pruefen();
    v_res := muc_ki_analyse(v_today - 1);
    v_sch := muc_ki_schalten(v_today - 1);
  end if;
  return format('Hinweise offen: %s · Vorhersagen: %s%s%s', v_hints, v_pred,
                coalesce(' · Analyse: ' || v_res, ''), coalesce(' · ' || v_sch, ''));
end $$;
