// Tool-Liste des MCP-Servers „Meine Heizung“. Alexa+ wählt anhand der Beschreibungen aus.
// Jedes Tool liefert einen fertigen deutschen Satz (beginnt mit dem Haus) und strukturierte Daten.
// Die Zahlen kommen immer aus der Datenbank – das Sprachmodell rechnet und entscheidet nichts.

import * as H from './heizung.ts';

const HAUS = {
  type: 'string',
  enum: ['muenchen', 'venediger', 'beide'],
  description:
    'Welches Haus. Nennt der Nutzer keins, aber ist bekannt, wo das Echo steht (Adresse in Österreich bzw. Neukirchen am Großvenediger → venediger, in München → muenchen), dieses Haus setzen. Sonst weglassen – dann sucht der Server selbst.',
};
const RAUM = { type: 'string', description: 'Raum, wie der Nutzer ihn nennt, z. B. „Uli Bad“, „Bad im Keller“, „Wohnzimmer“. Wortstellung egal.' };

type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  run: (a: Record<string, any>) => Promise<H.Result>;
};

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const obj = (properties: Record<string, unknown> = {}, required: string[] = []) =>
  ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });

export const TOOLS: Tool[] = [
  // ---------------------------------------------------------------- Lesen
  {
    name: 'haeuser_und_raeume',
    title: 'Häuser und Räume',
    description: 'Listet beide Häuser (München, Venediger) mit allen Räumen, aktueller Ist- und Solltemperatur, erlaubten Grenzen und manuellen Einstellungen. Nutzen, wenn unklar ist, welcher Raum gemeint ist, oder für einen Überblick über alle Räume.',
    inputSchema: obj(),
    annotations: READ,
    run: () => H.haeuserUndRaeume(),
  },
  {
    name: 'status',
    title: 'Status der Heizung',
    description: 'Zustand der Heizung: München – Hausmodus, Automatik, Testmodus, manuell gestellte Räume, Collector-Störung, KI-Hinweise. Venediger – bewohnt oder abwesend, Tagesmodus, welche Räume heizen, manuelle Räume.',
    inputSchema: obj({ haus: HAUS }),
    annotations: READ,
    run: (a) => H.status(a.haus),
  },
  {
    name: 'raum',
    title: 'Temperatur in einem Raum',
    description: 'Ist- und Solltemperatur eines Raums, ob gerade geheizt wird, ob er manuell gestellt ist. München zusätzlich Ventil und Prognose für morgen früh ohne Heizen. Gibt es den Raum in beiden Häusern und ist kein Haus bekannt, kommen beide.',
    inputSchema: obj({ raum: RAUM, haus: HAUS }, ['raum']),
    annotations: READ,
    run: (a) => H.raum(a.raum, a.haus),
  },
  {
    name: 'energie',
    title: 'Sonnenstrom, Akku und Eigenverbrauch',
    description: 'PV-Leistung, Akkustand und Netzbezug jetzt; heute Sonnenstrom-Summe, Eigenverbrauchsquote, Autarkie; München zusätzlich Heizstrom der Wärmepumpe aus dem Netz. Für Fragen wie „lohnt es sich gerade zu heizen“ zusammen mit status nutzen.',
    inputSchema: obj({ haus: HAUS }),
    annotations: READ,
    run: (a) => H.energie(a.haus),
  },
  {
    name: 'hinweise',
    title: 'KI-Hinweise München',
    description: 'Offene Warnungen der KI in München (z. B. Wärmepumpe liefert keine Wärme, Collector meldet sich nicht) und Vorschläge, die in der App auf eine Entscheidung warten. Nur vorlesen – entschieden wird in der App.',
    inputSchema: obj(),
    annotations: READ,
    run: () => H.hinweise(),
  },
  {
    name: 'tagesrueckblick',
    title: 'Tagesrückblick München',
    description: 'Rückblick der täglichen KI-Analyse München auf den Vortag: Außentemperatur, Sonne, Einspeisung, Heizstrom, Räume unter Soll, Nachtheizung. Für Fragen wie „Warum war es heute früh im OG kalt?“.',
    inputSchema: obj({ datum: { type: 'string', description: 'Tag der Analyse als JJJJ-MM-TT (enthält den Rückblick auf den Vortag). Weglassen = neueste.' } }),
    annotations: READ,
    run: (a) => H.tagesrueckblick(a.datum),
  },
  {
    name: 'anwesenheit_venediger',
    title: 'Anwesenheit Venediger',
    description: 'Ob das Haus in Venediger als bewohnt oder abwesend gilt, bis wann, und die nächste geplante Abwesenheit. Grundzustand ist bewohnt; im Kalender stehen nur Abwesenheiten.',
    inputSchema: obj(),
    annotations: READ,
    run: () => H.anwesenheit(),
  },

  // ---------------------------------------------------------------- Schreiben
  {
    name: 'raum_stellen',
    title: 'Raum vorübergehend stellen',
    description: 'Stellt einen Raum für eine begrenzte Zeit auf eine Temperatur (Übersteuerung). Danach regelt wieder die Automatik. Standard 2 Stunden, höchstens 12 Stunden. Ohne Temperatur: „warm machen“ = PV-Temperatur (München) bzw. Komfort (Venediger). Grenzen je Raum prüft der Server und meldet, wenn er begrenzt hat. Gibt es den Raum in beiden Häusern und ist kein Haus bekannt, fragt der Server nach.',
    inputSchema: obj({
      raum: RAUM,
      haus: HAUS,
      temperatur: { type: 'number', description: 'Zieltemperatur in Grad Celsius (halbe Grad).' },
      stufe: { type: 'string', enum: ['warm', 'normal', 'eco'], description: 'Statt einer Zahl: warm (Standard), normal (München Normalwert), eco (Venediger Eco).' },
      dauer_minuten: { type: 'number', description: 'Wie lange. Standard 120, höchstens 720.' },
      bis: { type: 'string', description: 'Alternativ zur Dauer: Ende als Uhrzeit „HH:MM“ oder „JJJJ-MM-TTTHH:MM“ (Ortszeit).' },
    }, ['raum']),
    annotations: WRITE,
    run: (a) => H.raumStellen(a),
  },
  {
    name: 'raum_automatisch',
    title: 'Raum wieder automatisch',
    description: 'Beendet die manuelle Einstellung eines Raums; die Automatik übernimmt wieder.',
    inputSchema: obj({ raum: RAUM, haus: HAUS }, ['raum']),
    annotations: WRITE,
    run: (a) => H.raumAutomatisch(a.raum, a.haus),
  },
  {
    name: 'alle_automatisch',
    title: 'Alle Räume wieder automatisch',
    description: 'Beendet alle manuellen Einstellungen in einem Haus oder in beiden. Bei „beide“ erst den Nutzer fragen und dann mit bestaetigt=true aufrufen.',
    inputSchema: obj({ haus: { ...HAUS, description: 'muenchen, venediger oder beide. Pflicht.' }, bestaetigt: { type: 'boolean', description: 'true, nachdem der Nutzer „beide Häuser“ bestätigt hat.' } }, ['haus']),
    annotations: WRITE,
    run: (a) => H.alleAutomatisch(a.haus, a.bestaetigt),
  },
  {
    name: 'automatik_muenchen',
    title: 'Automatik München an/aus',
    description: 'Hauptschalter der Heizungsautomatik in München (Venediger hat keinen). Ohne an: nur abfragen. Ausschalten erst nach Rückfrage beim Nutzer mit bestaetigt=true.',
    inputSchema: obj({ an: { type: 'boolean', description: 'true = einschalten, false = ausschalten. Weglassen = nur abfragen.' }, bestaetigt: { type: 'boolean', description: 'true, nachdem der Nutzer das Ausschalten bestätigt hat.' } }),
    annotations: WRITE,
    run: (a) => H.automatikMuenchen(a.an, a.bestaetigt),
  },
  {
    name: 'abwesenheit_venediger',
    title: 'Abwesenheit Venediger eintragen',
    description: 'Trägt in Venediger eine Abwesenheit ein („wir fahren weg bis Sonntag“, „wir sind ab Freitag eine Woche nicht da“). Während der Abwesenheit wird sparsam und mit Sonnenstrom geheizt; vor der Rückkehr wird automatisch vorgeheizt. Ohne bis: eine Woche bis zur Standard-Rückkehrzeit.',
    inputSchema: obj({
      von: { type: 'string', description: 'Beginn „JJJJ-MM-TT“ oder „JJJJ-MM-TTTHH:MM“ (Ortszeit). Weglassen = ab jetzt. Nur Datum = Standard-Abreisezeit.' },
      bis: { type: 'string', description: 'Rückkehr „JJJJ-MM-TT“ oder „JJJJ-MM-TTTHH:MM“ (Ortszeit). Nur Datum = Standard-Rückkehrzeit (14 Uhr).' },
    }),
    annotations: { ...WRITE, idempotentHint: false },
    run: (a) => H.abwesenheitEintragen(a.von, a.bis),
  },
  {
    name: 'zurueck_in_venediger',
    title: 'Zurück in Venediger',
    description: 'Beendet die laufende Abwesenheit in Venediger sofort („wir sind wieder da“, „ich bin zurück“). Künftige geplante Abwesenheiten bleiben.',
    inputSchema: obj(),
    annotations: WRITE,
    run: () => H.zurueck(),
  },
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
export const toolList = () => TOOLS.map(({ run: _r, ...t }) => t);
