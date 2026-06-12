import express from "express";
import fetch from "node-fetch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";
import multer from "multer";
import mammoth from "mammoth";

// ESM __dirname shim
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// CJS interop for pdf-parse (avoids ESM import issues)
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

const LGL_API_KEY      = process.env.LGL_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT             = process.env.PORT || 3000;
const BASE_URL         = process.env.BASE_URL || "https://nrp-lgl-mcp-production-7625.up.railway.app";
const ARTIFACT_TOKEN   = process.env.ARTIFACT_TOKEN || "nrp-artifact-token";

if (!LGL_API_KEY) {
  console.error("ERROR: LGL_API_KEY environment variable is not set.");
  process.exit(1);
}

// Multer: in-memory storage, 15 MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

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

// ── Anthropic transcript parser ───────────────────────────────────────────────
async function parseWithClaude(text) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not configured on the server. Ask Noah to add it as a Railway environment variable."
    );
  }
  const today = new Date().toISOString().slice(0, 10);
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: `Extract structured information from this meeting summary or transcript for a nonprofit donor CRM contact report.

Return ONLY a valid JSON object with exactly these four fields:
{
  "date": "YYYY-MM-DD",
  "contact_type": "Meeting",
  "summary": "2-4 sentence narrative in plain prose",
  "full_text": "complete input text"
}

Rules:
- "date": find the meeting date. Look for a "Date:" line in Meeting Information or similar. If not found, use today: ${today}. Return YYYY-MM-DD only.
- "contact_type": "Meeting" unless clearly a phone call (→ "Call"), email thread (→ "Email"), etc.
- "summary": write as a CRM note a development officer would be proud of. 2-4 sentences covering the key topics discussed, any decisions made, and important next steps. Past tense. Be specific — reference actual topics from the text.
- "full_text": the complete input text with only leading/trailing whitespace removed.
- Return ONLY the JSON object. No markdown fences, no explanation, nothing else.

Input text:
${text.slice(0, 14000)}`,
      }],
    }),
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`Anthropic API error ${r.status}: ${errText.slice(0, 200)}`);
  }
  const data = await r.json();
  const raw = data.content?.[0]?.text || "";
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI response could not be parsed as JSON. Please try again.");
  return JSON.parse(match[0]);
}

// ── MCP Server ────────────────────────────────────────────────────────────────
function createServer() {
  const server = new McpServer({ name: "nrp-lgl-mcp", version: "1.0.0" });

  server.tool("search_constituents", "Search for donors/constituents in Little Green Light by name, email, or other criteria", {
    query: z.string().describe("Name, email, or other search term"),
    limit: z.number().optional().default(10),
  }, async ({ query, limit }) => {
    const res = await fetch(
      `https://api.littlegreenlight.com/api/v1/constituents/search?q[]=name=${encodeURIComponent(query)}&limit=${limit}`,
      { headers: { Authorization: `Bearer ${LGL_API_KEY}`, "Content-Type": "application/json" } }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(`LGL API error ${res.status}: ${JSON.stringify(data)}`);
    const items = data.items || [];
    if (!items.length) return { content: [{ type: "text", text: `No constituents found matching "${query}".` }] };
    const summary = items.map(c =>
      `• ${c.first_name || ""} ${c.last_name || ""} (ID: ${c.id})` +
      (c.email_addresses?.[0]?.email_address ? ` — ${c.email_addresses[0].email_address}` : "") +
      (c.gift_total ? ` — Lifetime giving: $${c.gift_total}` : "")
    ).join("\n");
    return { content: [{ type: "text", text: `Found ${data.total_items} result(s):\n\n${summary}` }] };
  });

  server.tool("get_constituent", "Get full details for a specific donor by their LGL ID", {
    constituent_id: z.number(),
  }, async ({ constituent_id }) => {
    const data = await lgl("GET", `/constituents/${constituent_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  server.tool("create_constituent", "Create a new donor/constituent in Little Green Light", {
    first_name: z.string(),
    last_name: z.string(),
    email: z.string().optional(),
    phone: z.string().optional(),
    is_org: z.boolean().optional().default(false),
    org_name: z.string().optional(),
  }, async ({ first_name, last_name, email, phone, is_org, org_name }) => {
    const body = { first_name, last_name, is_org };
    if (org_name) body.org_name = org_name;
    if (email) body.email_addresses = [{ email_address: email, is_primary: true }];
    if (phone) body.phone_numbers = [{ number: phone, is_primary: true }];
    const data = await lgl("POST", "/constituents", {}, body);
    return { content: [{ type: "text", text: `Created constituent: ${data.first_name} ${data.last_name} (ID: ${data.id})` }] };
  });

  server.tool("log_gift", "Log a gift/donation in Little Green Light for an existing constituent", {
    constituent_id: z.number(),
    amount: z.number(),
    gift_date: z.string().describe("YYYY-MM-DD"),
    payment_type: z.enum(["check", "cash", "credit_card", "stock", "in_kind", "wire", "online", "other"]).default("check"),
    check_number: z.string().optional(),
    deposit_date: z.string().optional().describe("YYYY-MM-DD"),
    fund_id: z.number().optional(),
    campaign_id: z.number().optional(),
    appeal_id: z.number().optional(),
    gift_type: z.string().optional(),
    team_member_id: z.number().optional(),
    is_anonymous: z.boolean().optional().default(false),
    tribute_name: z.string().optional(),
    tribute_type: z.string().optional().describe("in_honor_of or in_memory_of"),
    acknowledgment_template_name: z.string().optional().describe("Mailing template name to use for acknowledgment (use 'do_not_ack' to skip)"),
    note: z.string().optional(),
    category_ids: z.array(z.number()).optional(),
  }, async (params) => {
    const giftTypeName = params.gift_type || "Gift";
    const typeIds = { "Gift": 1, "Pledge": 2, "Matching Gift": 3, "In-Kind": 5, "Bequest": 6, "Grant": 1 };
    const payTypeNames = { "check": "Check", "cash": "Cash", "credit_card": "Credit Card", "stock": "Stock", "in_kind": "In Kind", "wire": "Wire", "online": "Credit Card", "other": "Check" };
    const body = {
      received_amount: params.amount,
      received_date: params.gift_date,
      gift_type_id: typeIds[giftTypeName] || 1,
      gift_type_name: giftTypeName,
      payment_type_name: payTypeNames[params.payment_type] || "Check",
      is_anon: params.is_anonymous || false,
    };
    if (params.check_number) body.check_number = params.check_number;
    if (params.deposit_date) body.deposit_date = params.deposit_date;
    if (params.fund_id) body.fund_id = params.fund_id;
    if (params.campaign_id) body.campaign_id = params.campaign_id;
    if (params.appeal_id) body.appeal_id = params.appeal_id;
    if (params.note) body.note = params.note;
    if (params.tribute_name) body.tribute_name = params.tribute_name;
    if (params.acknowledgment_template_name) body.ack_template_name = params.acknowledgment_template_name;
    const data = await lgl("POST", `/constituents/${params.constituent_id}/gifts`, {}, body);
    return { content: [{ type: "text", text: `Gift logged! ID: ${data.id} — $${data.received_amount} on ${data.received_date}` }] };
  });

  server.tool("get_constituent_gifts", "Get giving history for a specific donor", {
    constituent_id: z.number(),
    limit: z.number().optional().default(25),
  }, async ({ constituent_id, limit }) => {
    const data = await lgl("GET", `/constituents/${constituent_id}/gifts`, { limit });
    const items = data.items || [];
    if (!items.length) return { content: [{ type: "text", text: "No gifts found." }] };
    const total = items.reduce((s, g) => s + (g.received_amount || g.amount || 0), 0);
    const summary = items.map(g =>
      `• $${g.received_amount ?? g.amount} on ${g.received_date ?? g.date} (${g.payment_type_name || "unknown"})` +
      (g.fund_name ? ` — ${g.fund_name}` : "") +
      (g.campaign_name ? ` / ${g.campaign_name}` : "")
    ).join("\n");
    return { content: [{ type: "text", text: `${items.length} gift(s) — Total: $${total.toFixed(2)}\n\n${summary}` }] };
  });

  server.tool("list_funds", "List all funds in NRP LGL", {}, async () => {
    const data = await lgl("GET", "/funds", { limit: 100 });
    const items = data.items || [];
    return { content: [{ type: "text", text: items.map(f => `• ${f.name} (ID: ${f.id})`).join("\n") }] };
  });

  server.tool("list_campaigns", "List all campaigns in NRP LGL", {}, async () => {
    const data = await lgl("GET", "/campaigns", { limit: 100 });
    const items = data.items || [];
    return { content: [{ type: "text", text: items.map(c => `• ${c.name} (ID: ${c.id})`).join("\n") }] };
  });

  server.tool("list_appeals", "List all appeals in NRP LGL", {}, async () => {
    const data = await lgl("GET", "/appeals", { limit: 100 });
    const items = data.items || [];
    return { content: [{ type: "text", text: items.map(a => `• ${a.name} (ID: ${a.id})`).join("\n") }] };
  });

  server.tool("list_gift_categories", "List all gift categories and keywords in LGL", {}, async () => {
    const data = await lgl("GET", "/categories", { item_type: "Gift", limit: 100 });
    const items = data.items || [];
    if (!items.length) return { content: [{ type: "text", text: "No gift categories found." }] };
    const summary = items.map(cat =>
      `• ${cat.name} (ID: ${cat.id})\n` +
      (cat.keywords || []).map(k => `    ◦ ${k.name} (ID: ${k.id})`).join("\n")
    ).join("\n");
    return { content: [{ type: "text", text: summary }] };
  });

  server.tool("list_team_members", "List all team members in NRP LGL", {}, async () => {
    const data = await lgl("GET", "/team_members", { limit: 100 });
    const items = data.items || [];
    return { content: [{ type: "text", text: items.map(m => `• ${m.first_name} ${m.last_name} (ID: ${m.id})`).join("\n") }] };
  });

  server.tool("list_acknowledgment_templates", "List all acknowledgment letter templates in LGL", {}, async () => {
    const data = await lgl("GET", "/mailing_templates", { limit: 100 });
    const items = data.items || [];
    if (!items.length) return { content: [{ type: "text", text: "No acknowledgment templates found." }] };
    return { content: [{ type: "text", text: items.map(t => `• ${t.name} (ID: ${t.id})`).join("\n") }] };
  });

  server.tool("create_contact_report", "Log a contact report for a constituent in Little Green Light", {
    constituent_id: z.number().describe("LGL constituent ID"),
    date: z.string().describe("Date of contact, YYYY-MM-DD"),
    contact_report_type: z.enum(["Call", "Email", "Meeting", "Mailing", "Proposal", "Other"]).default("Meeting"),
    summary: z.string().optional().describe("Short one-line summary"),
    note: z.string().describe("Full details / body of the contact report"),
    team_member_id: z.number().optional().describe("LGL team member ID"),
    hours: z.number().optional().describe("Hours spent"),
  }, async (params) => {
    try {
      const body = {
        date: params.date,  // confirmed working field name (not contact_date)
        contact_report_type: params.contact_report_type,
        note: params.note,
      };
      if (params.summary) body.summary = params.summary;
      if (params.team_member_id) body.team_member_id = params.team_member_id;
      if (params.hours != null) body.hours = params.hours;
      const data = await lgl("POST", `/constituents/${params.constituent_id}/contact_reports`, {}, body);
      return { content: [{ type: "text", text: `Contact report logged! ID: ${data.id} — ${params.contact_report_type} on ${params.date}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `LGL_ERROR: ${err.message}` }] };
    }
  });

  server.tool("list_contact_reports", "List contact reports for a constituent — useful for inspecting the API response schema", {
    constituent_id: z.number().describe("LGL constituent ID"),
    limit: z.number().optional().default(5),
  }, async ({ constituent_id, limit }) => {
    const data = await lgl("GET", `/constituents/${constituent_id}/contact_reports`, { limit });
    const items = data.items || [];
    if (!items.length) return { content: [{ type: "text", text: "No contact reports found." }] };
    return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
  });

  server.tool("giving_report", "Generate a giving summary — totals, averages, breakdown by fund/campaign, top donors", {
    limit: z.number().optional().default(100),
    updated_from: z.string().optional().describe("Start date YYYY-MM-DD"),
  }, async ({ limit, updated_from }) => {
    const params = { limit };
    if (updated_from) params.updated_from = updated_from;
    const data = await lgl("GET", "/gifts", params);
    const gifts = data.items || [];
    if (!gifts.length) return { content: [{ type: "text", text: "No gifts found." }] };
    const total = gifts.reduce((s, g) => s + (g.received_amount || g.amount || 0), 0);
    const byFund = {}, byCampaign = {}, byDonor = {};
    gifts.forEach(g => {
      const amt = g.received_amount || g.amount || 0;
      const fund = g.fund_name || "Undesignated";
      byFund[fund] = (byFund[fund] || 0) + amt;
      const camp = g.campaign_name || "No Campaign";
      byCampaign[camp] = (byCampaign[camp] || 0) + amt;
      const donor = g.constituent_name || "Unknown";
      byDonor[donor] = (byDonor[donor] || 0) + amt;
    });
    const fmt = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([n, a]) => `  ${n}: $${a.toFixed(2)}`).join("\n");
    return { content: [{ type: "text", text:
      `NRP Giving Report (${gifts.length} gifts)\n\n` +
      `TOTAL: $${total.toFixed(2)}\nCOUNT: ${gifts.length}\nAVERAGE: $${(total / gifts.length).toFixed(2)}\n\n` +
      `BY FUND:\n${fmt(byFund)}\n\nBY CAMPAIGN:\n${fmt(byCampaign)}\n\nTOP DONORS:\n${fmt(byDonor).split("\n").slice(0, 5).join("\n")}`
    }] };
  });

  return server;
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Auth middleware
function checkToken(req, res, next) {
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${ARTIFACT_TOKEN}`) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ── Existing REST endpoints ───────────────────────────────────────────────────

// GET /api/reference — all dropdown data in one call
app.get("/api/reference", checkToken, async (req, res) => {
  try {
    const [campaigns, funds, appeals, templates] = await Promise.all([
      lgl("GET", "/campaigns", { limit: 100 }),
      lgl("GET", "/funds", { limit: 100 }),
      lgl("GET", "/appeals", { limit: 100 }),
      lgl("GET", "/mailing_templates", { limit: 100 }),
    ]);
    res.json({
      campaigns: (campaigns.items || []).map(c => ({ id: c.id, name: c.name })),
      funds:     (funds.items     || []).map(f => ({ id: f.id, name: f.name })),
      appeals:   (appeals.items   || []).map(a => ({ id: a.id, name: a.name })),
      templates: (templates.items || []).map(t => ({ id: t.id, name: t.name })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/search?q=
app.get("/api/search", checkToken, async (req, res) => {
  try {
    const q = req.query.q || "";
    const r = await fetch(
      `https://api.littlegreenlight.com/api/v1/constituents/search?q[]=name=${encodeURIComponent(q)}&limit=10`,
      { headers: { Authorization: `Bearer ${LGL_API_KEY}`, "Content-Type": "application/json" } }
    );
    const data = await r.json();
    const items = (data.items || []).map(c => ({
      id: c.id,
      name: `${c.first_name || ""} ${c.last_name || ""}`.trim(),
      email: c.email_addresses?.[0]?.email_address || "",
      gift_total: c.gift_total || 0,
    }));
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/constituents
app.post("/api/constituents", express.json(), checkToken, async (req, res) => {
  try {
    const { first_name, last_name, email, phone } = req.body;
    const body = { first_name, last_name, is_org: false };
    if (email) body.email_addresses = [{ email_address: email, is_primary: true }];
    if (phone) body.phone_numbers = [{ number: phone, is_primary: true }];
    const data = await lgl("POST", "/constituents", {}, body);
    res.json({ id: data.id, name: `${data.first_name} ${data.last_name}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/gifts
app.post("/api/gifts", express.json(), checkToken, async (req, res) => {
  try {
    const p = req.body;
    const giftTypeName = p.gift_type || "Gift";
    const typeIds = { Gift: 1, Pledge: 2, "Matching Gift": 3, "In-Kind Gift": 5, Bequest: 6 };
    const payTypeNames = { check: "Check", cash: "Cash", credit_card: "Credit Card", stock: "Stock", in_kind: "In Kind", wire: "Wire", online: "Credit Card", other: "Check" };
    const body = {
      received_amount: p.amount,
      received_date: p.gift_date,
      gift_type_id: typeIds[giftTypeName] || 1,
      gift_type_name: giftTypeName,
      payment_type_name: payTypeNames[p.payment_type] || "Check",
      is_anon: p.is_anonymous || false,
    };
    if (p.check_number)      body.check_number      = p.check_number;
    if (p.deposit_date)      body.deposit_date      = p.deposit_date;
    if (p.fund_id)           body.fund_id           = p.fund_id;
    if (p.campaign_id)       body.campaign_id       = p.campaign_id;
    if (p.appeal_id)         body.appeal_id         = p.appeal_id;
    if (p.note)              body.note              = p.note;
    if (p.tribute_name)      body.tribute_name      = p.tribute_name;
    if (p.ack_template_name) body.ack_template_name = p.ack_template_name;
    const data = await lgl("POST", `/constituents/${p.constituent_id}/gifts`, {}, body);
    res.json({ id: data.id, amount: data.received_amount, date: data.received_date });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Contact Logger REST endpoints ─────────────────────────────────────────────

// GET /api/team-members
app.get("/api/team-members", checkToken, async (req, res) => {
  try {
    const data = await lgl("GET", "/team_members", { limit: 100 });
    const items = (data.items || []).map(m => ({
      id: m.id,
      first_name: m.first_name || "",
      last_name:  m.last_name  || "",
    }));
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/parse-transcript — text body → Claude → structured fields
app.post("/api/parse-transcript", express.json(), checkToken, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: "text is required" });
    const result = await parseWithClaude(text);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/parse-file — multipart upload (docx or pdf) → extract text → Claude
app.post("/api/parse-file", checkToken, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const { originalname, mimetype, buffer } = req.file;
    let text = "";

    const isDocx = originalname?.toLowerCase().endsWith(".docx") ||
                   mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const isPdf  = originalname?.toLowerCase().endsWith(".pdf") ||
                   mimetype === "application/pdf";

    if (isDocx) {
      const extracted = await mammoth.extractRawText({ buffer });
      text = extracted.value;
    } else if (isPdf) {
      const extracted = await pdfParse(buffer);
      text = extracted.text;
    } else {
      return res.status(400).json({ error: "Unsupported file type. Please upload a .docx or .pdf file." });
    }

    if (!text?.trim()) return res.status(400).json({ error: "Could not extract text from the uploaded file." });
    const result = await parseWithClaude(text);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/contact-reports — create contact report in LGL
app.post("/api/contact-reports", express.json(), checkToken, async (req, res) => {
  try {
    const p = req.body;
    if (!p.constituent_id) return res.status(400).json({ error: "constituent_id required" });
    if (!p.date)           return res.status(400).json({ error: "date required" });
    if (!p.note)           return res.status(400).json({ error: "note required" });

    const body = {
      date: p.date,
      contact_report_type: p.contact_report_type || "Meeting",
      note: p.note,
    };
    if (p.summary)        body.summary        = p.summary;
    if (p.team_member_id) body.team_member_id = p.team_member_id;

    const data = await lgl("POST", `/constituents/${p.constituent_id}/contact_reports`, {}, body);
    res.json({ id: data.id, date: data.date || data.contact_date });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Static files + contact logger route ──────────────────────────────────────
app.use(express.static(join(__dirname, "public")));
app.get("/contact-logger", (req, res) => {
  res.sendFile(join(__dirname, "public", "contact-logger.html"));
});

// ── MCP endpoint ──────────────────────────────────────────────────────────────
app.post("/mcp", express.json(), async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createServer();
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", (req, res) => res.status(405).json({ error: "MCP requires POST" }));
app.get("/health", (req, res) => res.json({ status: "ok", service: "nrp-lgl-mcp" }));

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/oauth/authorize`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
  });
});

app.get("/oauth/authorize", (req, res) => {
  const { redirect_uri, state } = req.query;
  if (!redirect_uri) return res.status(400).send("Missing redirect_uri");
  const code = `nrp_code_${Date.now()}`;
  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(url.toString());
});

app.post("/oauth/token", express.urlencoded({ extended: true }), express.json(), (req, res) => {
  res.json({ access_token: "nrp-mcp-access-token", token_type: "bearer", expires_in: 86400 });
});

app.listen(PORT, () => console.log(`NRP LGL MCP server running on port ${PORT}`));
