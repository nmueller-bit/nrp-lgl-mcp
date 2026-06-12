#!/usr/bin/env node
/**
 * Little Green Light MCP Server
 *
 * Connects Claude to your Little Green Light nonprofit CRM.
 * Supports searching constituents, recording gifts, listing campaigns/appeals, and more.
 *
 * Setup: Set the LGL_API_KEY environment variable to your LGL API key.
 * Get your key: LGL account → Settings → Integration Settings → LGL API
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios, { AxiosError } from "axios";
// ── Constants ─────────────────────────────────────────────────────────────────
const API_BASE_URL = "https://api.littlegreenlight.com/api/v1";
const CHARACTER_LIMIT = 25000;
const API_KEY = process.env.LGL_API_KEY;
// ── Shared Utilities ──────────────────────────────────────────────────────────
async function apiRequest(endpoint, method = "GET", data, params) {
    const response = await axios({
        method,
        url: `${API_BASE_URL}/${endpoint}`,
        data,
        params,
        timeout: 30000,
        headers: {
            Authorization: `Bearer ${API_KEY}`,
            "Content-Type": "application/json",
            Accept: "application/json",
        },
    });
    return response.data;
}
function handleError(error) {
    if (error instanceof AxiosError && error.response) {
        const { status, data } = error.response;
        if (status === 401)
            return "Error: Invalid or missing API key. Check your LGL_API_KEY environment variable.";
        if (status === 403)
            return "Error: Permission denied. You don't have access to this resource.";
        if (status === 404)
            return "Error: Resource not found. Double-check the ID is correct.";
        if (status === 422)
            return `Error: Validation failed — ${JSON.stringify(data)}`;
        if (status === 429)
            return "Error: Rate limit exceeded (300 calls / 5 min). Please wait before retrying.";
        return `Error: API returned status ${status}: ${JSON.stringify(data)}`;
    }
    if (error instanceof AxiosError && error.code === "ECONNABORTED")
        return "Error: Request timed out. Please try again.";
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
}
function truncate(text) {
    if (text.length > CHARACTER_LIMIT) {
        return (text.slice(0, CHARACTER_LIMIT) +
            "\n\n[Response truncated. Use 'offset' to paginate and see more results.]");
    }
    return text;
}
function toJson(data) {
    return truncate(JSON.stringify(data, null, 2));
}
// ── Server ────────────────────────────────────────────────────────────────────
const server = new McpServer({
    name: "lgl-mcp-server",
    version: "1.0.0",
});
// ── Constituents ──────────────────────────────────────────────────────────────
server.registerTool("lgl_search_constituents", {
    title: "Search Constituents",
    description: `Search for constituents (donors, volunteers, contacts) in Little Green Light.

Supports searching by name, email, phone, city, state, postal code, and more.
Multiple criteria can be combined with semicolons.

Args:
  - query (string, required): Search string in "field=value" format. Examples:
      "name=Smith"           — anyone named Smith
      "eaddr=jane@email.com" — search by email
      "phone_number=617"     — search by phone prefix
      "city=Boston;state=MA" — city AND state
      "constituent_type=0"   — individuals only (0=individual, 1=org)
      "updated_from=2024-01-01T00:00:00Z" — updated since date
  - expand (string, optional): Comma-separated expansions to include in results:
      email_addresses, phone_numbers, street_addresses, categories, relationships
  - sort (string, optional): Sort field. Options: name, date_created, date_updated
      Add ! to reverse order, e.g., "name!" for Z→A
  - limit (number, default 25): Results per page, max 100
  - offset (number, default 0): Pagination offset

Returns: Paginated list with total_items count. Each constituent includes
  id, first_name, last_name, org_name, is_org, addressee, salutation, and any expansions requested.`,
    inputSchema: z
        .object({
        query: z
            .string()
            .describe('Search query, e.g., "name=Smith" or "eaddr=test@example.com"'),
        expand: z
            .string()
            .optional()
            .describe("Comma-separated: email_addresses,phone_numbers,street_addresses,categories,relationships"),
        sort: z
            .string()
            .optional()
            .describe("Sort field, e.g., 'name' or 'date_updated!'"),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
    })
        .strict(),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
}, async (params) => {
    try {
        const queryParams = {
            "q[]": params.query,
            limit: params.limit,
            offset: params.offset,
        };
        if (params.expand)
            queryParams.expand = params.expand;
        if (params.sort)
            queryParams.sort = params.sort;
        const data = await apiRequest("constituents/search", "GET", undefined, queryParams);
        return {
            content: [{ type: "text", text: toJson(data) }],
            structuredContent: data,
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: handleError(e) }] };
    }
});
server.registerTool("lgl_list_constituents", {
    title: "List All Constituents",
    description: `Fetch all constituents for the account (paginated).

Use lgl_search_constituents for filtered searches. This tool returns everyone.

Args:
  - expand (string, optional): Comma-separated expansions:
      email_addresses, phone_numbers, street_addresses, categories, relationships
  - sort (string, optional): Sort field (name, date_created, date_updated); add ! to reverse
  - limit (number, default 25): Results per page, max 100
  - offset (number, default 0): Pagination offset

Returns: Paginated list with total_items.`,
    inputSchema: z
        .object({
        expand: z.string().optional(),
        sort: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
    })
        .strict(),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
}, async (params) => {
    try {
        const queryParams = {
            limit: params.limit,
            offset: params.offset,
        };
        if (params.expand)
            queryParams.expand = params.expand;
        if (params.sort)
            queryParams.sort = params.sort;
        const data = await apiRequest("constituents", "GET", undefined, queryParams);
        return {
            content: [{ type: "text", text: toJson(data) }],
            structuredContent: data,
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: handleError(e) }] };
    }
});
server.registerTool("lgl_get_constituent", {
    title: "Get Constituent Details",
    description: `Fetch the complete record for a single constituent by their LGL ID.

Returns full profile including contact info (emails, phones, addresses), class affiliations,
relationships, categories, and all other stored fields.

Args:
  - id (number, required): The constituent's numeric ID (e.g., 959486)
    Use lgl_search_constituents to find an ID by name or email.

Returns: Complete constituent object.`,
    inputSchema: z
        .object({
        id: z.number().int().describe("Constituent ID"),
    })
        .strict(),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
}, async (params) => {
    try {
        const data = await apiRequest(`constituents/${params.id}`);
        return {
            content: [{ type: "text", text: toJson(data) }],
            structuredContent: data,
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: handleError(e) }] };
    }
});
server.registerTool("lgl_create_constituent", {
    title: "Create Constituent",
    description: `Add a new constituent (person or organization) to Little Green Light.

Args:
  - first_name (string, optional): First name — for individuals
  - last_name (string, optional): Last name — for individuals
  - org_name (string, optional): Organization name — set is_org=true when using this
  - is_org (boolean, default false): true for organizations, false for individuals
  - email (string, optional): Primary email address
  - phone (string, optional): Primary phone number
  - street (string, optional): Street address
  - city (string, optional): City
  - state (string, optional): 2-letter state code (e.g., "MA")
  - postal_code (string, optional): ZIP/postal code
  - external_constituent_id (string, optional): Your own reference ID

Returns: Newly created constituent record with its assigned LGL ID.`,
    inputSchema: z
        .object({
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        org_name: z.string().optional(),
        is_org: z.boolean().default(false),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        street: z.string().optional(),
        city: z.string().optional(),
        state: z.string().max(2).optional(),
        postal_code: z.string().optional(),
        external_constituent_id: z.string().optional(),
    })
        .strict(),
    annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
    },
}, async (params) => {
    try {
        const body = { is_org: params.is_org };
        if (params.first_name)
            body.first_name = params.first_name;
        if (params.last_name)
            body.last_name = params.last_name;
        if (params.org_name)
            body.org_name = params.org_name;
        if (params.external_constituent_id)
            body.external_constituent_id = params.external_constituent_id;
        if (params.email)
            body.email_addresses = [
                {
                    address: params.email,
                    email_address_type_id: 1,
                    is_preferred: true,
                },
            ];
        if (params.phone)
            body.phone_numbers = [
                {
                    number: params.phone,
                    phone_number_type_id: 1,
                    is_preferred: true,
                },
            ];
        if (params.street ||
            params.city ||
            params.state ||
            params.postal_code) {
            body.street_addresses = [
                {
                    ...(params.street ? { street: params.street } : {}),
                    ...(params.city ? { city: params.city } : {}),
                    ...(params.state ? { state: params.state } : {}),
                    ...(params.postal_code ? { postal_code: params.postal_code } : {}),
                    street_address_type_id: 1,
                    is_preferred: true,
                },
            ];
        }
        const data = await apiRequest("constituents", "POST", body);
        return {
            content: [{ type: "text", text: toJson(data) }],
            structuredContent: data,
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: handleError(e) }] };
    }
});
server.registerTool("lgl_update_constituent", {
    title: "Update Constituent",
    description: `Update fields on an existing constituent record.

Only supply the fields you want to change — others are left untouched.

Args:
  - id (number, required): Constituent ID to update
  - first_name, last_name, org_name (string, optional): Name fields
  - job_title (string, optional): Job title
  - addressee (string, optional): Formal address name (e.g., "Mr. and Mrs. Smith")
  - salutation (string, optional): Greeting name (e.g., "John and Jane")
  - is_deceased (boolean, optional): Mark as deceased
  - deceased_date (string, optional): Date of death, YYYY-MM-DD
  - birthday (string, optional): Birthday, YYYY-MM-DD
  - gender (string, optional): Gender
  - external_constituent_id (string, optional): Your external reference ID

Returns: Updated constituent record.`,
    inputSchema: z
        .object({
        id: z.number().int(),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        org_name: z.string().optional(),
        job_title: z.string().optional(),
        addressee: z.string().optional(),
        salutation: z.string().optional(),
        is_deceased: z.boolean().optional(),
        deceased_date: z.string().optional(),
        birthday: z.string().optional(),
        gender: z.string().optional(),
        external_constituent_id: z.string().optional(),
    })
        .strict(),
    annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
}, async (params) => {
    try {
        const { id, ...rest } = params;
        const body = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
        const data = await apiRequest(`constituents/${id}`, "PATCH", body);
        return {
            content: [{ type: "text", text: toJson(data) }],
            structuredContent: data,
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: handleError(e) }] };
    }
});
// ── Gifts ─────────────────────────────────────────────────────────────────────
server.registerTool("lgl_list_constituent_gifts", {
    title: "List Gifts for Constituent",
    description: `List all gifts (donations) recorded for a specific constituent.

Args:
  - constituent_id (number, required): The constituent's LGL ID
  - limit (number, default 25): Results per page, max 100
  - offset (number, default 0): Pagination offset

Returns: Paginated gift list with amount, received_date, campaign, appeal, gift type, and payment info.`,
    inputSchema: z
        .object({
        constituent_id: z.number().int(),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
    })
        .strict(),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
}, async (params) => {
    try {
        const data = await apiRequest(`constituents/${params.constituent_id}/gifts`, "GET", undefined, { limit: params.limit, offset: params.offset });
        return {
            content: [{ type: "text", text: toJson(data) }],
            structuredContent: data,
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: handleError(e) }] };
    }
});
server.registerTool("lgl_list_gifts", {
    title: "List All Gifts",
    description: `List gifts across all constituents, with optional date filtering.

Useful for reports, recent gift summaries, or syncing data.

Args:
  - updated_from (string, optional): Only gifts updated after this date. ISO 8601 format: "2024-01-01T00:00:00Z"
  - updated_to (string, optional): Only gifts updated before this date. ISO 8601 format.
  - limit (number, default 25): Results per page, max 100
  - offset (number, default 0): Pagination offset

Returns: Paginated list with total_items.`,
    inputSchema: z
        .object({
        updated_from: z
            .string()
            .optional()
            .describe("ISO 8601, e.g., 2024-01-01T00:00:00Z"),
        updated_to: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
    })
        .strict(),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
}, async (params) => {
    try {
        const queryParams = {
            limit: params.limit,
            offset: params.offset,
        };
        if (params.updated_from)
            queryParams.updated_from = params.updated_from;
        if (params.updated_to)
            queryParams.updated_to = params.updated_to;
        const data = await apiRequest("gifts", "GET", undefined, queryParams);
        return {
            content: [{ type: "text", text: toJson(data) }],
            structuredContent: data,
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: handleError(e) }] };
    }
});
server.registerTool("lgl_list_gift_categories", {
    title: "List Gift Categories",
    description: `List all gift categories defined in the LGL account.

Use this to find the correct gift_category_id when logging a gift.
Common categories include Donation, Recurring Donation, Matching Gift, Pledge Payment.

Returns: List of gift categories with their IDs and names.`,
    inputSchema: z.object({}).strict(),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
}, async () => {
    try {
        const data = await apiRequest("gift_categories");
        return {
            content: [{ type: "text", text: toJson(data) }],
            structuredContent: data,
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: handleError(e) }] };
    }
});
server.registerTool("lgl_create_gift", {
    title: "Create Gift",
    description: `Record a new gift (donation) for a constituent in Little Green Light.

Args:
  - constituent_id (number, required): The donor's LGL constituent ID
  - received_date (string, required): Date the gift was received, format YYYY-MM-DD
  - amount (number, required): Gift amount in dollars (e.g., 500 or 50.00)
  - gift_type_id (number, optional): Type of gift:
      1 = Cash, 2 = Check, 3 = Credit Card, 4 = Stock/Securities, 5 = In-Kind, 6 = Bequest
  - campaign_id (number, optional): ID of the campaign this gift supports (use lgl_list_campaigns)
  - appeal_id (number, optional): ID of the appeal that generated this gift (use lgl_list_appeals)
  - fund_id (number, optional): Fund ID
  - payment_type_id (number, optional): Payment type ID
  - gift_category_id (number, optional): Category ID for the gift (use lgl_list_gift_categories to look up IDs).
      Common examples: Donation, Recurring Donation, Matching Gift, Pledge Payment.
  - check_number (string, optional): Check number for check gifts
  - note (string, optional): Internal notes about this gift

Returns: Newly created gift record with its assigned ID.`,
    inputSchema: z
        .object({
        constituent_id: z.number().int(),
        received_date: z.string().describe("YYYY-MM-DD"),
        amount: z.number().positive(),
        gift_type_id: z
            .number()
            .int()
            .optional()
            .describe("1=Cash, 2=Check, 3=Credit Card, 4=Stock, 5=In-Kind, 6=Bequest"),
        gift_category_id: z
            .number()
            .int()
            .optional()
            .describe("Gift category ID — use lgl_list_gift_categories to look up"),
        campaign_id: z.number().int().optional(),
        appeal_id: z.number().int().optional(),
        fund_id: z.number().int().optional(),
        payment_type_id: z.number().int().optional(),
        check_number: z.string().optional(),
        note: z.string().optional(),
    })
        .strict(),
    annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
    },
}, async (params) => {
    try {
        const body = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
        const data = await apiRequest(`constituents/${params.constituent_id}/gifts`, "POST", body);
        return {
            content: [{ type: "text", text: toJson(data) }],
            structuredContent: data,
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: handleError(e) }] };
    }
});
// ── Campaigns & Appeals ───────────────────────────────────────────────────────
server.registerTool("lgl_list_campaigns", {
    title: "List Campaigns",
    description: `List all fundraising campaigns in Little Green Light.

Returns campaign IDs and names — useful for referencing campaign_id when creating gifts.

Args:
  - limit (number, default 25): Results per page, max 100
  - offset (number, default 0): Pagination offset`,
    inputSchema: z
        .object({
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
    })
        .strict(),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
}, async (params) => {
    try {
        const data = await apiRequest("campaigns", "GET", undefined, params);
        return {
            content: [{ type: "text", text: toJson(data) }],
            structuredContent: data,
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: handleError(e) }] };
    }
});
server.registerTool("lgl_list_appeals", {
    title: "List Appeals",
    description: `List all fundraising appeals in Little Green Light.

Returns appeal IDs and names — useful for referencing appeal_id when creating gifts.

Args:
  - limit (number, default 25): Results per page, max 100
  - offset (number, default 0): Pagination offset`,
    inputSchema: z
        .object({
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
    })
        .strict(),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
}, async (params) => {
    try {
        const data = await apiRequest("appeals", "GET", undefined, params);
        return {
            content: [{ type: "text", text: toJson(data) }],
            structuredContent: data,
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: handleError(e) }] };
    }
});
// ── Categories ────────────────────────────────────────────────────────────────
server.registerTool("lgl_list_categories", {
    title: "List Categories",
    description: `List all categories (tags/labels) defined in the account.

Categories classify and segment constituents. Returns the full category tree with
all possible values — useful for understanding how constituents are tagged.

Args:
  - limit (number, default 25): Results per page, max 100
  - offset (number, default 0): Pagination offset`,
    inputSchema: z
        .object({
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
    })
        .strict(),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
}, async (params) => {
    try {
        const data = await apiRequest("categories", "GET", undefined, params);
        return {
            content: [{ type: "text", text: toJson(data) }],
            structuredContent: data,
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: handleError(e) }] };
    }
});
server.registerTool("lgl_list_constituent_categories", {
    title: "List Categories for Constituent",
    description: `List all categories currently assigned to a specific constituent.

Args:
  - constituent_id (number, required): The constituent's LGL ID

Returns: List of category objects assigned to this constituent.`,
    inputSchema: z
        .object({
        constituent_id: z.number().int(),
    })
        .strict(),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
}, async (params) => {
    try {
        const data = await apiRequest(`constituents/${params.constituent_id}/categories`);
        return {
            content: [{ type: "text", text: toJson(data) }],
            structuredContent: data,
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: handleError(e) }] };
    }
});
// ── Contact Reports ───────────────────────────────────────────────────────────
server.registerTool("lgl_list_contact_reports", {
    title: "List Contact Reports for Constituent",
    description: `List all contact reports (donor interactions) recorded for a specific constituent.

Args:
  - constituent_id (number, required): The constituent's LGL ID
  - limit (number, default 25): Results per page, max 100
  - offset (number, default 0): Pagination offset

Returns: Paginated list of contact reports with date, type, note, and team member info.`,
    inputSchema: z
        .object({
        constituent_id: z.number().int(),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
    })
        .strict(),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
}, async (params) => {
    try {
        const data = await apiRequest(`constituents/${params.constituent_id}/contact_reports`, "GET", undefined, { limit: params.limit, offset: params.offset });
        return {
            content: [{ type: "text", text: toJson(data) }],
            structuredContent: data,
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: handleError(e) }] };
    }
});
server.registerTool("lgl_create_contact_report", {
    title: "Create Contact Report",
    description: `Log a donor interaction (contact report) for a constituent in Little Green Light.

Use this to record meetings, phone calls, emails, and other donor touchpoints.

Args:
  - constituent_id (number, required): The constituent's LGL ID
  - date (string, required): Date of the interaction, format YYYY-MM-DD
  - note (string, required): Description of the interaction — what was discussed, key takeaways, next steps
  - contact_report_type (string, optional): Type of interaction.
      Options: "Meeting", "Phone", "Email", "Letter", "Volunteer", "Event", "Other"
      Defaults to "Meeting" if omitted.
  - team_member_id (number, optional): LGL ID of the staff member who had the interaction

Returns: Newly created contact report record with its assigned ID.`,
    inputSchema: z
        .object({
        constituent_id: z.number().int(),
        date: z.string().describe("YYYY-MM-DD"),
        note: z.string().describe("Description of the interaction"),
        contact_report_type: z
            .enum(["Meeting", "Phone", "Email", "Letter", "Volunteer", "Event", "Other"])
            .default("Meeting"),
        team_member_id: z.number().int().optional(),
    })
        .strict(),
    annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
    },
}, async (params) => {
    try {
        const body = {
            date: params.date,
            note: params.note,
            contact_report_type: params.contact_report_type ?? "Meeting",
        };
        if (params.team_member_id)
            body.team_member_id = params.team_member_id;
        const data = await apiRequest(`constituents/${params.constituent_id}/contact_reports`, "POST", body);
        return {
            content: [{ type: "text", text: toJson(data) }],
            structuredContent: data,
        };
    }
    catch (e) {
        return { content: [{ type: "text", text: handleError(e) }] };
    }
});
// ── Entry Point ───────────────────────────────────────────────────────────────
async function main() {
    if (!API_KEY) {
        console.error("ERROR: LGL_API_KEY environment variable is required.");
        console.error("  Get your key: LGL account → Settings → Integration Settings → LGL API");
        process.exit(1);
    }
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Little Green Light MCP server running (stdio)");
}
main();
//# sourceMappingURL=index.js.map