// Categories & keywords. In LGL a "category" (e.g. "Interests", item_type
// Constituent) holds "keywords" (e.g. "Orthodox"). Tagging a constituent =
// adding a keyword to them.
import { z } from "zod";
import { lgl, lglAll } from "../lgl.js";
import { txt, json, safe, dedupeIds } from "../util.js";
import { runBatch, batchReport, checkBatchSize } from "../batch.js";

// Verified live: POST/DELETE /constituents/{id}/keywords return {"result":"success"} whether or not
// anything changed (adding a keyword twice, or removing one the person doesn't have). So we
// read state ourselves to report what actually happened.
// Also verified: in a category whose facet_type is "single", adding a second keyword silently
// REPLACES the person's existing keyword in that category. Unknown keyword → 400; unknown
// constituent → 403 "You do not have access" (not 404).
async function keywordsOf(constituentId) {
  const data = await lgl("GET", `/constituents/${constituentId}/categories`, { limit: 100 });
  const m = new Map();
  for (const c of data.items || []) for (const k of c.keywords || []) m.set(k.id, { ...k, category_name: c.name });
  return m;
}
const keywordIdsOf = async (id) => new Set((await keywordsOf(id)).keys());
async function assertKeyword(keywordId) {
  const k = await lgl("GET", `/keywords/${keywordId}`); // 404s for a bad ID
  let facet = null;
  try { facet = (await lgl("GET", `/categories/${k.category_id}`)).facet_type; } catch {}
  return { ...k, facet_type: facet };
}
const hint403 = (err) => (/ 403 /.test(err.message) ? new Error(`${err.message} (LGL returns 403 for a constituent ID that doesn't exist)`) : err);

export function registerKeywordTools(server) {
  server.tool("list_categories",
    "List LGL categories (the containers that hold keywords), optionally filtered by item_type. " +
    "Each category shows its keywords with IDs — use those keyword IDs with add_constituent_keyword / " +
    "batch_add_constituent_keyword / search_constituents(keyword_id). For gift categories specifically, list_gift_categories also works.",
    {
      item_type: z.string().optional().describe("Filter, e.g. 'Constituent' or 'Gift'. Omit for all."),
      include_keywords: z.boolean().optional().default(true),
    },
    safe(async ({ item_type, include_keywords }) => {
      const { items } = await lglAll("/categories", item_type ? { item_type } : {}, { maxItems: 500 });
      if (!items.length) return txt("No categories found.");
      return txt(items.map((c) =>
        `• ${c.name} (category ID: ${c.id}, item_type: ${c.item_type}${c.facet_type ? `, facet: ${c.facet_type}` : ""})` +
        (include_keywords && Array.isArray(c.keywords) && c.keywords.length
          ? "\n" + c.keywords.map((k) => `    ◦ ${k.name} (keyword ID: ${k.id})`).join("\n") : "")
      ).join("\n"));
    }));

  server.tool("list_category_keywords",
    "List the keywords inside one category (GET /categories/{id}/keywords).",
    { category_id: z.number().int() },
    safe(async ({ category_id }) => {
      const { items } = await lglAll(`/categories/${category_id}/keywords`, {}, { maxItems: 500 });
      if (!items.length) return txt("No keywords in that category.");
      return txt(items.map((k) => `• ${k.name} (keyword ID: ${k.id})${k.short_code ? ` [${k.short_code}]` : ""}${k.description ? ` — ${k.description}` : ""}`).join("\n"));
    }));

  server.tool("get_constituent_keywords",
    "Show which categories/keywords a constituent currently has (GET /constituents/{id}/categories).",
    { constituent_id: z.number().int() },
    safe(async ({ constituent_id }) => {
      const data = await lgl("GET", `/constituents/${constituent_id}/categories`, { limit: 100 });
      return json(data.items ?? data);
    }));

  server.tool("create_category",
    "Create a new LGL category (a container for keywords). This changes the org's LGL configuration for every user — " +
    "confirm the name with the user first. item_type is required by LGL (e.g. 'Constituent').",
    {
      name: z.string().min(1),
      item_type: z.string().describe("What the category applies to, e.g. 'Constituent' or 'Gift'"),
      facet_type: z.string().optional().describe("Copy from an existing category of the same kind (see list_categories)"),
      key: z.string().optional(),
    },
    safe(async (p) => {
      const data = await lgl("POST", "/categories", {}, p);
      return txt(`Category created: ${data.name} (ID: ${data.id}, item_type: ${data.item_type})`);
    }));

  server.tool("update_category",
    "Rename or edit an LGL category. Affects every user of LGL.",
    {
      category_id: z.number().int(),
      name: z.string().optional(),
      item_type: z.string().optional(),
      facet_type: z.string().optional(),
    },
    safe(async ({ category_id, ...rest }) => {
      const body = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      const data = await lgl("PATCH", `/categories/${category_id}`, {}, body);
      return txt(`Category updated: ${data.name} (ID: ${data.id})`);
    }));

  server.tool("create_keyword",
    "Create a new keyword inside a category (POST /categories/{id}/keywords). Changes org-wide LGL configuration — confirm with the user first.",
    {
      category_id: z.number().int(),
      name: z.string().min(1),
      description: z.string().optional(),
      short_code: z.string().optional(),
    },
    safe(async ({ category_id, ...rest }) => {
      const data = await lgl("POST", `/categories/${category_id}/keywords`, {}, { category_id, ...rest });
      return txt(`Keyword created: ${data.name} (keyword ID: ${data.id}) in category ${category_id}`);
    }));

  server.tool("add_constituent_keyword",
    "Tag one constituent with a keyword (POST /constituents/{id}/keywords). Get keyword IDs from list_categories. " +
    "LGL answers 'success' even if nothing changed, so this tool reads before and after and tells you what really happened (~5 API calls). " +
    "CAUTION: if the keyword's category is single-select (facet_type 'single'), LGL silently REPLACES the person's existing keyword in that category — the response names anything replaced. " +
    "For more than one constituent use batch_add_constituent_keyword.",
    { constituent_id: z.number().int(), keyword_id: z.number().int() },
    safe(async ({ constituent_id, keyword_id }) => {
      const k = await assertKeyword(keyword_id);
      const before = await keywordsOf(constituent_id).catch((e) => { throw hint403(e); });
      if (before.has(keyword_id)) return txt(`Constituent ${constituent_id} already has keyword "${k.name}" (${keyword_id}) — nothing changed.`);
      await lgl("POST", `/constituents/${constituent_id}/keywords`, {}, { id: keyword_id });
      const after = await keywordsOf(constituent_id);
      const lost = [...before.values()].filter((x) => !after.has(x.id));
      return txt((after.has(keyword_id)
        ? `Keyword "${k.name}" (${keyword_id}) added to constituent ${constituent_id} — confirmed on read-back.`
        : `WARNING: LGL said success but keyword ${keyword_id} is not on constituent ${constituent_id} on read-back.`) +
        (lost.length ? `\nNOTE: this replaced ${lost.map((x) => `"${x.name}" (${x.id}, ${x.category_name})`).join(", ")} — "${k.name}" is in a single-select category.` : ""));
    }));

  server.tool("remove_constituent_keyword",
    "IRREVERSIBLE: remove a keyword from one constituent (DELETE /constituents/{id}/keywords/{keyword_id}). " +
    "LGL keeps no undo/history for this through the API — the only way back is re-adding it. LGL also answers 'success' when the person " +
    "never had the keyword, so this tool checks first and says which case it was. " +
    "Confirm the constituent and keyword with the user before calling.",
    { constituent_id: z.number().int(), keyword_id: z.number().int() },
    safe(async ({ constituent_id, keyword_id }) => {
      const before = await keywordIdsOf(constituent_id);
      if (!before.has(keyword_id)) return txt(`Constituent ${constituent_id} does not have keyword ${keyword_id} — nothing removed.`);
      await lgl("DELETE", `/constituents/${constituent_id}/keywords/${keyword_id}`);
      const after = await keywordIdsOf(constituent_id);
      return txt(after.has(keyword_id)
        ? `WARNING: LGL said success but keyword ${keyword_id} is still on constituent ${constituent_id}.`
        : `Keyword ${keyword_id} removed from constituent ${constituent_id} — confirmed on read-back.`);
    }));

  server.tool("batch_add_constituent_keyword",
    "Tag many constituents with one keyword. One API call per constituent (plus 2 up front), throttled; adding is idempotent " +
    "(LGL answers success if they already had it). CAUTION: in a single-select category this REPLACES each person's existing keyword in that category; returns per-constituent " +
    "success/failure and never aborts on one bad record. If the rate budget runs low it stops and lists the IDs " +
    "not attempted so you can re-run just those. Max 200 IDs per call.",
    {
      keyword_id: z.number().int(),
      constituent_ids: z.array(z.number().int()).min(1),
    },
    safe(async ({ keyword_id, constituent_ids }) => {
      const ids = dedupeIds(constituent_ids);
      const warn = checkBatchSize(ids.length);
      const k = await assertKeyword(keyword_id);
      const r = await runBatch(ids, async (id) => {
        await lgl("POST", `/constituents/${id}/keywords`, {}, { id: keyword_id }).catch((e) => { throw hint403(e); });
        return null;
      }, { label: (id) => `constituent ${id}` });
      const single = k.facet_type === "single" ? `NOTE: "${k.name}" is in a single-select category — anyone who had another keyword from that category had it REPLACED.\n\n` : "";
      return txt((warn ? warn + "\n\n" : "") + single + batchReport(`Add keyword "${k.name}" (${keyword_id})`, r));
    }));

  server.tool("batch_remove_constituent_keyword",
    "IRREVERSIBLE, BULK: remove one keyword from many constituents. There is no undo through the API. " +
    "Show the user the exact list and get explicit confirmation before calling. Reads each person first (LGL reports success even when " +
    "there was nothing to remove), so results say whether each one actually had the keyword. Two calls per constituent; max 200 IDs.",
    {
      keyword_id: z.number().int(),
      constituent_ids: z.array(z.number().int()).min(1),
    },
    safe(async ({ keyword_id, constituent_ids }) => {
      const ids = dedupeIds(constituent_ids);
      const warn = checkBatchSize(ids.length);
      const r = await runBatch(ids, async (id) => {
        const had = (await keywordIdsOf(id).catch((e) => { throw hint403(e); })).has(keyword_id);
        if (!had) return { note: "did not have the keyword — nothing removed" };
        await lgl("DELETE", `/constituents/${id}/keywords/${keyword_id}`);
        return { note: "removed" };
      }, { label: (id) => `constituent ${id}` });
      return txt((warn ? warn + "\n\n" : "") + batchReport(`Remove keyword ${keyword_id}`, r));
    }));
}
