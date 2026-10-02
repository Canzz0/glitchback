import { createHmac } from "node:crypto";
import type { IssueData, WebhookPayload } from "../schema/index.ts";
import type { Config } from "./config.ts";

/**
 * Receivers verify with:
 *   ts = header["x-glitchback-timestamp"]            (unix seconds; reject if older than 5 minutes)
 *   expected = "sha256=" + HMAC_SHA256(BACKEND_WEBHOOK_SECRET, ts + "." + rawBody).hex()
 *   timingSafeEqual(expected, header["x-glitchback-signature"])
 * The timestamp is signed, so a captured request cannot be replayed later.
 */
export async function notifyBackend(
  cfg: Config,
  event: WebhookPayload["event"],
  issueUrl: string,
  data: IssueData,
) {
  const tasks: Promise<unknown>[] = [];
  const { webhookUrl, webhookSecret, slackWebhookUrl } = cfg.backend;

  if (webhookUrl) {
    // The only place the optional contact email goes: your own endpoint. It is never written to GitHub.
    const payload: WebhookPayload = { event, issue_url: issueUrl, data };
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { "Content-Type": "application/json", "X-Glitchback-Event": event };
    if (webhookSecret) {
      const ts = String(Math.floor(Date.now() / 1000));
      headers["X-Glitchback-Timestamp"] = ts;
      headers["X-Glitchback-Signature"] = `sha256=${createHmac("sha256", webhookSecret).update(`${ts}.${body}`).digest("hex")}`;
    }
    tasks.push(fetch(webhookUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(5000) }));
  }

  if (slackWebhookUrl && event === "report.created") {
    const text = `:rotating_light: New backend report (${data.triage.area}, severity ${Math.round(data.triage.severity * 100)}%): ${issueUrl}`;
    tasks.push(
      fetch(slackWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(5000),
      }),
    );
  }

  const results = await Promise.allSettled(tasks);
  for (const r of results) if (r.status === "rejected") console.error("[glitchback] notify failed:", r.reason);
}
