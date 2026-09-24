// search_constituents — extended with LGL's other q[] filters plus a raw passthrough.
import { z } from "zod";
import { lgl } from "../lgl.js";
import { txt, safe, fullName } from "../util.js";

// Named param -> LGL q[] key. Behaviour of each is recorded in README "Verified API behaviour".
const NAMED = {
  query: "name",
  email: "eaddr",
  phone: "phone_number",
  city: "city",
  state: "state",
  postal_code: "postal_code",
  group_ids: "groups",
  keyword_id: "keyword",
  membership_status: "membership_status",
  membership_level: "membership_level",
  membership_end_date_from: "membership_end_date_from",
  membership_end_date_to: "membership_end_date_to",
  class_year: "class",
  constituent_type: "constituent_type",
  external_id: "external_id",
  updated_from: "updated_from",
  updated_to: "updated_to",
};

export const searchConstituentsSchema = {
  query: z.string().optional().describe("Name search (any name field). Optional now — you can search by filters alone."),
  limit: z.number().optional().default(10),
  offset: z.number().int().optional().describe("For paging through results; see the next offset in the header line"),
  email: z.string().optional(),
  phone: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postal_code: z.string().optional(),
  group_ids: z.array(z.number().int()).optional().describe("Members of ANY of these groups (LGL 'groups' filter, comma-joined). Verified: includes people whose membership has ENDED. Get IDs from list_groups."),
  keyword_id: z.number().int().optional().describe("Has this keyword. Takes the keyword ID — verified: a keyword NAME returns 0 results with no error. Get IDs from list_categories."),
  membership_status: z.enum(["active", "lapsed"]).optional().describe("LGL memberships — NRP doesn't use them (active returned 0 in testing)"),
  membership_level: z.string().optional(),
  membership_end_date_from: z.string().optional().describe("YYYY-MM-DD"),
  membership_end_date_to: z.string().optional().describe("YYYY-MM-DD"),
  class_year: z.string().optional().describe("LGL 'class' filter (class affiliation)"),
  constituent_type: z.enum(["individual", "organization"]).optional(),
  external_id: z.string().optional(),
  updated_from: z.string().optional().describe("YYYY-MM-DD — records updated on/after"),
  updated_to: z.string().optional().describe("YYYY-MM-DD"),
  custom_attr: z.array(z.string()).optional().describe(
    "Custom-field filters, each 'key|op|value'. ops: ft (contains), nft (doesn't contain), eq, ne, sw (starts with), bl (is blank), nb (not blank). " +
    "Use the custom field's key, not its label."),
  q: z.array(z.string()).optional().describe(
    "Raw LGL q[] entries passed straight through, e.g. ['custom_attr_from=giving_score|50']. Use for any filter not covered by a named param. " +
    "Verified: LGL rejects unknown q[] keys with 400 'Unknown query parameter', so a typo fails loudly rather than returning everyone."),
  expand: z.string().optional().describe("Comma list: categories, groups, memberships, email_addresses, phone_numbers, street_addresses, custom_attrs, ..."),
  sort: z.string().optional().describe("name, external_id, lgl_id, date_created, date_updated, membership_level; append ! to reverse"),
};

export function buildConstituentQ(p) {
  const q = [];
  for (const [param, key] of Object.entries(NAMED)) {
    let v = p[param];
    if (v === undefined || v === null || v === "") continue;
    if (param === "group_ids") { if (!v.length) continue; v = v.join(","); }
    if (param === "membership_status") v = v === "active" ? 1 : 0;
    if (param === "constituent_type") v = v === "organization" ? 1 : 0;
    q.push(`${key}=${v}`);
  }
  for (const c of p.custom_attr || []) q.push(`custom_attr=${c}`);
  for (const raw of p.q || []) q.push(raw);
  return q;
}

export async function searchConstituents(p) {
  const q = buildConstituentQ(p);
  if (!q.length) throw new Error("Give at least one search term or filter (query, group_ids, keyword_id, ... or q).");
  const data = await lgl("GET", "/constituents/search", { q, limit: p.limit ?? 10, offset: p.offset, expand: p.expand, sort: p.sort });
  return { data, q };
}

export function registerSearchTool(server) {
  server.tool("search_constituents",
    "Search donors/constituents in LGL by name and/or filters (groups, keyword, membership, location, custom fields, updated date). " +
    "Filters are ANDed. Results show total matches and the next offset for paging. Search results carry first/last name but no combined 'name' field.",
    searchConstituentsSchema,
    safe(async (p) => {
      const { data, q } = await searchConstituents(p);
      const items = data.items || [];
      const total = data.total_items ?? items.length;
      if (!items.length) return txt(`No constituents found for ${q.join(" AND ")}.`);
      const start = (p.offset || 0) + 1, end = (p.offset || 0) + items.length;
      const header = `${total} match(es) for ${q.join(" AND ")} — showing ${start}–${end}` +
        (end < total ? ` (next offset: ${end})` : "");
      return txt(header + "\n" + items.map((c) =>
        `• ${fullName(c)} (ID: ${c.id})` +
        (c.email_addresses?.[0]?.email_address ? ` — ${c.email_addresses[0].email_address}` : "") +
        (c.gift_total ? ` — Lifetime: $${c.gift_total}` : "") +
        (p.expand ? `\n    ${JSON.stringify(Object.fromEntries(p.expand.split(",").map((k) => [k.trim(), c[k.trim()]])))}` : "")
      ).join("\n"));
    }));
}
