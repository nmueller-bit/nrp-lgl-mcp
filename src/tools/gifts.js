// search_gifts + a working giving_report.
//
// Verified 2026-09-24 against NRP's LGL: GET /gifts/search accepts these q[] keys:
//   date_from, date_to, updated_from, updated_to, created_from, created_to
// gift_amount is a recognised key but rejects every value format tried (see README) — unusable.
// campaign_id / fund_id / appeal_id / gift_type_id / constituent_id / amount_* and ~25 other
// guesses all return 400 "Unknown query parameter". So those filters are applied CLIENT-SIDE here, after
// fetching the date window — which is why a date range is required for them.
// List items use received_amount / received_date (not amount/date).
import { z } from "zod";
import { lgl, lglAll } from "../lgl.js";
import { txt, safe } from "../util.js";

const money = (n) => `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const isSoftCredit = (g) => g.parent_gift_id || /soft credit/i.test(g.gift_type_name || "");

export const giftSearchSchema = {
  date_from: z.string().optional().describe("Gift date on/after, YYYY-MM-DD (server-side filter)"),
  date_to: z.string().optional().describe("Gift date on/before, YYYY-MM-DD (server-side). Always set it with date_from: open-ended date_from also returns undated gifts."),
  updated_from: z.string().optional().describe("Record updated on/after (server-side; loose — can include the prior day)"),
  updated_to: z.string().optional(),
  created_from: z.string().optional().describe("Gift RECORD created on/after, YYYY-MM-DD (server-side) — e.g. 'what got entered this week'"),
  created_to: z.string().optional().describe("Gift RECORD created on/before, YYYY-MM-DD (server-side)"),
  campaign_id: z.number().int().optional().describe("CLIENT-SIDE filter (LGL rejects it as a search key)"),
  fund_id: z.number().int().optional().describe("CLIENT-SIDE filter"),
  appeal_id: z.number().int().optional().describe("CLIENT-SIDE filter"),
  gift_type_id: z.number().int().optional().describe("CLIENT-SIDE filter. 1=Gift, 2=Pledge, 3=Matching Gift, 5=In-Kind, 6=Bequest"),
  gift_category_id: z.number().int().optional().describe("CLIENT-SIDE filter"),
  min_amount: z.number().optional().describe("CLIENT-SIDE filter on received_amount"),
  max_amount: z.number().optional().describe("CLIENT-SIDE filter on received_amount"),
  include_soft_credits: z.boolean().optional().default(false).describe("Soft credits appear as separate items (parent_gift_id set); excluded by default so totals aren't doubled"),
  q: z.array(z.string()).optional().describe("Raw q[] entries passed through. LGL returns 400 'Unknown query parameter' for keys it doesn't support — it does not silently ignore them."),
  sort: z.string().optional().describe("date, gift_amount, campaign, fund, appeal, gift_type; append ! to reverse. Default date!"),
  limit: z.number().optional().default(25).describe("Max gifts to return after filtering (up to 500)"),
  max_scan: z.number().optional().default(1000).describe("Max gifts to fetch from LGL before client-side filtering (100 per API call). Raise carefully — NRP has ~9,600 gifts."),
};

export async function searchGifts(p) {
  const q = [];
  for (const k of ["date_from", "date_to", "updated_from", "updated_to", "created_from", "created_to"]) if (p[k]) q.push(`${k}=${p[k]}`);
  for (const raw of p.q || []) q.push(raw);
  const clientSide = ["campaign_id", "fund_id", "appeal_id", "gift_type_id", "gift_category_id", "min_amount", "max_amount"].some((k) => p[k] != null);
  if (clientSide && !(p.date_from || p.updated_from || p.created_from || (p.q || []).length))
    throw new Error("campaign/fund/appeal/type/category/amount filters run client-side, so give a date_from/date_to (or updated_from) window to keep the scan bounded.");
  if (!q.length) q.push("date_to=2999-12-31"); // LGL requires at least one q[]; this matches everything
  const limit = Math.min(p.limit ?? 25, 500);
  const full = clientSide || p.scan_all; // scan_all: giving_report needs every gift in the window
  const scan = full ? Math.min(p.max_scan ?? 1000, 5000) : Math.min(limit + 25, 525); // +25 headroom for dropped soft credits
  const { items, total_items, truncated } = await lglAll("/gifts/search", { q, sort: p.sort ?? "date!" }, { maxItems: scan });
  const f = items.filter((g) =>
    (p.include_soft_credits || !isSoftCredit(g)) &&
    (p.campaign_id == null || g.campaign_id === p.campaign_id) &&
    (p.fund_id == null || g.fund_id === p.fund_id) &&
    (p.appeal_id == null || g.appeal_id === p.appeal_id) &&
    (p.gift_type_id == null || g.gift_type_id === p.gift_type_id) &&
    (p.gift_category_id == null || g.gift_category_id === p.gift_category_id) &&
    (p.min_amount == null || (g.received_amount ?? 0) >= p.min_amount) &&
    (p.max_amount == null || (g.received_amount ?? 0) <= p.max_amount));
  return { q, clientSide, total_items, scanned: items.length, truncated: full && truncated, matched: f, shown: f.slice(0, limit) };
}

export function registerGiftTools(server) {
  server.tool("search_gifts",
    "Search gifts across ALL constituents (GET /gifts/search). Server-side filters: gift date, updated and created ranges. Campaign/fund/appeal/type/" +
    "category/amount filters run client-side on the fetched window (LGL rejects them as search keys) — so always give a date window. " +
    "Answers questions like 'who gave through campaign X this year'. Label fields (campaign_name etc.) may be null in list results; IDs are reliable.",
    giftSearchSchema,
    safe(async (p) => {
      const r = await searchGifts(p);
      const sum = r.matched.reduce((s, g) => s + (g.received_amount || 0), 0);
      const head = r.clientSide
        ? `${r.matched.length} gift(s) matched the client-side filters, total ${money(sum)} (scanned ${r.scanned} of ${r.total_items} gifts for ${r.q.join(" AND ")}` +
          (r.truncated ? ` — SCAN CAPPED, results incomplete: narrow the dates or raise max_scan` : "") + `). Showing ${r.shown.length}.`
        : `${r.total_items} gift(s) for ${r.q.join(" AND ")} (soft credits ${p.include_soft_credits ? "included" : "hidden"}). Showing ${r.shown.length}, newest first` +
          ` — for totals over the whole window use giving_report.`;
      return txt(head + (r.shown.length ? "\n" + r.shown.map((g) =>
        `• gift ${g.id} | constituent ${g.constituent_id} | ${g.received_date ?? "no date"} | ${money(g.received_amount)} | ${g.gift_type_name ?? ""}` +
        ` | campaign ${g.campaign_name ?? g.campaign_id ?? "-"} | fund ${g.fund_name ?? g.fund_id ?? "-"} | appeal ${g.appeal_name ?? g.appeal_id ?? "-"}` +
        `${g.gift_category_name ? ` | ${g.gift_category_name}` : ""}${g.is_anon ? " | ANON" : ""}`).join("\n") : ""));
    }));
}

// Replacement for the old giving_report (which called GET /gifts — an endpoint that 404s).
export async function givingReport({ date_from, date_to, updated_from, max_scan = 2000 }) {
  const campaigns = await lgl("GET", "/campaigns", { limit: 100 });
  const funds = await lgl("GET", "/funds", { limit: 100 });
  const cName = Object.fromEntries((campaigns.items || []).map((c) => [c.id, c.name]));
  const fName = Object.fromEntries((funds.items || []).map((f) => [f.id, f.name]));
  const r = await searchGifts({ date_from, date_to, updated_from, max_scan, limit: 500, scan_all: true });
  const gifts = r.matched;
  if (!gifts.length) return "No gifts found for that window.";
  const total = gifts.reduce((s, g) => s + (g.received_amount || 0), 0);
  const byFund = {}, byCamp = {}, byDonor = {};
  for (const g of gifts) {
    const a = g.received_amount || 0;
    const fk = g.fund_name || fName[g.fund_id] || "Undesignated";
    const ck = g.campaign_name || cName[g.campaign_id] || "No Campaign";
    byFund[fk] = (byFund[fk] || 0) + a;
    byCamp[ck] = (byCamp[ck] || 0) + a;
    byDonor[g.constituent_id] = (byDonor[g.constituent_id] || 0) + a;
  }
  const fmt = (o, n = 99) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `  ${k}: ${money(v)}`).join("\n");
  return `NRP Giving Report — ${r.q.join(" AND ")} (${gifts.length} gifts, soft credits excluded${r.truncated ? "; SCAN CAPPED, totals incomplete" : ""})\n\n` +
    `TOTAL: ${money(total)}\nCOUNT: ${gifts.length}\nAVG: ${money(total / gifts.length)}\n\nBY FUND:\n${fmt(byFund)}\n\nBY CAMPAIGN:\n${fmt(byCamp)}\n\n` +
    `TOP DONORS (constituent ID — look up with get_constituent):\n${fmt(byDonor, 5)}`;
}
