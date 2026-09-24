// Groups & group memberships.
import { z } from "zod";
import { lgl, lglAll } from "../lgl.js";
import { txt, json, safe, dedupeIds } from "../util.js";
import { runBatch, batchReport, checkBatchSize } from "../batch.js";

const fmtMembership = (m) =>
  `• membership ID ${m.id}: group ${m.group_name ?? "?"} (group ID ${m.group_id})` +
  `${m.date_start ? `, from ${m.date_start}` : ""}${m.date_end ? ` to ${m.date_end}` : ""}` +
  `${m.is_current === false ? " [ended]" : m.is_current ? " [current]" : ""}`;

export function registerGroupTools(server) {
  server.tool("list_groups", "List all LGL groups with their IDs.", {},
    safe(async () => {
      const { items } = await lglAll("/groups", {}, { maxItems: 500 });
      if (!items.length) return txt("No groups found.");
      return txt(items.map((g) => `• ${g.name} (group ID: ${g.id})${g.key ? ` [key: ${g.key}]` : ""}`).join("\n"));
    }));

  server.tool("create_group", "Create a new LGL group. Org-wide configuration change — confirm the name with the user first.",
    { name: z.string().min(1), key: z.string().optional() },
    safe(async (p) => {
      const data = await lgl("POST", "/groups", {}, p);
      return txt(`Group created: ${data.name} (group ID: ${data.id})`);
    }));

  server.tool("update_group", "Rename/edit an LGL group. LGL requires name on every update.",
    { group_id: z.number().int(), name: z.string().min(1), key: z.string().optional() },
    safe(async ({ group_id, ...body }) => {
      const data = await lgl("PATCH", `/groups/${group_id}`, {}, body);
      return txt(`Group updated: ${data.name} (group ID: ${data.id})`);
    }));

  server.tool("delete_group",
    "IRREVERSIBLE: delete an entire LGL group. Refuses if the group still has any members (remove or end them first), " +
    "and requires confirm_name to exactly match the group's current name. Use only for mistakes/test groups.",
    { group_id: z.number().int(), confirm_name: z.string() },
    safe(async ({ group_id, confirm_name }) => {
      const g = await lgl("GET", `/groups/${group_id}`);
      if (g.name !== confirm_name) return txt(`Refused: group ${group_id} is named "${g.name}", not "${confirm_name}".`);
      const members = await lgl("GET", "/constituents/search", { q: [`groups=${group_id}`], limit: 1 });
      if ((members.total_items ?? 0) > 0) return txt(`Refused: "${g.name}" still has ${members.total_items} member(s). Remove them first or delete it in the LGL UI.`);
      await lgl("DELETE", `/groups/${group_id}`);
      return txt(`Group "${g.name}" (ID ${group_id}) deleted.`);
    }));

  server.tool("list_constituent_group_memberships",
    "List a constituent's group memberships. Note the membership ID (needed to update/remove) is different from the group ID.",
    { constituent_id: z.number().int() },
    safe(async ({ constituent_id }) => {
      const { items } = await lglAll(`/constituents/${constituent_id}/group_memberships`, {}, { maxItems: 200 });
      if (!items.length) return txt("No group memberships.");
      return txt(items.map(fmtMembership).join("\n"));
    }));

  server.tool("get_group_membership", "Get one group membership by its membership ID.",
    { membership_id: z.number().int() },
    safe(async ({ membership_id }) => json(await lgl("GET", `/group_memberships/${membership_id}`))));

  server.tool("add_group_membership",
    "Add one constituent to a group (POST /constituents/{id}/group_memberships). LGL happily creates DUPLICATE memberships in the same group, " +
    "so this checks for a current one first and refuses unless allow_duplicate=true. For many constituents use batch_add_group_membership.",
    {
      constituent_id: z.number().int(),
      group_id: z.number().int(),
      date_start: z.string().optional().describe("YYYY-MM-DD"),
      date_end: z.string().optional().describe("YYYY-MM-DD"),
      allow_duplicate: z.boolean().optional().default(false),
    },
    safe(async ({ constituent_id, allow_duplicate, ...body }) => {
      if (!allow_duplicate) {
        const cur = await lgl("GET", `/constituents/${constituent_id}/group_memberships`, { limit: 100 });
        const hit = (cur.items || []).find((m) => m.group_id === body.group_id && m.is_current !== false && !m.date_end);
        if (hit) return txt(`Not added: constituent ${constituent_id} already has a current membership in ${hit.group_name ?? body.group_id} (membership ID ${hit.id}).`);
      }
      if (body.date_end && new Date(body.date_end) <= new Date()) body.is_current = false;
      const data = await lgl("POST", `/constituents/${constituent_id}/group_memberships`, {}, body);
      return txt(`Added constituent ${constituent_id} to group ${body.group_id} (membership ID: ${data.id}).`);
    }));

  server.tool("update_group_membership",
    "Edit a group membership — e.g. end it by setting date_end. Ending a membership keeps history; prefer this over remove_group_membership. " +
    "Verified: setting date_end alone does NOT make LGL mark it ended (is_current stays true), so this tool also sends is_current=false " +
    "whenever date_end is given, unless you pass is_current yourself. LGL's docs mark group_id required on update, but a PATCH without it works.",
    {
      membership_id: z.number().int(),
      group_id: z.number().int().optional(),
      date_start: z.string().optional(),
      date_end: z.string().optional(),
      is_current: z.boolean().optional(),
    },
    safe(async ({ membership_id, ...rest }) => {
      const body = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      if (body.date_end && body.is_current === undefined) body.is_current = false;
      const data = await lgl("PATCH", `/group_memberships/${membership_id}`, {}, body);
      return txt(`Membership updated.\n${fmtMembership(data)}`);
    }));

  server.tool("remove_group_membership",
    "IRREVERSIBLE: delete a group membership record (DELETE /group_memberships/{membership_id}). This erases the history that the " +
    "person was ever in the group. To record that someone LEFT a group, use update_group_membership with date_end instead. " +
    "Takes the MEMBERSHIP ID (from list_constituent_group_memberships), not the group ID. Confirm with the user first.",
    { membership_id: z.number().int() },
    safe(async ({ membership_id }) => {
      const m = await lgl("GET", `/group_memberships/${membership_id}`);
      await lgl("DELETE", `/group_memberships/${membership_id}`);
      return txt(`Deleted membership ${membership_id} (constituent ${m.constituent_id}, group ${m.group_name ?? m.group_id}).`);
    }));

  server.tool("batch_add_group_membership",
    "Add many constituents to one group. Skips anyone already a current member (checks first — costs one extra read per person). " +
    "Per-constituent results; never aborts on one bad record; stops early and lists leftovers if the rate budget runs low. Max 200.",
    {
      group_id: z.number().int(),
      constituent_ids: z.array(z.number().int()).min(1),
      date_start: z.string().optional().describe("YYYY-MM-DD"),
      skip_existing: z.boolean().optional().default(true),
    },
    safe(async ({ group_id, constituent_ids, date_start, skip_existing }) => {
      const ids = dedupeIds(constituent_ids);
      const warn = checkBatchSize(ids.length * (skip_existing ? 2 : 1));
      const r = await runBatch(ids, async (id) => {
        if (skip_existing) {
          const cur = await lgl("GET", `/constituents/${id}/group_memberships`, { limit: 100 });
          const hit = (cur.items || []).find((m) => m.group_id === group_id && m.is_current !== false && !m.date_end);
          if (hit) return { note: `already a member (membership ${hit.id}) — skipped` };
        }
        const body = { group_id };
        if (date_start) body.date_start = date_start;
        const m = await lgl("POST", `/constituents/${id}/group_memberships`, {}, body);
        return { note: `membership ${m.id}` };
      }, { label: (id) => `constituent ${id}` });
      return txt((warn ? warn + "\n\n" : "") + batchReport(`Add to group ${group_id}`, r));
    }));
}
