// Team-member resolution. Verified live 2026-09-24: LGL's `team_member` field accepts a
// team-member ID, email, or "First Last" — but an unrecognised value is SILENTLY dropped
// (create → team_member null; PATCH → previous value kept). So we validate against
// /team_members ourselves before writing, and refuse rather than save unattributed.
import { lgl } from "./lgl.js";

let cache = null, cachedAt = 0;
const TTL = 10 * 60 * 1000;

export async function teamMembers() {
  if (!cache || Date.now() - cachedAt > TTL) {
    const d = await lgl("GET", "/team_members", { limit: 100 });
    cache = d.items || [];
    cachedAt = Date.now();
  }
  return cache;
}

const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, " ");

// Returns { member, value } where value is what to send to LGL (the numeric ID as a string),
// or throws a helpful error listing valid options.
export async function resolveTeamMemberStrict(input) {
  if (input == null || input === "") return null;
  const list = await teamMembers();
  const s = norm(input);
  const hit = list.find((m) =>
    String(m.id) === s || (m.email && norm(m.email) === s) || norm(`${m.first_name} ${m.last_name}`) === s);
  if (!hit) {
    const options = list.map((m) => `${m.first_name} ${m.last_name} (ID ${m.id})`).join("; ");
    throw new Error(`Unknown team member "${input}". LGL would silently save the report UNATTRIBUTED, so nothing was written. Valid team members: ${options}.`);
  }
  return { member: hit, value: String(hit.id), label: `${hit.first_name} ${hit.last_name}` };
}
