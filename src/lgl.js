// LGL REST client with client-side rate limiting.
//
// LGL allows 300 calls per rolling 5 minutes, ACCOUNT-WIDE. This process can only
// count its own calls — the contact logger, the local Claude Desktop server, and any
// other integration spend from the same budget. So we keep headroom (default 270)
// and back off on 429s. The budget snapshot is attached to every error so an agent
// can pace itself.
import fetch from "node-fetch";

const API_BASE = process.env.LGL_API_BASE || "https://api.littlegreenlight.com/api/v1";
const WINDOW_MS = 5 * 60 * 1000;
const LIMIT = Number(process.env.LGL_RATE_LIMIT || 270);   // LGL's hard limit is 300
const MAX_RETRIES = 3;

const stamps = []; // timestamps of calls made in the current window

function prune(now = Date.now()) {
  while (stamps.length && now - stamps[0] >= WINDOW_MS) stamps.shift();
}

export function budget() {
  prune();
  const now = Date.now();
  const remaining = Math.max(0, LIMIT - stamps.length);
  const resetsInSec = stamps.length ? Math.ceil((WINDOW_MS - (now - stamps[0])) / 1000) : 0;
  return { used: stamps.length, remaining, limit: LIMIT, window_sec: WINDOW_MS / 1000, next_slot_in_sec: remaining > 0 ? 0 : resetsInSec };
}

export function budgetText() {
  const b = budget();
  return `LGL budget (this server's count): ${b.remaining}/${b.limit} calls left in the rolling 5-min window` +
    (b.remaining === 0 ? `, next call possible in ~${b.next_slot_in_sec}s` : "") +
    `. The 300/5-min limit is account-wide, so other LGL integrations also draw on it.`;
}

// How long until a call can be made (ms). 0 = now.
export function waitNeededMs() {
  prune();
  if (stamps.length < LIMIT) return 0;
  return WINDOW_MS - (Date.now() - stamps[0]) + 50;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LglError extends Error {
  constructor(status, body, method, path) {
    const detail = typeof body === "string" ? body.slice(0, 500) : JSON.stringify(body).slice(0, 800);
    super(`LGL API error ${status} on ${method} ${path}: ${detail}. ${budgetText()}`);
    this.status = status;
    this.body = body;
  }
}

// Build a query string. `q` is an array of "key=value" strings, sent as repeated q[]=.
// LGL only honours search filters when they are q[] entries — plain ?key=value is ignored.
export function buildQuery({ q = [], ...params } = {}) {
  const sp = new URLSearchParams();
  for (const x of q) if (x != null && x !== "") sp.append("q[]", String(x));
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") sp.append(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/**
 * Call LGL. `query` may include `q` (array) plus plain params.
 * maxWaitMs: how long we're willing to sleep for budget before throwing (default 20s,
 * so an MCP tool call doesn't hang past the client's timeout).
 */
export async function lgl(method, path, query = {}, body = null, { maxWaitMs = 20000 } = {}) {
  const url = `${API_BASE}${path}${buildQuery(query)}`;
  const key = process.env.LGL_API_KEY;
  if (!key) throw new Error("LGL_API_KEY is not configured on the server.");

  for (let attempt = 0; ; attempt++) {
    const wait = waitNeededMs();
    if (wait > maxWaitMs) {
      const e = new LglError(429, `client-side throttle: would need to wait ${Math.ceil(wait / 1000)}s for budget`, method, path);
      e.throttled = true;
      throw e;
    }
    if (wait > 0) await sleep(wait);
    stamps.push(Date.now());

    const opts = { method, headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } };
    if (body) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(url, opts); }
    catch (err) {
      // Only GETs are retried on network errors: a POST may have landed before the
      // connection dropped, and retrying would create a duplicate donor record.
      if (method === "GET" && attempt < MAX_RETRIES) { await sleep(1000 * 2 ** attempt); continue; }
      throw new Error(`Network error calling LGL ${method} ${path}: ${err.message}. ${budgetText()}`);
    }
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }

    // 429 = not processed, safe to retry for any method. 5xx: GET only (see above).
    if (res.status === 429 || (res.status >= 500 && method === "GET")) {
      if (attempt < MAX_RETRIES) {
        const ra = Number(res.headers.get("retry-after"));
        const backoff = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * 2 ** attempt;
        if (backoff <= maxWaitMs) { await sleep(backoff); continue; }
      }
    }
    if (!res.ok) throw new LglError(res.status, data ?? "(empty body)", method, path);
    return data ?? {};
  }
}

// Fetch every page of a list endpoint (limit/offset pagination). Stops at maxItems.
export async function lglAll(path, query = {}, { pageSize = 100, maxItems = 1000 } = {}) {
  const out = [];
  let offset = Number(query.offset || 0);
  let total = null;
  while (out.length < maxItems) {
    const page = await lgl("GET", path, { ...query, limit: Math.min(pageSize, maxItems - out.length), offset });
    const items = page.items || [];
    total = page.total_items ?? total;
    out.push(...items);
    if (!items.length || (total != null && offset + items.length >= total)) break;
    offset += items.length;
  }
  return { items: out, total_items: total, truncated: total != null && out.length < total };
}
