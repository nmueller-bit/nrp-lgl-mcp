// Contact reports. Field names below were verified against NRP's live LGL on 2026-09-24
// (see README "Verified API behaviour"). The short version:
//   create/update body: original_date, contact_report_type_name, name, text, team_member
//   team_member accepts a team-member ID, email, or "First Last"; unknown values are
//   silently dropped, so we validate first (src/team.js).
//   SILENTLY IGNORED by LGL: team_member_id, contact_report_type, summary, date.
//   `date` is the nasty one: LGL saves the report with TODAY's date instead.
//   An unknown contact_report_type_name CREATES a new type in LGL — hence the enum.
import { z } from "zod";
import { lgl, lglAll } from "../lgl.js";
import { txt, json, safe } from "../util.js";
import { runBatch, batchReport, checkBatchSize } from "../batch.js";
import { resolveTeamMemberStrict } from "../team.js";

export const CR_TYPES = ["Call", "Email", "Meeting", "Mailing", "Proposal", "Other"];

// Normalise the several ways callers identify a staff member into LGL's one field.
export function resolveTeamMember({ team_member, team_member_name, team_member_id }) {
  if (team_member != null && team_member !== "") return String(team_member);
  if (team_member_name) return team_member_name;
  if (team_member_id != null) return String(team_member_id); // LGL ignores team_member_id; the ID works in team_member
  return undefined;
}

export async function buildContactReportBody(p) {
  const body = { original_date: p.date, text: p.note ?? p.text };
  const type = p.contact_report_type ?? p.contact_report_type_name;
  if (type) {
    if (!CR_TYPES.includes(type)) throw new Error(`Unknown contact report type "${type}". Use one of ${CR_TYPES.join(", ")} — LGL would create a new type from a typo.`);
    body.contact_report_type_name = type;
  }
  const name = p.summary ?? p.name;
  if (name) body.name = name;
  const tm = await resolveTeamMemberStrict(resolveTeamMember(p));
  if (tm) { body.team_member = tm.value; body._team_label = tm.label; }
  return body;
}
const forLgl = ({ _team_label, ...b }) => b;

// Compare what we asked for with what LGL saved. Returns warning strings.
export function contactReportWarnings(sent, saved) {
  const w = [];
  if (sent.team_member && !saved.team_member) w.push(`team member "${sent._team_label ?? sent.team_member}" was not saved — report is UNATTRIBUTED`);
  if (sent._team_label && saved.team_member && saved.team_member !== sent._team_label) w.push(`LGL saved team member "${saved.team_member}", expected "${sent._team_label}"`);
  if (!sent.team_member && !saved.team_member) w.push("no team member given — report is unattributed");
  if (sent.contact_report_type_name && !saved.contact_report_type_name) w.push(`type "${sent.contact_report_type_name}" was not recognised — report has no type`);
  if (sent.original_date && saved.original_date && saved.original_date !== sent.original_date) w.push(`LGL saved date ${saved.original_date}, not ${sent.original_date}`);
  return w;
}

const crLine = (r, full) =>
  `• #${r.id} | constituent ${r.constituent_id} | ${r.original_date ?? "no date"} | ${r.contact_report_type_name ?? "NO TYPE"} | ` +
  `${r.team_member ?? "UNATTRIBUTED"} | ${r.name ?? ""}` +
  (r.text ? `\n    ${full ? r.text : r.text.replace(/\s+/g, " ").slice(0, 200) + (r.text.length > 200 ? "…" : "")}` : "") +
  `\n    created ${r.created_at ?? "?"}`;

const createSchema = {
  constituent_id: z.number().describe("LGL constituent ID"),
  date: z.string().describe("Date of contact, YYYY-MM-DD (sent to LGL as original_date)"),
  contact_report_type: z.enum(CR_TYPES).default("Meeting").describe("Sent to LGL as contact_report_type_name"),
  summary: z.string().optional().describe("Short headline (LGL 'name'). If omitted LGL names it \"Contact report for 'Last, First'\""),
  note: z.string().describe("Full details / body (LGL 'text'). Required — LGL returns 422 if blank."),
  team_member: z.union([z.string(), z.number()]).optional().describe("Who had the interaction: LGL team-member ID, email, or exact 'First Last'. See list_team_members."),
  team_member_name: z.string().optional().describe("Legacy alias for team_member (full name)."),
  team_member_id: z.number().optional().describe("Team-member ID. Accepted here and sent to LGL as team_member (LGL ignores a raw team_member_id field)."),
  hours: z.number().optional().describe("Not supported by LGL's contact report API — ignored."),
};

export function registerContactReportTools(server) {
  server.tool("create_contact_report",
    "Log a contact report for a constituent in LGL. ALWAYS pass team_member (ID, email or 'First Last') — without it the report is unattributed. " +
    "An unknown team member is refused before anything is written (LGL would silently drop it). The date is sent as original_date — " +
    "LGL ignores a field called 'date' and stamps today's date instead, which this server used to do. The response echoes what LGL saved.",
    createSchema,
    safe(async (p) => {
      const body = await buildContactReportBody(p);
      const data = await lgl("POST", `/constituents/${p.constituent_id}/contact_reports`, {}, forLgl(body));
      const warn = contactReportWarnings(body, data);
      return txt(`Contact report logged! ID: ${data.id} — ${data.contact_report_type_name ?? "no type"} on ${data.original_date}, team member: ${data.team_member ?? "NONE"}` +
        (warn.length ? `\nWARNING: ${warn.join("; ")}` : ""));
    }));

  server.tool("list_contact_reports",
    "List contact reports. With constituent_id: that person's reports. Without it: ACCOUNT-WIDE (all constituents) — use this to " +
    "verify a batch after the fact, e.g. updated_from=<day you logged them> and unattributed_only=true. " +
    "Verified server-side filters: constituent_id, updated_from/updated_to, original_date_from/_to (exposed as date_from/date_to), contact_report_type_id, name. " +
    "LGL rejects created_from / team_member / team_member_id / date as search keys (400). " +
    "unattributed_only / untyped_only / created_from filter client-side after fetching (they cost pages, not extra filters).",
    {
      constituent_id: z.number().optional(),
      updated_from: z.string().optional().describe("YYYY-MM-DD or ISO datetime"),
      updated_to: z.string().optional(),
      date_from: z.string().optional().describe("Contact date (original_date) on/after, YYYY-MM-DD — server-side"),
      date_to: z.string().optional().describe("Contact date on/before — server-side"),
      contact_report_type_id: z.number().int().optional().describe("Server-side filter by type ID"),
      name_contains: z.string().optional().describe("Server-side filter on the report name/headline"),
      created_from: z.string().optional().describe("Client-side filter on created_at (YYYY-MM-DD)"),
      unattributed_only: z.boolean().optional().describe("Client-side: only reports with no team member"),
      untyped_only: z.boolean().optional().describe("Client-side: only reports with no contact report type"),
      sort: z.string().optional().describe("name, date, constituent_id; append ! to reverse. Default date!"),
      limit: z.number().optional().default(5).describe("Max reports to return (default 5; up to 500)"),
      full_text: z.boolean().optional().default(false),
      ids_only: z.boolean().optional().default(false).describe("Return just the report IDs (compact, for feeding into a batch tool)"),
      format: z.enum(["text", "json"]).optional().describe("Default: json for a plain constituent_id(+limit) call (the original behaviour), text otherwise"),
    },
    safe(async (p) => {
      const q = [];
      if (p.constituent_id) q.push(`constituent_id=${p.constituent_id}`);
      if (p.updated_from) q.push(`updated_from=${p.updated_from}`);
      if (p.updated_to) q.push(`updated_to=${p.updated_to}`);
      if (p.date_from) q.push(`original_date_from=${p.date_from}`);
      if (p.date_to) q.push(`original_date_to=${p.date_to}`);
      if (p.contact_report_type_id) q.push(`contact_report_type_id=${p.contact_report_type_id}`);
      if (p.name_contains) q.push(`name=${p.name_contains}`);
      const clientSide = p.unattributed_only || p.untyped_only || p.created_from;
      const limit = Math.min(p.limit ?? 5, 500);
      const path = q.length ? "/contact_reports/search" : "/contact_reports";
      const { items, total_items, truncated } = await lglAll(path, { q, sort: p.sort ?? "date!" }, { maxItems: clientSide ? 1000 : limit });
      let out = items;
      if (p.unattributed_only) out = out.filter((r) => !r.team_member);
      if (p.untyped_only) out = out.filter((r) => !r.contact_report_type_name);
      if (p.created_from) out = out.filter((r) => (r.created_at || "") >= p.created_from);
      const matched = out.length;
      out = out.slice(0, limit);
      const head = `${total_items ?? items.length} report(s) match the server-side filters` +
        (clientSide ? `; ${matched} after client-side filters (scanned ${items.length}${truncated ? ", scan capped at 1000 — narrow with updated_from" : ""})` : "") +
        `; showing ${out.length}.`;
      if (!out.length) return txt(head);
      if (p.ids_only) return txt(`${head}\nIDs: ${out.map((r) => r.id).join(", ")}`);
      const legacyShape = p.constituent_id && !q.slice(1).length && !clientSide && !p.sort;
      if ((p.format ?? (legacyShape ? "json" : "text")) === "json") return json(out);
      return txt(head + "\n" + out.map((r) => crLine(r, p.full_text)).join("\n"));
    }));

  server.tool("get_contact_report", "Get one contact report by ID (full text).",
    { contact_report_id: z.number().int() },
    safe(async ({ contact_report_id }) => json(await lgl("GET", `/contact_reports/${contact_report_id}`))));

  server.tool("update_contact_report",
    "Edit an existing contact report (PATCH). Only the fields you pass are changed. Common use: fix attribution by setting team_member " +
    "(ID, email, or 'First Last'). Verified: PATCH team_member on an unattributed report sticks.",
    {
      contact_report_id: z.number().int(),
      team_member: z.union([z.string(), z.number()]).optional(),
      date: z.string().optional().describe("YYYY-MM-DD (LGL original_date)"),
      contact_report_type: z.enum(CR_TYPES).optional(),
      summary: z.string().optional(),
      note: z.string().optional().describe("Replaces the full text"),
    },
    safe(async (p) => {
      const body = {};
      if (p.team_member != null) { const tm = await resolveTeamMemberStrict(p.team_member); body.team_member = tm.value; body._team_label = tm.label; }
      if (p.date) body.original_date = p.date;
      if (p.contact_report_type) body.contact_report_type_name = p.contact_report_type;
      if (p.summary) body.name = p.summary;
      if (p.note) body.text = p.note;
      if (!Object.keys(body).length) return txt("Nothing to update.");
      const data = await lgl("PATCH", `/contact_reports/${p.contact_report_id}`, {}, forLgl(body));
      const warn = contactReportWarnings({ ...body, team_member: body.team_member ?? data.team_member }, data);
      return txt(`Updated #${data.id}: ${data.original_date} | ${data.contact_report_type_name ?? "NO TYPE"} | ${data.team_member ?? "UNATTRIBUTED"}` +
        (warn.length ? `\nWARNING: ${warn.join("; ")}` : ""));
    }));

  server.tool("batch_update_contact_reports",
    "Apply the same change to many existing contact reports — typically to attribute unattributed reports (set team_member) or set a missing type. " +
    "Find the IDs with list_contact_reports(unattributed_only=true, ids_only=true). One API call per report; per-report results; max 200.",
    {
      contact_report_ids: z.array(z.number().int()).min(1),
      team_member: z.union([z.string(), z.number()]).optional(),
      contact_report_type: z.enum(CR_TYPES).optional(),
    },
    safe(async ({ contact_report_ids, team_member, contact_report_type }) => {
      const body = {};
      if (team_member != null) { const tm = await resolveTeamMemberStrict(team_member); body.team_member = tm.value; body._team_label = tm.label; }
      if (contact_report_type) body.contact_report_type_name = contact_report_type;
      if (!Object.keys(body).length) return txt("Nothing to update — pass team_member and/or contact_report_type.");
      const ids = [...new Set(contact_report_ids)];
      const warn = checkBatchSize(ids.length);
      const r = await runBatch(ids, async (id) => {
        const d = await lgl("PATCH", `/contact_reports/${id}`, {}, forLgl(body));
        const w = contactReportWarnings({ ...body, team_member: body.team_member ?? d.team_member }, d);
        if (w.length) throw new Error(w.join("; "));
        return { note: `${d.team_member ?? "-"} / ${d.contact_report_type_name ?? "-"}` };
      }, { label: (id) => `report #${id}` });
      return txt((warn ? warn + "\n\n" : "") + batchReport("Update contact reports", r));
    }));

  server.tool("batch_create_contact_reports",
    "Create many contact reports in one call (e.g. an event's attendees, or a mailing). Each item is independent: per-item success/failure, " +
    "never aborts on one bad record, and stops early listing the not-attempted items if the rate budget runs low. Max 200. " +
    "Returns the new report IDs so you can verify afterwards with list_contact_reports.",
    {
      reports: z.array(z.object({
        constituent_id: z.number().int(),
        date: z.string(),
        note: z.string(),
        contact_report_type: z.enum(CR_TYPES).optional(),
        summary: z.string().optional(),
        team_member: z.union([z.string(), z.number()]).optional(),
      })).min(1),
      default_team_member: z.union([z.string(), z.number()]).optional().describe("Used for any item without its own team_member"),
      default_contact_report_type: z.enum(CR_TYPES).optional().default("Meeting"),
    },
    safe(async ({ reports, default_team_member, default_contact_report_type }) => {
      const warn = checkBatchSize(reports.length);
      const r = await runBatch(reports, async (it) => {
        const body = await buildContactReportBody({
          ...it,
          contact_report_type: it.contact_report_type ?? default_contact_report_type,
          team_member: it.team_member ?? default_team_member,
        });
        const d = await lgl("POST", `/constituents/${it.constituent_id}/contact_reports`, {}, forLgl(body));
        const w = contactReportWarnings(body, d);
        return { note: `report #${d.id}${w.length ? ` — WARNING: ${w.join("; ")}` : ""}` };
      }, { label: (it) => `constituent ${it.constituent_id} (${it.date})` });
      return txt((warn ? warn + "\n\n" : "") + batchReport("Create contact reports", r));
    }));
}
