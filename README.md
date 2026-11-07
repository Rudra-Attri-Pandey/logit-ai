# LogIt AI — Chat to Log Your Life

Chat-style habit / sleep / mood logger with a real Express backend.

## Run

```bash
npm install
cp .env.example .env   # optional; server runs keyless in regex mode
                       # set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to persist to Supabase
npm start              # http://localhost:3013 (or first free 30xx port)
```

Open `http://localhost:3013` in a browser. No build step.

## API

| Endpoint | Description |
|---|---|
| `POST /api/parse {text}` | Server-side regex parse → `{entry, ai:false}`. Persists to Supabase (`logit_entries`) when configured, else `data/log.jsonl` (dev). `400` on empty/oversize, `422` when no metrics found. |
| `POST /api/parse-ai {text}` | Gemini extraction (same entry schema, `{ai:true}`). `503` with no `GEMINI_API_KEY`, `502` on model failure — never faked. |
| `GET /api/stats?days=7` | Counts + averages (nulls skipped) + `streak_days` from the store (Supabase when configured, else JSONL). |
| `GET /api/logs?limit=100` | Latest N entries, newest first. |
| `GET /api/export.csv` | Real CSV download of the store. |
| `DELETE /api/logs` | Clears the store. |
| `GET /api/health` | `{ok, mode: "ai"\|"regex", ai, simulated:false, count}`. |

Entry schema:

```json
{
  "id": "…", "date": "2026-09-30",
  "sleep_hours": 6.5, "mood": 7,
  "workout": { "minutes": null, "distance_km": 5, "kind": "run" },
  "water_ml": 500, "diet": ["vegan"], "tags": ["tired"],
  "raw": "slept 6.5h, mood 7, ran 5k", "created_at": "…"
}
```

Parser notes: `ran 5k` → `distance_km: 5` (never 5 minutes); `slept`/`sleeping`/`sleep` forms all match; miles convert to km; `L`/`glasses`/`cups`/`oz` convert to ml; diet keywords (vegan, keto, pizza, …) extracted.

## Honest capability list

- **Real (server):** regex parsing (`/api/parse`), persistence to **Supabase PostgREST** (`logit_entries`) when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set — else local JSONL file in dev mode, stats/streaks, CSV export, rate-limit + helmet + CORS, sensitive-file guard (`/server.js`, `/supabase.js`, `.env`, `data/` → 404).
- **Real when keyed:** Gemini free-form extraction (`/api/parse-ai`, models `gemini-3.8-flash` → `gemini-3.5-flash-lite`). Keyless = honest `503`, never simulated.
- **Real (browser):** Web Speech API mic (Chrome/Edge); elsewhere shows "not supported" instead of faking. Canvas chart, XSS-escaped renders, localStorage offline cache with server fallback.
- **Not built:** auth / multi-user accounts (the service-role key is server-side only), Whisper transcription (browser speech-to-text only, no audio upload endpoint). The JSONL fallback store is **ephemeral on Vercel** — set the Supabase env vars for production deploys.

## Architecture (as built)

```
browser (chat + chart) --fetch--> Express (server.js)
                                       |-- regex parser  -> Supabase (logit_entries) when configured
                                       |-- Gemini (keyed) -> Supabase (logit_entries) when configured
                                       |                  -> data/log.jsonl (dev fallback, ephemeral on Vercel)
localStorage = offline cache only
```
