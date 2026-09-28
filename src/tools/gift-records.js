// Single-gift / per-donor gift tools + gift type & category lookups.
// Field shapes verified against NRP's live LGL on 2026-09-28 (probe-lgl-gap-4) — see README.
import { z } from "zod";
import { lgl, lglAll } from "../lgl.js";
import { txt, json, safe } from "../util.js";

const money = (n) => (n == null ? "?" : `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

// ── Gift types (account-specific IDs — NRP: 1 Gift, 7 Pledge, 9 Soft Credit, 10 In Honor of, 13 Installment) ──
let typeCache = null, typeCachedAt = 0;
export async function giftTypes() {
  if (!typeCache || Date.now() - typeCachedAt > 10 * 60 * 1000) {
    const d = await lgl("GET", "/gift_types", { limit: 100 });
    typeCache = (d.items || []).map((t) => ({ id: t.id, name: t.name ?? t.gift_type_name }));
    typeCachedAt = Date.now();
  }
  return typeCache;
}
// Older callers pass these names; map them onto NRP's real type names before resolving.
const TYPE_ALIASES = { "grant": "Gift", "matching gift": "Matching", "in-kind": "In Kind", "in-kind gift": "In Kind", "inkind": "In Kind" };
// Resolve a gift type name (case-insensitive) or numeric ID to { id, name }. Throws with the valid list.
export async function resolveGiftType(input) {
  const list = await giftTypes();
  let s = String(input ?? "Gift").trim().toLowerCase();
  if (TYPE_ALIASES[s]) s = TYPE_ALIASES[s].toLowerCase();
  const hit = list.find((t) => String(t.id) === s || String(t.name).toLowerCase() === s);
  if (!hit) throw new Error(`Unknown gift type "${input}". Valid gift types in this LGL account: ${list.map((t) => `${t.name} (${t.id})`).join(", ")}.`);
  return hit;
}
// Verified: Pledge = type 7. Installments (type 13) carry parent_gift_id = their pledge, so parent_gift_id
// does NOT mean "soft credit" — soft/peer credits are identified by type (9 Soft Credit, 15 Peer Credit).
export const isPledge = (g) => g.gift_type_id === 7 || /^pledge$/i.test(g.gift_type_name || "");
export const isCreditOnly = (g) => [9, 15].includes(g.gift_type_id) || /soft credit|peer credit/i.test(g.gift_type_name || "");

const giftLine = (g) => {
  const amount = g.received_amount ?? g.amount;
  const date = g.received_date ?? g.date;
  return `• gift ${g.id} | ${date ?? "no date"} | ${money(amount)}${isPledge(g) ? " (pledge — list amount is the OUTSTANDING balance)" : ""}` +
    ` | ${g.gift_type_name ?? "?"} (type ${g.gift_type_id ?? "?"})` +
    (g.campaign_id != null ? ` | campaign ${g.campaign_name ?? ""} (${g.campaign_id})` : "") +
    (g.fund_id != null ? ` | fund ${g.fund_name ?? ""} (${g.fund_id})` : "") +
    (g.gift_category_name ? ` | ${g.gift_category_name}` : "") +
    (g.payment_type_name ? ` | ${g.payment_type_name}` : "") +
    (g.parent_gift_id ? ` | parent gift ${g.parent_gift_id}` : "") +
    (g.created_at ? ` | created ${g.created_at}` : "");
};

export const GIFT_FIELDS = ["id", "constituent_id", "gift_type_id", "gift_type_name", "gift_category_id", "gift_category_name",
  "campaign_id", "campaign_name", "fund_id", "fund_name", "appeal_id", "appeal_name", "received_amount", "received_date",
  "payment_type_id", "payment_type_name", "check_number", "deposit_date", "parent_gift_id", "is_anon", "created_at", "updated_at"];
const pick = (g) => Object.fromEntries(GIFT_FIELDS.filter((k) => k in g).map((k) => [k, g[k]]));

export function registerGiftRecordTools(server) {
  server.tool("get_gift",
    "Get one gift by its LGL gift ID (GET /gifts/{id}). Returns campaign, fund, gift type, category, payment type, amount, date, " +
    "parent_gift_id and created_at — fields the per-donor list leaves out or leaves blank. Use to tell a campaign payment " +
    "(e.g. campaign 892) from general monthly giving (campaign 852). full=true returns the raw record.",
    { gift_id: z.number().int(), full: z.boolean().optional().default(false) },
    safe(async ({ gift_id, full }) => {
      const g = await lgl("GET", `/gifts/${gift_id}`);
      return full ? json(g) : json(pick(g));
    }));

  server.tool("get_constituent_gifts",
    "Giving history for one donor (GET /constituents/{id}/gifts): each gift's ID, date, amount, gift type (name + ID), campaign, " +
    "fund, category and created_at. Verified: LGL's per-donor list only carries id, gift type, amount, date and created_at — " +
    "campaign/fund/category need with_details=true (one extra API call per gift, max 25). Pledges and soft/peer credits are listed " +
    "but excluded from the total (reported: a Pledge's list amount is its OUTSTANDING balance). Use get_gift(gift_id) for one gift's full record.",
    {
      constituent_id: z.number(),
      limit: z.number().optional().default(25),
      offset: z.number().int().optional(),
      with_details: z.boolean().optional().default(false).describe("Fetch each gift's full record (campaign, fund, category, payment type). +1 API call per gift; capped at 25 gifts."),
      format: z.enum(["text", "json"]).optional().default("text"),
    },
    safe(async ({ constituent_id, limit, offset, with_details, format }) => {
      const data = await lgl("GET", `/constituents/${constituent_id}/gifts`, { limit: Math.min(limit, with_details ? 25 : 100), offset });
      let items = data.items || [];
      if (with_details) items = await Promise.all(items.map((g) => lgl("GET", `/gifts/${g.id}`).catch(() => g)));
      if (format === "json") return json({ total_items: data.total_items, items: items.map(pick) });
      if (!items.length) return txt("No gifts found.");
      const counted = items.filter((g) => !isCreditOnly(g) && !isPledge(g));
      const total = counted.reduce((s, g) => s + (g.received_amount ?? g.amount ?? 0), 0);
      const shown = (offset || 0) + items.length;
      return txt(`${data.total_items ?? items.length} gift record(s); showing ${items.length}` +
        (data.total_items > shown ? ` (next offset: ${shown})` : "") +
        `. Total of shown gifts excluding pledges and soft/peer credits: ${money(total)}` +
        (with_details ? "" : " (campaign/fund not included — pass with_details=true)") + `\n` + items.map(giftLine).join("\n"));
    }));

  server.tool("list_gift_types", "List this LGL account's gift types with their IDs (they're account-specific — e.g. NRP's Pledge is 7, not 2).", {},
    safe(async () => txt((await giftTypes()).map((t) => `• ${t.name} (gift_type_id: ${t.id})`).join("\n"))));
}

// Gift categories: GET /gift_categories (verified: 21 for NRP, fields id/display_name/gift_type_id/gift_type_name).
// /categories?item_type=Gift returns 0 items for NRP — that was the old list_gift_categories bug.
export async function listGiftCategoriesText() {
  const { items } = await lglAll("/gift_categories", {}, { maxItems: 500 });
  if (!items.length) return "No gift categories found.";
  const byType = {};
  for (const c of items) (byType[`${c.gift_type_name ?? "?"} (gift_type_id ${c.gift_type_id ?? "?"})`] ||= []).push(c);
  return Object.entries(byType).map(([t, cs]) => `${t}:\n` + cs.map((c) => `  • ${c.display_name ?? c.name} (gift_category_id: ${c.id})`).join("\n")).join("\n");
}
