import { budgetText } from "./lgl.js";

export const txt = (text) => ({ content: [{ type: "text", text }] });
export const json = (obj) => txt(JSON.stringify(obj, null, 2));

// Wrap a tool handler so LGL errors come back as readable tool errors (with the
// rate budget attached) instead of opaque protocol failures.
export const safe = (fn) => async (args) => {
  try { return await fn(args); }
  catch (err) {
    const msg = String(err?.message || err);
    return { isError: true, content: [{ type: "text", text: `LGL_ERROR: ${msg}${/LGL budget/.test(msg) ? "" : ` ${budgetText()}`}` }] };
  }
};

export const fullName = (c) => [c.first_name, c.last_name].filter(Boolean).join(" ") || c.org_name || c.sort_name || "(no name)";

export const dedupeIds = (ids) => [...new Set(ids.map(Number))].filter((n) => Number.isInteger(n) && n > 0);
