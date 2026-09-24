// Batch runner: apply one operation to many items, sequentially, through the
// throttled client. Never fails the whole batch on one bad record.
//
// If the rate-limit budget runs out mid-batch, we stop instead of hanging the tool
// call (MCP clients time out), and report the untouched items as "not_attempted"
// so the agent can resume with exactly those.
import { budget, budgetText, waitNeededMs } from "./lgl.js";

export const MAX_BATCH = 200;

export async function runBatch(items, fn, { label = (x) => String(x), stopWhenWaitOverMs = 15000 } = {}) {
  const results = [];
  let stoppedAt = -1;
  for (let i = 0; i < items.length; i++) {
    if (waitNeededMs() > stopWhenWaitOverMs) { stoppedAt = i; break; }
    const item = items[i];
    try {
      const detail = await fn(item, i);
      results.push({ item: label(item), ok: true, ...(detail && typeof detail === "object" ? detail : { detail }) });
    } catch (err) {
      if (err.throttled) { stoppedAt = i; break; }
      results.push({ item: label(item), ok: false, error: err.message.replace(/ LGL budget \(this server's count\):.*$/, "") });
    }
  }
  const notAttempted = stoppedAt >= 0 ? items.slice(stoppedAt).map(label) : [];
  return { results, notAttempted };
}

export function batchReport(title, { results, notAttempted }) {
  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  const lines = [`${title}: ${ok.length} succeeded, ${bad.length} failed, ${notAttempted.length} not attempted.`];
  if (bad.length) lines.push("", "FAILED:", ...bad.map((r) => `  ✗ ${r.item} — ${r.error}`));
  if (notAttempted.length) lines.push("", `NOT ATTEMPTED (rate-limit budget ran low — re-run with just these): ${notAttempted.join(", ")}`);
  if (ok.length) lines.push("", "SUCCEEDED:", ...ok.map((r) => `  ✓ ${r.item}${r.note ? ` — ${r.note}` : ""}`));
  lines.push("", budgetText());
  return lines.join("\n");
}

export function checkBatchSize(n) {
  if (n > MAX_BATCH) throw new Error(`Batch too large (${n}). Max ${MAX_BATCH} items per call — split it up. ${budgetText()}`);
  const b = budget();
  return b.remaining < n ? `Note: ~${n} calls needed but only ${b.remaining} left in this server's window; the batch will stop early and list what's left.` : null;
}
