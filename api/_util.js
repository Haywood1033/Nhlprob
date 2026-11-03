// api/_util.js — shared request helpers for the route handlers (Vercel ignores _-prefixed files
// as routes). Keeps every handler to: parse params, call lib/, send JSON.

function param(req, name, fallback = null) {
  const v = req.query?.[name];
  return v === undefined || v === '' ? fallback : Array.isArray(v) ? v[0] : v;
}

function numParam(req, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(param(req, name, fallback));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function body(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch { return {}; } }
  return req.body;
}

function send(res, status, payload, cacheSeconds = 0) {
  res.setHeader('Cache-Control', cacheSeconds ? `s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 2}` : 'no-store');
  res.status(status).json(payload);
}

function fail(res, err) {
  console.error(err);
  send(res, err.status || 500, { error: err.message || 'Unexpected error' });
}

module.exports = { param, numParam, body, send, fail };
