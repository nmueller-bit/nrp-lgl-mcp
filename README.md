# NRP LGL MCP Server

MCP server (Streamable HTTP, deployed on Railway) that connects Claude to Little Green Light for the Neighborhood Resilience Project. It also serves the Contact Report Logger (`/contact-logger`) and its REST endpoints.

## Tools

Existing tool names are unchanged, since saved skills and sessions reference them.

**Constituents**
- `search_constituents`: name search plus filters for group, keyword, membership, location, type, updated date, custom fields, and a raw `q[]` passthrough. Shows the total and the next offset.
- `get_constituent`, `create_constituent`

**Keywords and categories**
- `list_categories`, `list_category_keywords`, `get_constituent_keywords`
- `create_category`, `update_category`, `create_keyword`
- `add_constituent_keyword`, `remove_constituent_keyword` (irreversible)
- `batch_add_constituent_keyword`, `batch_remove_constituent_keyword` (irreversible)

**Groups**
- `list_groups`, `create_group`, `update_group`, `delete_group` (irreversible; refuses if the group has members)
- `list_constituent_group_memberships`, `get_group_membership`
- `add_group_membership`, `update_group_membership` (for example, ending a membership with `date_end`), `remove_group_membership` (irreversible)
- `batch_add_group_membership`

**Contact reports**
- `create_contact_report`, `get_contact_report`, `update_contact_report`
- `list_contact_reports`: for one constituent, or account-wide when `constituent_id` is omitted. Also offers `unattributed_only`, `untyped_only`, `ids_only`, and date filters.
- `batch_create_contact_reports`, `batch_update_contact_reports` (for example, attributing unattributed reports)

**Gifts**
- `log_gift`, `get_constituent_gifts`
- `search_gifts`: gifts across all constituents. Filters by date window on the server, and by campaign, fund, appeal, type, category, or amount after fetching.
- `giving_report`: rewritten to use `/gifts/search`. The old version called `GET /gifts`, which returns 404.

**Reference**
- `list_funds`, `list_campaigns`, `list_appeals`, `list_gift_categories`, `list_team_members`, `list_acknowledgment_templates`

**Other**
- `create_followup_task` (Todoist)

## Rate limiting

LGL allows **300 calls per rolling 5 minutes, account-wide**. All LGL traffic goes through one client (`src/lgl.js`), which works as follows:

- It counts its own calls in a sliding window and caps them at `LGL_RATE_LIMIT` (default **270**). The headroom leaves room for the local Claude Desktop server, the batch check logger, and other integrations that share the same account.
- It sleeps up to 20 seconds when the budget runs out. After that it fails fast instead of hanging the MCP call.
- It retries a 429 with backoff. It retries network errors and 5xx responses **only on GETs**, because a retried POST could create a duplicate donor record.
- It appends the remaining budget to every error, for example `LGL budget (this server's count): 212/270 calls left…`.
- LGL sent **no rate-limit headers** in any response during testing, so the budget is this server's own count. It can't see calls made by other integrations.

Batch tools (`src/batch.js`) process items one at a time, report success or failure for each item, and never abort the whole batch because of one bad record. If the budget runs low partway through, they stop and list the **not attempted** IDs so the agent can re-run only those. The limit is 200 items per call.

## Verified API behaviour (tested against NRP's live account, 2026-09-24)

Everything below comes from real calls, not from the docs. Probe scripts and results are in `lgl-mcp-server/probe/` on Noah's machine. The tool-level run is in `scripts/verify-live.mjs` and `scripts/verify-results.json`. The test records are **ZZTest ClaudeMCP** (constituent 958059), **ZZ MCP Test Category** (1394), and **ZZ MCP Test Group** (3319).

### Search: general

- `q[]` is the only way to filter. **Unknown `q[]` keys return 400 `Unknown query parameter: <key>`.** They are *not* silently ignored, on constituents, gifts, or contact reports. That makes the raw `q` passthrough safe: a typo fails loudly.
- A malformed `custom_attr` also returns 400.

### Constituent search (`GET /constituents/search`)

| q[] key | Result |
|---|---|
| `name` | works |
| `groups=<id>` | works. **Includes people whose membership has ended.** |
| `keyword=<id>` | works. `keyword=<name>` returns **0 results with no error**, so always use the ID. |
| `constituent_type=1` | works (55 organizations) |
| `updated_from` | works |
| `membership_status=1` | returns 0. NRP doesn't use LGL memberships. |
| `eaddr`, `phone_number`, `city`, `state`, `postal_code`, `class`, `membership_level`, `membership_end_date_*`, `external_id`, `custom_attr*` | in the docs, exposed as named params, not individually verified |

### Keywords and categories

- `POST /constituents/{id}/keywords` with body `{"id": <keyword_id>}` returns `{"result":"success"}`. **It returns success even if the person already had the keyword.**
- `DELETE /constituents/{id}/keywords/{kw}` also returns `success` **when the person never had that keyword**. A keyword ID that doesn't exist returns 404. The tools read the person's keywords before and after, so they report what actually changed.
- **Single-select categories:** adding a keyword from a category with `facet_type: "single"` **silently replaces** the person's existing keyword in that category.
- An unknown keyword returns **400**. **An unknown constituent returns 403** ("You do not have access…"), not 404.
- `POST /categories` works with just `item_type` and `name`. `PATCH /categories/{id}` works with just `name`, even though the docs mark `item_type` as required.
- `POST /categories/{id}/keywords` works without `category_id` in the body.
- NRP has only `item_type: "Constituent"` categories through `/categories`. There were 6 at the time of testing.
- New constituents automatically get the keyword "Giving Status: Non Donor".

### Groups

- `POST /constituents/{id}/group_memberships` **creates duplicates**. Adding someone to a group twice gives two membership records, so the tools check for an existing membership first.
- `PATCH /group_memberships/{id}` **works without `group_id`**, even though the docs say it's required.
- Setting `date_end` makes `is_current: false`.
- `DELETE /group_memberships/{id}` returns success, and a later GET returns 404.

### Contact reports

The create/update body is `original_date`, `contact_report_type_name`, `name`, `text`, and `team_member`. These fields are **silently ignored**:

| Sent | What LGL does |
|---|---|
| `date` | **Ignored. The report is saved with TODAY's date.** Until this fix, the MCP tool and the Contact Report Logger both sent `date`. |
| `contact_report_type` | Ignored. The report has **no type**. Use `contact_report_type_name`, or `contact_report_type_id`. |
| `summary` | Ignored. The name defaults to `Contact report for 'Last, First'`. Use `name`. |
| `team_member_id` | Ignored. The report is **unattributed**. This is what the local `lgl_create_contact_report` sends. |
| `hours` | Not part of the API. |

- `team_member` accepts a team-member **ID (string or number), an email, or "First Last"**. All four forms were verified. **An unknown value is silently dropped:** on create the report has no team member, and on PATCH the previous value is kept. The server now validates against `/team_members` and refuses unknown names.
- **An unknown `contact_report_type_name` creates a new type in LGL** (for example, "Carrier Pigeon" was created as type 2224). The tools only accept Call, Email, Meeting, Mailing, Proposal, and Other.
- `PATCH /contact_reports/{id}` works **without `text`**, even though the docs say it's required. Only the fields you send change. PATCHing `team_member` onto an unattributed report sticks, so old reports can be repaired.
- A blank `text` returns 422 `Text can't be blank`.
- `GET /contact_reports` (account-wide) exists. It returned 394 reports at the time of testing and sorts with `sort=date!`.
- `GET /contact_reports/search` q[] keys:
  - Work: `constituent_id`, `updated_from`, `updated_to`, `original_date_from`, `contact_report_type_id`, `name`
  - Return 400: `date`, `date_from`, `from_date`, `created_from`, `team_member`, `team_member_id`
  - `original_date_to`: see round 3 below

### Gifts (`GET /gifts/search`)

- **Filter keys that work:** `date_from`, `date_to`, `updated_from`, `updated_to`, `created_from`. From the September 15 probe: an open-ended `date_from` also returns undated gifts, so always pair it with `date_to`. `updated_*` is loose and can include the day before.
- **400 `Unknown query parameter`:** `campaign_id`, `campaign`, `campaign_ids`, `campaign_name`, `fund_id`, `fund`, `appeal_id`, `appeal`, `gift_type_id`, `gift_type`, `gift_type_name`, `gift_category`, `payment_type`, `constituent_id`, `constituent`, `lgl_constituent_id`, `external_id`, `amount`, `amount_from`, `amount_to`, `amount_min`, `min_amount`, `received_amount`, `received_amount_from`, `gift_amount_from`, `deposit_date_from`, `name`, `keyword`, `groups`
- **`gift_amount` is a real key** (LGL calls it `api_gift_amount`), but a plain number fails with "Unable to parse value". See round 3 below.
- **Sorting works:** `sort=gift_amount!` returns largest first, and `sort=campaign` works too.
- As a result, **"who gave through campaign X" requires a date window plus client-side filtering**, which is what `search_gifts` does. Each 100 gifts scanned costs one call. NRP had about 9,600 gifts at the time of testing.
- List items use `received_amount` and `received_date`. `campaign_name` and other label fields come back **null** in list results, but the IDs are reliable.
- Soft credits appear as separate items (`parent_gift_id` is set) and are excluded from totals by default.

### Errors

- 404: `{"error":"Not Found","description":"Item with id '1' not found"}`
- 400 on search: `{"error":"Parameter Error","description":"Unknown query parameter: X"}`
- 422: `{"error":"error saving object","description":"Text can't be blank"}`

## Local verification

```bash
npm install
node scripts/verify-live.mjs    # calls every new/changed tool via an in-memory MCP client against live LGL
```

The script reads `LGL_API_KEY` from the environment or from the Claude Desktop config and never prints it. It writes only to the ZZ test records. It deliberately passes a constituent ID that doesn't exist to show per-item failures. Before saving, it redacts names, emails, and note text from real-data reads.

## Setup

Set these in Railway (never in code): `LGL_API_KEY`, and optionally `LGL_RATE_LIMIT` (default 270), `ANTHROPIC_API_KEY`, `TODOIST_API_KEY`, `RESEND_API_KEY`, and `ARTIFACT_TOKEN`. The MCP endpoint is `https://<app>.railway.app/mcp` (POST, Streamable HTTP).

## ⚠️ Security: open issues

- **`/mcp` has no authentication.** The `/oauth/*` routes hand a token to any client that asks, and `/mcp` never checks it. Anyone who finds the Railway URL can read and write donor records, and after this change they can also delete keywords and group memberships. The URL appears in this public repo's history.
- **`ARTIFACT_TOKEN` defaults to `nrp-artifact-token`**, and that value is hard-coded in `public/contact-logger.html` in this public repo. Anyone can call `/api/gifts`, `/api/constituents`, and so on.
