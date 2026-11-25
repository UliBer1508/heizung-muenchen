-- migration-020 · Heizsignal für das Raummodell München (25.11.2026)
-- Uli: „In München haben wir die WP und Wasserleitungen im Boden, in Venediger Heizmatten im Estrich. Das sollte einen
-- Unterschied bei der Aufheizung und Wärmehaltung ausmachen.“
-- Befund (Lernlauf 25.11.): fast alle Räume hängen an den Parametergrenzen (g = 0,05, u = 2, r = 0,5) – das Modell hat
-- gelernt, dass Heizen fast nichts bewirkt. Ursache: „heizt“ war nur „Ventil offen“. Wärme kommt aber nur, wenn die
-- Wärmepumpe läuft (eigenes Zeitprogramm, Warmwasser, Ausfälle). In den 7 Tagen bis 25.11. lieferte die WP in 30–40 %
-- der Ventil-offen-Zeit keine Wärme.
-- Neu: h = Ventil offen UND Heizstrom > 800 W (Verbrauch − Auto − Grundlast, wie KI-Hinweis „Wärmepumpe liefert keine
-- Wärme“ und Raummodell migration-007). Minuten ohne Energiewert zählen wie bisher nach dem Ventil.
-- Rückblick für den Estrich-Zustand 24 statt 12 h (mehr Masse, Rohre unten im Estrich) – samples15 reicht deshalb
-- 24 h vor den Lernzeitraum; die Edge Function rechnet 96 statt 48 Viertelstunden zurück (rechnen.ts, HIST_SLOTS).
-- Venediger bleibt unverändert (Heizmatten: Strom an = Wärme).
-- Umsetzung: nur der Abschnitt samples15 in muc_heizplaner_daten wird ersetzt, der Rest der Funktion bleibt wie er ist.
do $mig$
declare
  v_def text := pg_get_functiondef('public.muc_heizplaner_daten(int)'::regprocedure);
  v_alt text := $a$        select room_id, jsonb_agg(jsonb_build_array(b, t, h) order by b) arr from (
          select room_id, (floor(extract(epoch from ts) / 900) * 900)::bigint b,
                 round(avg(temp)::numeric, 2) t, round(avg(case when valve > 0 then 1 else 0 end)::numeric, 2) h
          from muc_room_readings, von where ts > von.t - interval '12 hours' and temp is not null group by 1, 2) s group by room_id) z),$a$;
  v_neu text := $n$        select room_id, jsonb_agg(jsonb_build_array(b, t, h) order by b) arr from (
          -- 020: h = Ventil offen UND Wärmepumpe liefert (Heizstrom > 800 W); 24 h Vorlauf für den Estrich-Zustand
          select r.room_id, (floor(extract(epoch from r.ts) / 900) * 900)::bigint b,
                 round(avg(r.temp)::numeric, 2) t,
                 round(avg(case when r.valve > 0 and coalesce(hw.w > 800, true) then 1 else 0 end)::numeric, 2) h
          from muc_room_readings r
          cross join von
          left join (
            select date_trunc('minute', e.ts) m,
                   avg(greatest(e.consumption_w - coalesce(e.car_w, 0) - coalesce((select baseload_w from st), 350), 0)) w
            from muc_energy_readings e, von v2 where e.ts > v2.t - interval '24 hours' group by 1
          ) hw on hw.m = date_trunc('minute', r.ts)
          where r.ts > von.t - interval '24 hours' and r.temp is not null group by 1, 2) s group by room_id) z),$n$;
begin
  if position(v_alt in v_def) = 0 then
    if position('020: h = Ventil offen UND' in v_def) > 0 then raise notice '020 ist schon eingespielt'; return; end if;
    raise exception 'samples15 in muc_heizplaner_daten hat sich geändert – migration-020 bitte anpassen';
  end if;
  execute replace(v_def, v_alt, v_neu);
end
$mig$;

-- Prüfung: select jsonb_array_length(muc_heizplaner_daten(2)->'samples15'->'eg_buero');   -- ~ (2 Tage + 24 h) × 96
