# NRP LGL MCP Server

A secure MCP (Model Context Protocol) server that connects Claude to Little Green Light for the Neighborhood Resilience Project.

## What this does

Allows Claude (in claude.ai or Cowork) to securely read and write data in your LGL account — searching donors, logging gifts, pulling reports, and more — without your API key ever appearing in chat.

## Tools available to Claude

- `search_constituents` — Find donors by name or email
- `get_constituent` — Get full donor profile
- `create_constituent` — Add a new donor
- `log_gift` — Log a gift with full details (amount, payment type, check number, deposit date, fund, campaign, team member, anonymous flag, tribute, acknowledgment template, category)
- `get_constituent_gifts` — Giving history for one donor
- `list_gifts` — Recent gifts across all of NRP
- `list_funds` — All funds
- `list_campaigns` — All campaigns
- `list_appeals` — All appeals
- `list_gift_categories` — Gift category options
- `list_team_members` — Team members
- `list_acknowledgment_templates` — Ack letter templates
- `giving_report` — Summary report with totals, breakdowns by fund/campaign, top donors

## Setup

### Environment Variables

Set this in Railway (never put it in code):

```
LGL_API_KEY=your_lgl_api_key_here
```

### Deploy on Railway

1. Connect this GitHub repo to Railway
2. Add the `LGL_API_KEY` environment variable
3. Railway will auto-deploy — your MCP URL will be: `https://your-app.railway.app/sse`

### Connect to Claude

In Claude.ai → Settings → Connected Apps → Add MCP Server → paste your Railway URL.
