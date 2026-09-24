// verify-live.mjs — call every new/changed MCP tool through the real server code
// (in-memory MCP client → createServer() → throttled LGL client → live LGL API).
//
//   npm install
//   node scripts/verify-live.mjs
//
// Writes scripts/verify-results.json (tool name, args, exact tool response text).
// Key: LGL_API_KEY env var, else Claude Desktop config (never printed).
//
// Writes only touch ZZ test records:
//   constituent ZZTest ClaudeMCP, category "ZZ MCP Test Category", group "ZZ MCP Test Group",
//   and a throwaway group "ZZ MCP Delete Me" that the run creates and deletes.
// Batch tools are also given constituent ID 1 (doesn't exist) on purpose, to show
// per-item failure handling. Real-data reads are redacted (names/emails/text removed).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "verify-results.json");
const TEST = Number(process.env.TEST_CONSTITUENT_ID || 958059);
const TEST_CAT = 1394, TEST_GROUP = 3319, NOAH = 5085822;
const TODAY = new Date().toISOString().slice(0, 10);

function findKey() {
  if (process.env.LGL_API_KEY) return process.env.LGL_API_KEY;
  const cands = [];
  if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, "Claude", "claude_desktop_config.json"));
  if (process.env.LOCALAPPDATA) {
    const pk = path.join(process.env.LOCALAPPDATA, "Packages");
    try { for (const d of fs.readdirSync(pk)) if (/^Claude/i.test(d))
      cands.push(path.join(pk, d, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json")); } catch {}
  }
  for (const c of cands) {
    try { const k = JSON.parse(fs.readFileSync(c, "utf8"))?.mcpServers?.lgl?.env?.LGL_API_KEY; if (k && !/YOUR/i.test(k)) return k; } catch {}
  }
  return null;
}
process.env.LGL_API_KEY = findKey() || "";
if (!process.env.LGL_API_KEY) { console.error("No LGL_API_KEY found."); process.exit(1); }
process.env.MCP_NO_LISTEN = "1";

const { createServer } = await import("../index.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const server = createServer();
const client = new Client({ name: "verify-live", version: "1.0.0" });
const [ct, st] = InMemoryTransport.createLinkedPair();
await server.connect(st);
await client.connect(ct);

const results = { ran_at: new Date().toISOString(), test_constituent: TEST, calls: [] };
const save = () => fs.writeFileSync(OUT, JSON.stringify(results, null, 2));

// Redact donor names/emails/note text from real-data reads. Lines about the test
// constituent are kept verbatim.
function redact(text) {
  return text.split("\n").map((l) => {
    if (l.includes(String(TEST)) || /ZZ ?Test|ClaudeMCP|ZZ MCP/.test(l)) return l;
    return l
      .replace(/^• (.+?) \(ID: (\d+)\)/, "• <name> (ID: $2)")
      .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>")
      .replace(/^( {4})(?!created)(.+)$/, "$1<text redacted>");
  }).join("\n");
}

async function t(name, args = {}, { real = false } = {}) {
  const started = Date.now();
  let text, isError = false;
  try {
    const r = await client.callTool({ name, arguments: args });
    text = (r.content || []).map((c) => c.text).join("\n");
    isError = !!r.isError;
  } catch (e) { text = `CLIENT ERROR: ${e.message}`; isError = true; }
  const shown = real ? redact(text) : text;
  results.calls.push({ tool: name, args, isError, ms: Date.now() - started, response: shown });
  console.log(`\n=== ${name} ${JSON.stringify(args).slice(0, 140)}${isError ? "  [ERROR]" : ""}\n${shown.slice(0, 700)}`);
  save();
  return text;
}
const grab = (re, s) => (s.match(re) || [])[1];

// ── Reads ──────────────────────────────────────────────────────────────────────────
await t("list_team_members");
await t("list_categories", { item_type: "Constituent" });
await t("list_category_keywords", { category_id: TEST_CAT });
await t("list_groups");
await t("search_constituents", { query: "ClaudeMCP" });
await t("search_constituents", { group_ids: [TEST_GROUP], expand: "groups" });
await t("search_constituents", { constituent_type: "organization", limit: 3 }, { real: true });
await t("search_constituents", { updated_from: TODAY, query: "ZZTest" });
await t("search_constituents", { q: ["not_a_real_key=1"] });            // expect LGL 400 surfaced
await t("search_constituents", {});                                       // expect friendly refusal
await t("get_constituent_keywords", { constituent_id: TEST });
await t("list_constituent_group_memberships", { constituent_id: TEST });
await t("list_contact_reports", { constituent_id: TEST, limit: 3 });                       // legacy shape → JSON
await t("list_contact_reports", { constituent_id: TEST, limit: 20, format: "text" });
await t("list_contact_reports", { updated_from: "2026-09-01", unattributed_only: true, ids_only: true, limit: 500 }, { real: true });
await t("list_contact_reports", { limit: 3, ids_only: true }, { real: true });
await t("search_gifts", { date_from: "2026-09-01", date_to: "2026-09-24", limit: 5 }, { real: true });
await t("search_gifts", { date_from: "2026-01-01", date_to: "2026-09-24", min_amount: 1000, limit: 5 }, { real: true });
await t("search_gifts", { campaign_id: 892 });                           // expect refusal: needs a date window
await t("giving_report", { date_from: "2026-09-01", date_to: "2026-09-24" }, { real: true });

// ── Keywords (test records only) ────────────────────────────────────────────
const kwList = await t("list_category_keywords", { category_id: TEST_CAT });
let kwC = grab(/ZZ MCP Test Keyword C \(keyword ID: (\d+)\)/, kwList);
if (!kwC) kwC = grab(/keyword ID: (\d+)/, await t("create_keyword", { category_id: TEST_CAT, name: "ZZ MCP Test Keyword C", description: "created by verify-live" }));
await t("update_category", { category_id: TEST_CAT, name: "ZZ MCP Test Category" });
await t("add_constituent_keyword", { constituent_id: TEST, keyword_id: Number(kwC) });
await t("get_constituent_keywords", { constituent_id: TEST });
await t("search_constituents", { keyword_id: Number(kwC) });
await t("remove_constituent_keyword", { constituent_id: TEST, keyword_id: Number(kwC) });
await t("remove_constituent_keyword", { constituent_id: TEST, keyword_id: Number(kwC) }); // not present any more
await t("batch_add_constituent_keyword", { keyword_id: Number(kwC), constituent_ids: [TEST, TEST, 1] });
await t("batch_remove_constituent_keyword", { keyword_id: Number(kwC), constituent_ids: [TEST, 1] });

// ── Groups ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
await t("update_group", { group_id: TEST_GROUP, name: "ZZ MCP Test Group" });
const add = await t("add_group_membership", { constituent_id: TEST, group_id: TEST_GROUP, date_start: TODAY });
const mid = Number(grab(/membership ID: (\d+)/, add));
await t("add_group_membership", { constituent_id: TEST, group_id: TEST_GROUP });   // should be refused as duplicate
if (mid) {
  await t("get_group_membership", { membership_id: mid });
  await t("update_group_membership", { membership_id: mid, date_end: TODAY });
}
await t("batch_add_group_membership", { group_id: TEST_GROUP, constituent_ids: [TEST, 1] });
const lm = await t("list_constituent_group_memberships", { constituent_id: TEST });
const current = [...lm.matchAll(/membership ID (\d+): group ZZ MCP Test Group.*\[current\]/g)].map((m) => Number(m[1]));
for (const id of current.slice(0, 1)) await t("remove_group_membership", { membership_id: id });
await t("delete_group", { group_id: TEST_GROUP, confirm_name: "ZZ MCP Test Group" });   // refused: has members
const tmp = await t("create_group", { name: "ZZ MCP Delete Me" });
const tmpId = Number(grab(/group ID: (\d+)/, tmp));
if (tmpId) {
  await t("delete_group", { group_id: tmpId, confirm_name: "wrong name" });              // refused
  await t("delete_group", { group_id: tmpId, confirm_name: "ZZ MCP Delete Me" });        // deleted
}

// ── Contact reports ───────────────────────────────────────────────────────
const c1 = await t("create_contact_report", { constituent_id: TEST, date: "2026-08-20", contact_report_type: "Call", summary: "verify-live 1", note: "verify-live: team_member by name", team_member: "Noah Mueller" });
await t("create_contact_report", { constituent_id: TEST, date: "2026-08-21", contact_report_type: "Email", note: "verify-live: legacy team_member_id param", team_member_id: NOAH });
await t("create_contact_report", { constituent_id: TEST, date: "2026-08-22", note: "verify-live: no team member" });
await t("create_contact_report", { constituent_id: TEST, date: "2026-08-23", note: "verify-live: bad team member", team_member: "Nobody Atall" });
const r1 = Number(grab(/ID: (\d+)/, c1));
if (r1) {
  await t("get_contact_report", { contact_report_id: r1 });
  await t("update_contact_report", { contact_report_id: r1, team_member: "nmueller@neighborhoodresilience.org", contact_report_type: "Meeting" });
}
const un = await t("list_contact_reports", { constituent_id: TEST, unattributed_only: true, ids_only: true, limit: 50 });
const unIds = (grab(/IDs: ([\d, ]+)/, un) || "").split(",").map((s) => Number(s.trim())).filter(Boolean);
if (unIds.length) await t("batch_update_contact_reports", { contact_report_ids: [...unIds, 999999999], team_member: NOAH });
await t("batch_create_contact_reports", {
  default_team_member: "Noah Mueller",
  reports: [
    { constituent_id: TEST, date: TODAY, note: "verify-live batch item 1", summary: "batch 1", contact_report_type: "Mailing" },
    { constituent_id: 1, date: TODAY, note: "verify-live batch item for a constituent that does not exist" },
    { constituent_id: TEST, date: TODAY, note: "verify-live batch item 3", team_member: "Kristina Abernathy" },
  ],
});
await t("list_contact_reports", { constituent_id: TEST, limit: 50, format: "text" });

console.log(`\nDone. ${results.calls.length} tool calls. Results: ${OUT}`);
await client.close();
process.exit(0);
