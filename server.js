/* LogIt AI backend — Express server.
 * Modes:
 *   - AI mode:     GEMINI_API_KEY set. POST /api/parse-ai extracts entries via Gemini.
 *   - Regex mode:  no key. POST /api/parse does deterministic server-side parsing.
 *                  Returns { entry, ai:false }. NEVER fakes AI output.
 * Store: append-only JSONL file at data/log.jsonl (local dev).
 *        Ephemeral on Vercel — see README. localStorage stays as offline cache.
 */
'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const net = require('net');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const APP_DIR = __dirname;
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const AI_MODE = Boolean(GEMINI_KEY);

const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3013')
  .split(',').map((s) => s.trim()).filter(Boolean);

const DATA_DIR = path.join(APP_DIR, 'data');
const STORE = path.join(DATA_DIR, 'log.jsonl');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// --- Security middleware -------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / curl / non-browser
    if (CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS origin not allowed'));
  },
}));
app.use(express.json({ limit: '10kb' }));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: 'draft-7' }));

// Sensitive-file guard: never expose secrets, stores, or server internals.
const SENSITIVE = /(\.env(\.|$)|package(-lock)?\.json|\.db$|\.sqlite3?$|(^|\/)server\.js$|\.map$|(^|\/)data\/|\.jsonl$)/i;
app.use((req, res, next) => {
  if (SENSITIVE.test(req.path)) return res.status(404).json({ error: 'Not found' });
  next();
});
app.use(express.static(APP_DIR, { dotfiles: 'deny', index: 'index.html' }));

// --- Server-side parsers ---------------------------------------------------
const DIET_KEYWORDS = [
  'vegan', 'vegetarian', 'veggie', 'veggies', 'keto', 'paleo',
  'fasting', 'fasted', 'protein', 'salad', 'junk', 'pizza', 'burger',
  'sushi', 'chicken', 'fish', 'fruit', 'fruits', 'coffee', 'alcohol',
  'beer', 'wine', 'sugar-free', 'sugar free', 'low-carb', 'low carb',
  'healthy', 'oatmeal', 'eggs', 'pasta', 'rice', 'smoothie', 'chocolate',
  'cake', 'ice cream', 'sandwich', 'tacos', 'curry', 'vegetables',
];
const FEELING_WORDS = [
  'energetic', 'tired', 'stressed', 'great', 'amazing', 'awful', 'anxious',
  'happy', 'sad', 'sick', 'sore', 'rested', 'exhausted', 'productive',
  'lazy', 'motivated', 'fantastic', 'terrible', 'okay', 'fine',
];
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parseSleep(text) {
  let m;
  m = text.match(/(?:slept|sleeping|sleep|slep)\s*(?:for\s*)?(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?)\b/i)
    || text.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:of\s*)?sleep/i)
    || text.match(/sleep\s*:\s*(\d+(?:\.\d+)?)/i)
    || text.match(/(?:slept|sleeping|sleep)\s*(?:for\s*)?(\d+(?:\.\d+)?)\b/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!Number.isFinite(v) || v <= 0 || v > 24) return null;
  return v;
}

function parseMood(text) {
  const m = text.match(/mood\s*:\s*(\d+(?:\.\d+)?)/i)
    || text.match(/mood\s*(?:is\s*)?(?:of\s*)?(\d+(?:\.\d+)?)\s*(?:\/\s*10|\s*out\s*of\s*10)?/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!Number.isFinite(v) || v < 1 || v > 10) return null;
  return v;
}

function parseWorkout(text) {
  // Distance FIRST so "ran 5k" -> 5 km and can never fall through to a minutes parse.
  const dist = text.match(/(?:ran|run|running|jog(?:ged|ging)?|walk(?:ed|ing)?|cycl(?:ed|ing)|bik(?:ed|ing)|swam|swim(?:ming)?)\s*(\d+(?:\.\d+)?)\s*(k|km|kilometers?|kilometres?|miles?|mi\b|m\b|meters?|metres?)\b/i)
    || text.match(/(\d+(?:\.\d+)?)\s*(km|kilometers?|kilometres?)\b/i);
  let distanceKm = null;
  if (dist) {
    const v = parseFloat(dist[1]);
    const u = dist[2].toLowerCase();
    if (Number.isFinite(v) && v > 0) {
      if (u === 'k' || u.startsWith('km') || u.startsWith('kilom')) distanceKm = v;
      else if (u.startsWith('mi')) distanceKm = Math.round(v * 1.60934 * 100) / 100;
      else distanceKm = Math.round((v / 1000) * 100) / 100; // m / meters
    }
  }
  const kindM = text.match(/(running|jogging|run|ran|walk(?:ed|ing)?|cycl(?:ed|ing)|bik(?:ed|ing)|swim(?:ming)?|swam|gym|yoga|workout|hiit|cardio|lift(?:ed|ing)|training|trained|exercise)/i);
  const kind = kindM ? kindM[1].toLowerCase().replace(/^(ran|run)$/, 'run') : (distanceKm != null ? 'run' : null);

  // Duration (minutes). Unit is REQUIRED so a bare "5k" can never become "5m".
  let minutes = null;
  const dur = text.match(/(?:workout|gym|training|trained|exercise(?:d)?|yoga|hiit|cardio)\D{0,25}?(\d+(?:\.\d+)?)\s*(hours?|hrs?|h\b|minutes?|mins?|min\b)\b/i)
    || text.match(/(\d+(?:\.\d+)?)\s*(hours?|hrs?)\s*(?:of\s*)?(?:workout|gym|training|exercise|yoga)/i)
    || text.match(/(\d+(?:\.\d+)?)\s*min(?:s|utes?)?\b/i);
  if (dur) {
    const v = parseFloat(dur[1]);
    const u = dur[2].toLowerCase();
    if (Number.isFinite(v) && v > 0 && v <= 1440) {
      minutes = (u.startsWith('h')) ? Math.round(v * 60) : v;
    }
  }
  if (distanceKm == null && minutes == null) return null;
  return { minutes, distance_km: distanceKm, kind };
}

function parseWater(text) {
  const m = text.match(/water\s*:\s*(\d+(?:\.\d+)?)/i)
    || text.match(/(\d+(?:\.\d+)?)\s*(ml|l|liters?|litres?|fl\s*oz|oz|glasses?|cups?)\s*(?:of\s*)?water/i)
    || text.match(/water\D{0,15}?(\d+(?:\.\d+)?)\s*(ml|l|liters?|litres?|oz|glasses?|cups?)\b/i)
    || text.match(/drank\s*(\d+(?:\.\d+)?)\s*(ml|l|liters?|litres?|oz|glasses?|cups?)\b/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!Number.isFinite(v) || v <= 0) return null;
  const u = (m[2] || 'ml').toLowerCase();
  if (u === 'l' || u.startsWith('lit')) return Math.round(v * 1000);
  if (u.includes('oz')) return Math.round(v * 29.5735);
  if (u.startsWith('glass') || u.startsWith('cup')) return Math.round(v * 250);
  if (v > 20 && u === 'ml') return Math.round(v); // assume ml for large bare numbers is wrong; handled by unit anyway
  return Math.round(v);
}

function parseDiet(text) {
  const low = ` ${text.toLowerCase()} `;
  const found = [];
  for (const kw of DIET_KEYWORDS) {
    const re = new RegExp(`(?<!\\w)${escRe(kw)}(?!\\w)`, 'i');
    if (re.test(low) && !found.includes(kw.toLowerCase())) found.push(kw.toLowerCase());
  }
  return found;
}

function parseTags(text, diet) {
  const tags = new Set();
  for (const m of text.matchAll(/#(\w+)/g)) tags.add(m[1].toLowerCase());
  const low = text.toLowerCase();
  for (const w of FEELING_WORDS) {
    if (new RegExp(`(?<!\\w)${escRe(w)}(?!\\w)`).test(low)) tags.add(w);
  }
  for (const d of diet) tags.add(d);
  return [...tags].slice(0, 20);
}

function parseEntry(text) {
  const raw = String(text).trim();
  const sleepHours = parseSleep(raw);
  const mood = parseMood(raw);
  const workout = parseWorkout(raw);
  const waterMl = parseWater(raw);
  const diet = parseDiet(raw);
  const tags = parseTags(raw, diet);
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    date,
    sleep_hours: sleepHours,
    mood,
    workout,
    water_ml: waterMl,
    diet,
    tags,
    raw,
    created_at: new Date().toISOString(),
  };
}

function entryHasSignal(e) {
  return e.sleep_hours != null || e.mood != null || e.workout != null
    || e.water_ml != null || (Array.isArray(e.diet) && e.diet.length > 0);
}

// --- JSONL store -------------------------------------------------------------
function readEntries() {
  try {
    if (!fs.existsSync(STORE)) return [];
    const lines = fs.readFileSync(STORE, 'utf8').split('\n').filter((l) => l.trim());
    const out = [];
    for (const l of lines) {
      try { const e = JSON.parse(l); if (e && typeof e === 'object') out.push(e); } catch { /* skip corrupt line */ }
    }
    return out;
  } catch { return []; }
}

function appendEntry(entry) {
  fs.appendFileSync(STORE, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

// --- Stats ---------------------------------------------------------------------
function isoDay(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return d.toISOString().slice(0, 10);
}

function computeStats(days) {
  const all = readEntries();
  const cutoff = isoDay(days - 1);
  const inRange = all.filter((e) => typeof e.date === 'string' && e.date >= cutoff);
  const avg = (vals) => {
    const v = vals.filter((n) => typeof n === 'number' && Number.isFinite(n));
    if (!v.length) return null;
    return Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100;
  };
  // Streak: consecutive days with >=1 entry, ending today (1-day grace: may start yesterday).
  const daySet = new Set(inRange.map((e) => e.date));
  let streak = 0;
  let cursor = daySet.has(isoDay(0)) ? 0 : 1;
  if (daySet.has(isoDay(0)) || daySet.has(isoDay(1))) {
    while (daySet.has(isoDay(cursor))) { streak += 1; cursor += 1; }
  }
  return {
    days,
    count: inRange.length,
    avg_sleep_hours: avg(inRange.map((e) => e.sleep_hours)),
    avg_mood: avg(inRange.map((e) => e.mood)),
    avg_water_ml: avg(inRange.map((e) => e.water_ml)),
    total_water_ml: inRange.reduce((a, e) => a + (typeof e.water_ml === 'number' ? e.water_ml : 0), 0),
    workouts: inRange.filter((e) => e.workout != null).length,
    streak_days: streak,
    ai: false,
    simulated: false,
  };
}

// --- Gemini ----------------------------------------------------------------------
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite'];

const AI_PROMPT = (text) => (
  'You parse personal habit-log sentences into structured JSON. '
  + 'Return ONLY a JSON object (no markdown, no prose) with exactly these keys:\n'
  + '{"sleep_hours": number|null (0-24), "mood": number|null (1-10), '
  + '"workout": null or {"minutes": number|null, "distance_km": number|null, "kind": string|null}, '
  + '"water_ml": number|null, "diet": string[], "tags": string[]}\n'
  + 'Rules: "ran 5k" means distance_km 5, NOT minutes 5. Convert miles to km, L/glasses/cups/oz to ml. '
  + 'Use null (not 0) for anything not mentioned. Keep diet/tags lowercase, max 20 tags.\n\n'
  + `TEXT: ${text}`
);

function extractJsonObject(raw) {
  const s = String(raw || '').replace(/```json|```/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function sanitizeAi(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const numOrNull = (v, lo, hi) => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    if ((lo != null && n < lo) || (hi != null && n > hi)) return null;
    return n;
  };
  const strArr = (v) => Array.isArray(v)
    ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().toLowerCase()).slice(0, 20)
    : [];
  let workout = null;
  const w = obj.workout;
  if (w && typeof w === 'object') {
    const minutes = numOrNull(w.minutes, 0.1, 1440);
    const distanceKm = numOrNull(w.distance_km ?? w.distanceKm, 0.01, 1000);
    const kind = typeof w.kind === 'string' && w.kind.trim() ? w.kind.trim().toLowerCase().slice(0, 30) : null;
    if (minutes != null || distanceKm != null) workout = { minutes, distance_km: distanceKm, kind };
  } else if (typeof w === 'string' && w.trim()) {
    workout = parseWorkout(w); // lenient: model returned prose instead of object
  }
  return {
    sleep_hours: numOrNull(obj.sleep_hours ?? obj.sleep, 0.1, 24),
    mood: numOrNull(obj.mood, 1, 10),
    workout,
    water_ml: numOrNull(obj.water_ml ?? obj.waterMl, 1, 20000) != null
      ? Math.round(numOrNull(obj.water_ml ?? obj.waterMl, 1, 20000)) : null,
    diet: strArr(obj.diet),
    tags: strArr(obj.tags),
  };
}

async function callGemini(text) {
  let lastErr = null;
  for (const model of GEMINI_MODELS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: AI_PROMPT(text) }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 800 },
          }),
          signal: ctrl.signal,
        }
      );
      clearTimeout(t);
      if (!r.ok) {
        lastErr = new Error(`Gemini ${model} HTTP ${r.status}`);
        if (r.status === 400) break; // bad request/key — another model won't help
        continue;
      }
      const j = await r.json();
      const parts = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
      const outText = Array.isArray(parts) ? parts.map((p) => p.text || '').join('') : '';
      const clean = sanitizeAi(extractJsonObject(outText));
      if (!clean) { lastErr = new Error(`Gemini ${model} returned unparseable JSON`); continue; }
      return clean;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Gemini request failed');
}

// --- API -------------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mode: AI_MODE ? 'ai' : 'regex', ai: AI_MODE, simulated: false, count: readEntries().length });
});

app.post('/api/parse', (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Missing "text" string in request body.' });
  }
  if (text.length > 2000) {
    return res.status(400).json({ error: 'Text exceeds 2000 character limit.' });
  }
  const entry = parseEntry(text);
  if (!entryHasSignal(entry)) {
    return res.status(422).json({
      error: "No metrics found. Mention e.g. 'slept 7 hours', 'mood 8/10', 'ran 5k', or 'drank 500ml water'.",
      ai: false, simulated: false, entry,
    });
  }
  appendEntry(entry);
  return res.json({ entry, ai: false, simulated: false, persisted: true });
});

app.post('/api/parse-ai', async (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Missing "text" string in request body.' });
  }
  if (text.length > 2000) {
    return res.status(400).json({ error: 'Text exceeds 2000 character limit.' });
  }
  if (!GEMINI_KEY) {
    return res.status(503).json({
      error: 'AI parsing unavailable — GEMINI_API_KEY is not configured. Use POST /api/parse (regex) instead.',
      ai: false, simulated: false,
    });
  }
  try {
    const clean = await callGemini(text.trim());
    const entry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      date: new Date().toISOString().slice(0, 10),
      ...clean,
      raw: text.trim(),
      created_at: new Date().toISOString(),
    };
    if (!entryHasSignal(entry)) {
      return res.status(422).json({
        error: 'AI found no loggable metrics in that text.',
        ai: true, simulated: false, entry,
      });
    }
    appendEntry(entry);
    return res.json({ entry, ai: true, simulated: false, persisted: true, provider: 'gemini' });
  } catch (e) {
    return res.status(502).json({
      error: `AI parsing failed (${(e && e.message) || e}). Nothing was faked — retry or use POST /api/parse.`,
      ai: false, simulated: false,
    });
  }
});

app.get('/api/stats', (req, res) => {
  let days = parseInt(req.query.days, 10);
  if (!Number.isFinite(days) || days < 1) days = 7;
  if (days > 365) days = 365;
  res.json(computeStats(days));
});

app.get('/api/logs', (req, res) => {
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 100;
  if (limit > 1000) limit = 1000;
  const all = readEntries();
  res.json({ count: all.length, entries: all.slice(-limit), ai: false, simulated: false });
});

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

app.get('/api/export.csv', (_req, res) => {
  const all = readEntries();
  const header = 'date,sleep_hours,mood,workout_minutes,workout_distance_km,workout_kind,water_ml,diet,tags,raw';
  const rows = all.map((e) => [
    e.date ?? '',
    e.sleep_hours ?? '',
    e.mood ?? '',
    (e.workout && e.workout.minutes) ?? '',
    (e.workout && e.workout.distance_km) ?? '',
    (e.workout && e.workout.kind) ?? '',
    e.water_ml ?? '',
    Array.isArray(e.diet) ? e.diet.join('|') : '',
    Array.isArray(e.tags) ? e.tags.join('|') : '',
    e.raw ?? '',
  ].map(csvCell).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="logit-export.csv"');
  res.send([header, ...rows].join('\n'));
});

app.delete('/api/logs', (_req, res) => {
  try { fs.writeFileSync(STORE, '', 'utf8'); } catch { /* ignore */ }
  res.json({ ok: true, count: 0 });
});

// --- Boot: PORT or first free 30xx ----------------------------------------
function listenOn(port) {
  if (port > 3099) { console.error('No free port in 3013-3099.'); process.exit(1); }
  const server = net.createServer();
  server.once('error', () => listenOn(port + 1));
  server.once('listening', () => {
    server.close(() => {
      app.listen(port, () => {
        console.log(`[logit] listening on http://localhost:${port}`);
        console.log(`[logit] mode: ${AI_MODE ? 'AI (provider: gemini) + regex' : 'REGEX (no GEMINI_API_KEY set — /api/parse-ai returns 503, add a key for AI parsing)'}`);
        console.log(`[logit] store: ${STORE}`);
        console.log(`[logit] CORS origins: ${CORS_ORIGINS.join(', ')}`);
      });
    });
  });
  server.listen(port);
}
module.exports = app;

// Guarded so `require('./server')` (e.g. serverless) does not start a listener.
// Direct `node server.js` behavior is unchanged.
if (require.main === module) {
  listenOn(Number(process.env.PORT) || 3013);
}
