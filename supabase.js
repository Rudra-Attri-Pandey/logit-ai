/* Minimal Supabase PostgREST client — zero deps, global fetch.
 * Reads SUPABASE_URL (falls back to NEXT_PUBLIC_SUPABASE_URL) and
 * SUPABASE_SERVICE_ROLE_KEY from the environment at call time. Every request
 * sends the key as both `apikey` and `Bearer`; writes ask for
 * `Prefer: return=representation`. Callers gate on sbConfigured() to pick
 * PostgREST as source of truth vs the local JSONL file store (dev mode).
 */
'use strict';

const FILTER_OPS = new Set([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'match', 'imatch',
  'is', 'isdistinct', 'in', 'cs', 'cd', 'ov', 'not',
]);

function restBase() {
  return String(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '')
    .trim().replace(/\/+$/, '');
}

function restKey() {
  return String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
}

function sbConfigured() {
  return Boolean(restBase() && restKey());
}

function buildUrl(table, params = {}) {
  const url = new URL(`${restBase()}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

function buildHeaders(extra = {}) {
  const key = restKey();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

// Filter values: "op.value" with a known PostgREST op passes through raw
// (e.g. "gte.2026-10-25"); anything else becomes "eq.<value>".
function filterParams(filter = {}) {
  const out = {};
  for (const [col, val] of Object.entries(filter)) {
    if (val == null) continue;
    const s = String(val);
    const dot = s.indexOf('.');
    out[col] = (dot > 0 && FILTER_OPS.has(s.slice(0, dot))) ? s : `eq.${s}`;
  }
  return out;
}

async function request(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  const range = res.headers.get('content-range') || '';
  const m = range.match(/\/(\d+)$/);
  const total = m ? Number(m[1]) : null;
  if (!res.ok) {
    const msg = (body && body.message) || (typeof body === 'string' && body) || `HTTP ${res.status}`;
    const err = new Error(`Supabase REST ${res.status} (${url.split('?')[0]}): ${msg}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return { body, total };
}

async function sbInsert(table, row) {
  const { body } = await request(buildUrl(table), {
    method: 'POST',
    headers: buildHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  });
  return body;
}

// sbList(table, { filter, order, limit, ascending }) -> rows[] (ascending defaults to false = desc)
async function sbList(table, { filter, order, limit, ascending = false } = {}) {
  const params = filterParams(filter);
  if (order) params.order = `${order}.${ascending ? 'asc' : 'desc'}`;
  if (limit != null) params.limit = String(limit);
  const { body } = await request(buildUrl(table, params), { method: 'GET', headers: buildHeaders() });
  return Array.isArray(body) ? body : [];
}

// Exact row count via PostgREST count=exact (Content-Range total), cheap query.
async function sbCount(table, filter) {
  const params = { ...filterParams(filter), limit: 1 };
  const { total } = await request(buildUrl(table, params), {
    method: 'GET',
    headers: buildHeaders({ Prefer: 'count=exact' }),
  });
  return total;
}

async function sbGet(table, id, idCol = 'id') {
  const rows = await sbList(table, { filter: { [idCol]: id }, limit: 1 });
  return rows[0] || null;
}

async function sbUpdate(table, id, patch, idCol = 'id') {
  const { body } = await request(buildUrl(table, { [idCol]: `eq.${id}` }), {
    method: 'PATCH',
    headers: buildHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(patch),
  });
  return body;
}

async function sbDelete(table, filter = {}) {
  const { body } = await request(buildUrl(table, filterParams(filter)), {
    method: 'DELETE',
    headers: buildHeaders({ Prefer: 'return=representation' }),
  });
  return Array.isArray(body) ? body : [];
}

module.exports = { sbInsert, sbList, sbGet, sbUpdate, sbDelete, sbCount, sbConfigured };
