import { createHash } from "node:crypto";
import type { ReportInput } from "../schema/index.ts";

/** Strip volatile parts (numbers, ids, hashes, line:col) so the same bug hashes the same. */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[0-9a-f]{8,}/g, "<hex>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function pathOnly(url: string): string {
  try {
    return new URL(url, "http://x.invalid").pathname;
  } catch {
    return url;
  }
}

/**
 * Same page + same first error + same failing endpoints → same fingerprint.
 * With no technical signal we fall back to page + message, which rarely
 * collides; that is fine, a missed duplicate is cheaper than a wrong merge.
 */
export function fingerprint(r: ReportInput): string {
  const ctx = r.context;
  // Automatic reports: only the failure that fired them counts. Earlier, unrelated failures
  // in the same tab would otherwise split one broken endpoint into many issues.
  if (r.source === "auto" && r.trigger) {
    const signal =
      r.trigger.kind === "request"
        ? `request|${r.trigger.method} ${normalise(pathOnly(r.trigger.url))} ${r.trigger.status}`
        : `error|${ctx.route ?? pathOnly(ctx.url)}|${normalise(r.trigger.message.split("\n")[0])}`;
    return createHash("sha256").update(`auto|${signal}`).digest("hex").slice(0, 12);
  }
  const page = ctx.route ?? pathOnly(ctx.url);
  const firstError = ctx.console_errors[0] ? normalise(ctx.console_errors[0].split("\n")[0]) : "";
  const requests = [
    ...new Set(ctx.failed_requests.map((f) => `${f.method} ${normalise(pathOnly(f.url))} ${f.status}`)),
  ].sort();
  const signal = firstError || requests.length ? `${firstError}|${requests.join(",")}` : normalise(r.user_message);
  return createHash("sha256").update(`${page}|${signal}`).digest("hex").slice(0, 12);
}
