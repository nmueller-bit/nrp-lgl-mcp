import express from "express";
import fetch from "node-fetch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

const LGL_API_KEY = process.env.LGL_API_KEY;
const PORT = process.env.PORT || 3000;

if (!LGL_API_KEY) {
  console.error("ERROR: LGL_API_KEY environment variable is not set.");
  process.exit(1);
}

// ── LGL API helper ────────────────────────────────────────────────────────────
async function lgl(method, path, params = {}, body = null) {
  let url = `https://api.littlegreenlight.com/api/v1${path}`;
  if (method === "GET" && Object.keys(params).length > 0) {
    url += "?" + new URLSearchParams(params).toString();
  }
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${LGL_API_KEY}`,
      "Content-Type": "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(`LGL API error ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "nrp-lgl-mcp",
  version: "1.0.0",
});

// SEARCH CONSTITUENTS
server.tool(
  "search_constituents",
  "Search for donors/constituents in Little Green Light by name, email, or other criteria",
  {
    query: z.string().describe("Name, email, or other search term"),
    limit: z.number().optional().default(10).describe("Max results to return"),
  },
  async ({ query, limit }) => {
    const data = await lgl("GET", "/constituents", { q: query, limit });
    const items = data.items || [];
    if (items.length === 0) return { content: [{ type: "text", text: `No constituents found matching "${query}".` }] };
    const summary = items.map(c =>
      `• ${c.first_name || ""} ${c.last_name || ""} (ID: ${c.id})` +
      (c.email_addresses?.[0]?.email_address ? ` — ${c.email_addresses[0].email_address}` : "") +
      (c.gift_total ? ` — Lifetime giving: $${c.gift_total}` : "")
    ).join("\n");
    return { content: [{ type: "text", text: `Found ${data.total_items} result(s):\n\n${summary}` }] };
  }
);

// GET CONSTITUENT DETAILS
server.tool(
  "get_constituent",
  "Get full details for a specific donor/constituent by their LGL ID",
  { constituent_id: z.number().describe("The LGL constituent ID") },
  async ({ constituent_id }) => {
    const data = await lgl("GET", `/constituents/${constituent_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// CREATE CONSTITUENT
server.tool(
  "create_constituent",
  "Create a new donor/constituent in Little Green Light",
  {
    first_name: z.string().describe("First name"),
    last_name: z.string().describe("Last name"),
    email: z.string().optional().describe("Email address"),
    phone: z.string().optional().describe("Phone number"),
    is_org: z.boolean().optional().default(false).describe("Is this an organization?"),
    org_name: z.string().optional().describe("Organization name if is_org is true"),
  },
  async ({ first_name, last_name, email, phone, is_org, org_name }) => {
    const body = { first_name, last_name, is_org };
    if (org_name) body.org_name = org_name;
    if (email) body.email_addresses = [{ email_address: email, is_primary: true }];
    if (phone) body.phone_numbers = [{ number: phone, is_primary: true }];
    const data = await lgl("POST", "/constituents", {}, body);
    return { content: [{ type: "text", text: `Created constituent: ${data.first_name} ${data.last_name} (ID: ${data.id})` }] };
  }
);

// LOG A GIFT
server.tool(
  "log_gift",
  "Log a gift/donation in Little Green Light for an existing constituent",
  {
    constituent_id: z.number().describe("LGL constituent ID of the donor"),
    amount: z.number().describe("Gift amount in dollars"),
    gift_date: z.string().describe("Date of gift in YYYY-MM-DD format"),
    payment_type: z.enum(["check", "cash", "credit_card", "stock", "in_kind", "wire", "online", "other"]).default("check"),
    check_number: z.string().optional().describe("Check reference number"),
    deposit_date: z.string().optional().describe("Deposit date in YYYY-MM-DD format"),
    fund_id: z.number().optional().describe("LGL Fund ID"),
    campaign_id: z.number().optional().describe("LGL Campaign ID"),
    appeal_id: z.number().optional().describe("LGL Appeal ID"),
    gift_type: z.string().optional().describe("Gift type e.g. donation, pledge, in_kind"),
    team_member_id: z.number().optional().describe("LGL team member ID"),
    is_anonymous: z.boolean().optional().default(false).describe("Whether the gift is anonymous"),
    tribute_name: z.string().optional().describe("Name of person being honored/memorialized"),
    tribute_type: z.string().optional().describe("in_honor_of or in_memory_of"),
    acknowledgment_template_id: z.number().optional().describe("Acknowledgment template ID"),
    note: z.string().optional().describe("Internal note"),
    category_ids: z.array(z.number()).optional().describe("Gift category keyword IDs"),
  },
  async (params) => {
    const body = {
      constituent_id: params.constituent_id,
      amount: params.amount,
      gift_date: params.gift_date,
      payment_type: params.payment_type,
      is_anonymous: params.is_anonymous || false,
    };
    if (params.check_number) body.check_number = params.check_number;
    if (params.deposit_date) body.deposit_date = params.deposit_date;
    if (params.fund_id) body.fund_id = params.fund_id;
    if (params.campaign_id) body.campaign_id = params.campaign_id;
    if (params.appeal_id) body.appeal_id = params.appeal_id;
    if (params.gift_type) body.gift_type = params.gift_type;
    if (params.team_member_id) body.team_member_id = params.team_member_id;
    if (params.tribute_name) body.tribute_name = params.tribute_name;
    if (params.tribute_type) body.tribute_type = params.tribute_type;
    if (params.acknowledgment_template_id) body.acknowledgment_template_id = params.acknowledgment_template_id;
    if (params.note) body.note = params.note;
    if (params.category_ids?.length) body.custom_fields = params.category_ids.map(id => ({ id }));
    const data = await lgl("POST", "/gifts", {}, body);
    return { content: [{ type: "text", text: `Gift logged! ID: ${data.id} — $${data.amount} on ${data.gift_date}` }] };
  }
);

// GET CONSTITUENT GIFTS
server.tool(
  "get_constituent_gifts",
  "Get giving history for a specific donor",
  {
    constituent_id: z.number().describe("LGL constituent ID"),
    limit: z.number().optional().default(25),
  },
  async ({ constituent_id, limit }) => {
    const data = await lgl("GET", `/constituents/${constituent_id}/gifts`, { limit });
    const items = data.items || [];
    if (items.length === 0) return { content: [{ type: "text", text: "No gifts found." }] };
    const total = items.reduce((s, g) => s + (g.amount || 0), 0);
    const summary = items.map(g =>
      `• $${g.amount} on ${g.gift_date} (${g.payment_type || "unknown"})` +
      (g.fund_name ? ` — ${g.fund_name}` : "") +
      (g.campaign_name ? ` / ${g.campaign_name}` : "")
    ).join("\n");
    return { content: [{ type: "text", text: `${items.length} gift(s) — Total: $${total.toFixed(2)}\n\n${summary}` }] };
  }
);

// LIST GIFTS
server.tool(
  "list_gifts",
  "List recent gifts across the entire NRP LGL account",
  {
    limit: z.number().optional().default(25),
    updated_from: z.string().optional().describe("Filter gifts updated after this date YYYY-MM-DD"),
  },
  async ({ limit, updated_from }) => {
    const params = { limit };
    if (updated_from) params.updated_from = updated_from;
    const data = await lgl("GET", "/gifts", params);
    const items = data.items || [];
    if (items.length === 0) return { content: [{ type: "text", text: "No gifts found." }] };
    const total = items.reduce((s, g) => s + (g.amount || 0), 0);
    const summary = items.map(g =>
      `• ${g.constituent_name || "Unknown"} — $${g.amount} on ${g.gift_date}` +
      (g.payment_type ? ` (${g.payment_type})` : "") +
      (g.fund_name ? ` — ${g.fund_name}` : "")
    ).join("\n");
    return { content: [{ type: "text", text: `${items.length} gift(s) — Total: $${total.toFixed(2)}\n\n${summary}` }] };
  }
);

// LIST FUNDS
server.tool("list_funds", "List all funds in NRP LGL", {}, async () => {
  const data = await lgl("GET", "/funds", { limit: 100 });
  const items = data.items || [];
  return { content: [{ type: "text", text: items.map(f => `• ${f.name} (ID: ${f.id})`).join("\n") }] };
});

// LIST CAMPAIGNS
server.tool("list_campaigns", "List all campaigns in NRP LGL", {}, async () => {
  const data = await lgl("GET", "/campaigns", { limit: 100 });
  const items = data.items || [];
  return { content: [{ type: "text", text: items.map(c => `• ${c.name} (ID: ${c.id})`).join("\n") }] };
});

// LIST APPEALS
server.tool("list_appeals", "List all appeals in NRP LGL", {}, async () => {
  const data = await lgl("GET", "/appeals", { limit: 100 });
  const items = data.items || [];
  return { content: [{ type: "text", text: items.map(a => `• ${a.name} (ID: ${a.id})`).join("\n") }] };
});

// LIST GIFT CATEGORIES
server.tool("list_gift_categories", "List all gift categories and keywords in LGL", {}, async () => {
  const data = await lgl("GET", "/categories", { item_type: "Gift", limit: 100 });
  const items = data.items || [];
  if (items.length === 0) return { content: [{ type: "text", text: "No gift categories found." }] };
  const summary = items.map(cat =>
    `• ${cat.name} (ID: ${cat.id})\n` +
    (cat.keywords || []).map(k => `    ◦ ${k.name} (ID: ${k.id})`).join("\n")
  ).join("\n");
  return { content: [{ type: "text", text: summary }] };
});

// LIST TEAM MEMBERS
server.tool("list_team_members", "List all team members in NRP LGL", {}, async () => {
  const data = await lgl("GET", "/team_members", { limit: 100 });
  const items = data.items || [];
  return { content: [{ type: "text", text: items.map(m => `• ${m.first_name} ${m.last_name} (ID: ${m.id})`).join("\n") }] };
});

// LIST ACK TEMPLATES
server.tool("list_acknowledgment_templates", "List all acknowledgment letter templates in LGL", {}, async () => {
  const data = await lgl("GET", "/acknowledgment_templates", { limit: 100 });
  const items = data.items || [];
  if (items.length === 0) return { content: [{ type: "text", text: "No acknowledgment templates found." }] };
  return { content: [{ type: "text", text: items.map(t => `• ${t.name} (ID: ${t.id})`).join("\n") }] };
});

// GIVING REPORT
server.tool(
  "giving_report",
  "Generate a giving summary report — totals, averages, breakdown by fund/campaign, top donors",
  {
    limit: z.number().optional().default(100),
    updated_from: z.string().optional().describe("Start date filter YYYY-MM-DD"),
  },
  async ({ limit, updated_from }) => {
    const params = { limit };
    if (updated_from) params.updated_from = updated_from;
    const data = await lgl("GET", "/gifts", params);
    const gifts = data.items || [];
    if (gifts.length === 0) return { content: [{ type: "text", text: "No gifts found." }] };
    const total = gifts.reduce((s, g) => s + (g.amount || 0), 0);
    const byFund = {}, byCampaign = {}, byDonor = {};
    gifts.forEach(g => {
      const fund = g.fund_name || "Undesignated";
      byFund[fund] = (byFund[fund] || 0) + (g.amount || 0);
      const camp = g.campaign_name || "No Campaign";
      byCampaign[camp] = (byCampaign[camp] || 0) + (g.amount || 0);
      const donor = g.constituent_name || "Unknown";
      byDonor[donor] = (byDonor[donor] || 0) + (g.amount || 0);
    });
    const fmt = obj => Object.entries(obj).sort((a,b) => b[1]-a[1]).map(([n,a]) => `  ${n}: $${a.toFixed(2)}`).join("\n");
    return { content: [{ type: "text", text:
      `NRP Giving Report (${gifts.length} gifts)\n\n` +
      `TOTAL: $${total.toFixed(2)}\nCOUNT: ${gifts.length}\nAVERAGE: $${(total/gifts.length).toFixed(2)}\n\n` +
      `BY FUND:\n${fmt(byFund)}\n\nBY CAMPAIGN:\n${fmt(byCampaign)}\n\nTOP DONORS:\n${fmt(byDonor).split("\n").slice(0,5).join("\n")}`
    }] };
  }
);

// ── Express + SSE ─────────────────────────────────────────────────────────────
const app = express();
const transports = {};

// This tells Claude no OAuth is needed
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.status(404).json({ error: "OAuth not supported — this server uses API key auth" });
});

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => delete transports[transport.sessionId]);
  await server.connect(transport);
});

app.post("/messages", express.json(), async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) return res.status(400).json({ error: "No active session" });
  await transport.handlePostMessage(req, res);
});

app.get("/health", (req, res) => res.json({ status: "ok", service: "nrp-lgl-mcp" }));

app.listen(PORT, () => console.log(`NRP LGL MCP server running on port ${PORT}`));
