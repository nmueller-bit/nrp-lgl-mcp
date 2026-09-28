// verify-gifts.mjs — READ-ONLY live check of the gift tools added/fixed on 2026-09-28.
//   node scripts/verify-gifts.mjs            (after npm install)
// Writes scripts/verify-gifts-results.json. No writes to LGL. ~40 API calls.
// Output contains gift/constituent IDs, amounts and campaign names — no donor names or notes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "verify-gifts-results.json");
function findKey() {
  if (process.env.LGL_API_KEY) return process.env.LGL_API_KEY;
  const cands = [];
  if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, "Claude", "claude_desktop_config.json"));
  if (process.env.LOCALAPPDATA) {
    const pk = path.join(process.env.LOCALAPPDATA, "Packages");
    try { for (const d of fs.readdirSync(pk)) if (/^Claude/i.test(d)) cands.push(path.join(pk, d, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json")); } catch {}
  }
  for (const c of cands) { try { const k = JSON.parse(fs.readFileSync(c, "utf8"))?.mcpServers?.lgl?.env?.LGL_API_KEY; if (k && !/YOUR/i.test(k)) return k; } catch {} }
  return null;
}
process.env.LGL_API_KEY = findKey() || "";
if (!process.env.LGL_API_KEY) { console.error("No LGL_API_KEY found."); process.exit(1); }
process.env.MCP_NO_LISTEN = "1";
const { createServer } = await import("../index.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { resolveGiftType } = await import("../src/tools/gift-records.js");
const server = createServer();
const client = new Client({ name: "verify-gifts", version: "1.0.0" });
const [ct, st] = InMemoryTransport.createLinkedPair();
await server.connect(st); await client.connect(ct);
const results = { ran_at: new Date().toISOString(), calls: [] };
const save = () => fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
async function t(name, args = {}) {
  let text, isError = false;
  try { const r = await client.callTool({ name, arguments: args }); text = (r.content || []).map((c) => c.text).join("\n"); isError = !!r.isError; }
  catch (e) { text = `CLIENT ERROR: ${e.message}`; isError = true; }
  results.calls.push({ tool: name, args, isError, response: text });
  console.log(`\n=== ${name} ${JSON.stringify(args)}${isError ? "  [ERROR]" : ""}\n${text.slice(0, 900)}`);
  save(); return text;
}
await t("list_gift_types");
await t("list_gift_categories");
// How log_gift would now resolve the names callers use (no gift is written)
const resolved = {};
for (const n of ["Gift", "Pledge", "In-Kind", "Matching Gift", "Grant", "installment", "Bequest"]) {
  try { const g = await resolveGiftType(n); resolved[n] = `${g.name} (${g.id})`; } catch (e) { resolved[n] = `REFUSED: ${e.message.slice(0, 80)}…`; }
}
results.log_gift_type_resolution = resolved; console.log("\nlog_gift type resolution:", resolved); save();
const recent = await t("search_gifts", { date_from: "2026-09-20", date_to: "2026-09-28", limit: 3 });
const gid = Number((recent.match(/gift (\d+)/) || [])[1]);
if (gid) await t("get_gift", { gift_id: gid });
await t("get_gift", { gift_id: 951544 });                     // the Installment seen in probe 4 (campaign 892)
await t("get_constituent_gifts", { constituent_id: 946212, limit: 10 });
await t("get_constituent_gifts", { constituent_id: 946212, limit: 5, with_details: true });
await t("search_gifts", { date_from: "2026-01-01", date_to: "2026-09-28", campaign_id: 892, limit: 10, max_scan: 2100 });
await t("search_gifts", { date_from: "2026-01-01", date_to: "2026-09-28", gift_type_id: 7, include_pledges: true, limit: 5, max_scan: 2100 });
await t("giving_report", { date_from: "2026-09-01", date_to: "2026-09-28" });
console.log(`\nDone. Results: ${OUT}`);
await client.close(); process.exit(0);
