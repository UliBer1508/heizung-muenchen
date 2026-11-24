// Meine Heizung – MCP-Server für Alexa+ (München und Venediger). Logik: server.ts, Anleitung: doc/ALEXA-PLUS.md
// Bereitstellen ohne Supabase-JWT-Prüfung:  supabase functions deploy mcp-heizung --no-verify-jwt
import { route } from './server.ts';

Deno.serve(route);
