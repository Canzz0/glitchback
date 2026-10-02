import { randomUUID } from "node:crypto";
import { ReportInput, SCHEMA_VERSION, type IssueData } from "../schema/index.ts";
import { clientIp } from "./clientip.ts";
import { triageChain, type Config } from "./config.ts";
import { fingerprint } from "./fingerprint.ts";
import { createGitHub } from "./github.ts";
import { notifyBackend } from "./notify.ts";
import { maskReport } from "./privacy.ts";
import { createRateLimiter } from "./ratelimit.ts";
import { deriveRoute } from "./route.ts";
import { triage } from "./triage.ts";

/** The largest valid report is ~120 KB. */
const MAX_BODY_BYTES = 256 * 1024;

export interface RequestContext {
  /** TCP peer address, when the host framework knows it. Used for rate limiting. */
  ip?: string;
  /** Client address set by the hosting platform (e.g. Vercel's x-real-ip). Preferred over X-Forwarded-For. */
  trustedIp?: string;
}

export type Handler = (req: Request, ctx?: RequestContext) => Promise<Response>;

/**
 * Framework-agnostic report endpoint: Web Request in, Web Response out.
 * Works as a Next.js route handler, in `glitchback serve`, or in any runtime
 * with the Fetch API (Hono, Remix, SvelteKit, Astro, Bun, Deno...).
 */
export function createHandler(cfg: Config): Handler {
  const limiter = createRateLimiter(cfg.rateLimitPer10Min);
  const autoLimiter = createRateLimiter(cfg.autoReports.perClientPer10Min);
  const autoIssueBudget = createRateLimiter(cfg.autoReports.maxIssuesPerHour, 60 * 60_000);
  const githubWriteBudget = createRateLimiter(cfg.maxGithubWritesPerHour, 60 * 60_000);
  /** Paid model calls per hour. Past it, reports are still filed, triaged by the free rules. */
  const triageBudget = createRateLimiter(cfg.maxModelTriagePerHour, 60 * 60_000);
  /**
   * Fingerprints filed in the last few minutes. GitHub search needs a while to index a new
   * issue, so without this a burst of visitors hitting the same broken endpoint opens several.
   * Automatic duplicates found here skip triage and GitHub entirely.
   */
  const recent = new Map<string, { url: string; number: number | null; at: number }>();
  const RECENT_MS = 10 * 60_000;
  const recentHit = (fp: string) => {
    const hit = recent.get(fp);
    if (hit && Date.now() - hit.at < RECENT_MS) return hit;
    recent.delete(fp);
    return null;
  };
  const remember = (fp: string, url: string, number: number | null) => {
    if (recent.size > 500) recent.clear();
    recent.set(fp, { url, number, at: Date.now() });
  };
  const github = cfg.github ? createGitHub(cfg.github) : null;
  let labelsReady: Promise<void> | null = null;

  const corsHeaders = (origin: string | null): Record<string, string> =>
    origin && cfg.allowedOrigins?.includes(origin)
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "600",
          Vary: "Origin",
        }
      : {};

  /** Browsers always send Origin on cross-site POSTs; same-origin installs only accept their own host. */
  function originAllowed(req: Request, origin: string | null): boolean {
    if (!origin) return true;
    if (cfg.allowedOrigins) return cfg.allowedOrigins.includes(origin);
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    const hosts = [req.headers.get("x-forwarded-host"), req.headers.get("host")]
      .flatMap((h) => (h ? h.split(",") : []))
      .map((h) => h.trim());
    try {
      hosts.push(new URL(req.url).host);
    } catch {}
    return hosts.includes(originHost);
  }

  return async function handle(req, ctx = {}) {
    const origin = req.headers.get("origin");
    const json = (body: unknown, status: number) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (req.method === "GET") {
      // Which models and integrations are configured is nobody's business in production.
      if (process.env.NODE_ENV === "production") return json({ ok: true, schema_version: SCHEMA_VERSION }, 200);
      return json({ ok: true, schema_version: SCHEMA_VERSION, github: !!github, triage: triageChain(cfg), auto_reports: cfg.autoReports.enabled }, 200);
    }
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (!originAllowed(req, origin)) return json({ error: "origin_not_allowed" }, 403);

    const ip = ctx.trustedIp || clientIp(req.headers.get("x-forwarded-for") ?? undefined, ctx.ip, cfg.trustedProxyHops);

    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return json({ error: "too_large" }, 413);
    const text = await req.text().catch(() => "");
    if (text.length > MAX_BODY_BYTES) return json({ error: "too_large" }, 413);
    let raw: unknown = null;
    try {
      raw = JSON.parse(text);
    } catch {}
    // Automatic reports have their own budget, so a noisy page never blocks a typed report.
    // With no trustworthy client address there is no per-client bucket: one shared "unknown"
    // bucket would let a single client block everyone. The hourly GitHub budget still applies.
    const claimsAuto = (raw as { source?: unknown } | null)?.source === "auto";
    if (ip !== "unknown" && !(claimsAuto ? autoLimiter : limiter).take(ip)) return json({ error: "rate_limited" }, 429);
    const parsed = ReportInput.safeParse(raw);
    if (!parsed.success) return json({ error: "invalid_report", details: parsed.error.flatten() }, 422);
    if (cfg.projectKey && parsed.data.project_key !== cfg.projectKey) return json({ error: "unknown_project" }, 403);

    const isAuto = parsed.data.source === "auto";
    if (isAuto && !parsed.data.trigger) return json({ error: "invalid_report", details: "auto reports need a trigger" }, 422);
    // 403 tells the widget to stop sending automatic reports for this page.
    if (isAuto && !cfg.autoReports.enabled) return json({ error: "auto_reports_disabled" }, 403);

    const masked = maskReport(parsed.data);
    // getRoute is optional: ids in the path are folded into a pattern ("/products/1" → "/products/:id").
    const report = { ...masked, context: { ...masked.context, route: deriveRoute(masked.context.url, masked.context.route) } };
    const fp = fingerprint(report);
    const report_id = `rpt_${randomUUID()}`;

    // The same failure from another visitor: already filed, nothing new to say.
    if (isAuto && recentHit(fp)) return json({ ok: true, report_id, duplicate: true }, 202);

    const result = await triage(report, triageBudget.take("all") ? cfg : { ...cfg, jev: null, llm: null });
    const { project_key: _unused, ...reportWithoutKey } = report;

    const data: IssueData = {
      schema_version: SCHEMA_VERSION,
      report_id,
      fingerprint: fp,
      created_at: new Date().toISOString(),
      report: reportWithoutKey,
      triage: result,
    };
    // Issues may live in a public repo: the contact email never goes there.
    const publicData: IssueData = { ...data, report: { ...data.report, contact: undefined } };

    if (!github) {
      if (isAuto) remember(fp, "console", null);
      logToConsole(publicData);
      return json({ ok: true, report_id: data.report_id, delivered: "console" }, 202);
    }

    try {
      labelsReady ??= github.ensureBaseLabels().catch((err) => {
        labelsReady = null; // try again with the next report
        console.error("[glitchback] could not create labels:", err);
      });
      await labelsReady;

      const known = recentHit(fp);
      const existing = known?.number ? { number: known.number, html_url: known.url } : await github.findOpenByFingerprint(fp);
      const isBackend = result.area === "backend" || result.area === "both";

      if (existing) {
        remember(fp, existing.html_url, existing.number);
        if (!isAuto && !githubWriteBudget.take("all")) {
          console.error("[glitchback] MAX_GITHUB_WRITES_PER_HOUR reached; duplicate report not commented.");
          return json({ ok: true, report_id: data.report_id, duplicate: true }, 202);
        }
        // A person's words are worth a comment; a repeat of the same automatic failure is not.
        if (!isAuto) await github.addDuplicateComment(existing.number, publicData);
        if (isBackend) await notifyBackend(cfg, "report.duplicate", existing.html_url, data);
        return json({ ok: true, report_id: data.report_id, duplicate: true }, 202);
      }

      if (!isAuto && !githubWriteBudget.take("all")) {
        console.error("[glitchback] MAX_GITHUB_WRITES_PER_HOUR reached; report dropped:", report.user_message.slice(0, 120));
        return json({ error: "rate_limited" }, 429);
      }
      if (isAuto && !autoIssueBudget.take("all")) {
        console.error("[glitchback] AUTO_MAX_ISSUES_PER_HOUR reached; automatic report dropped:", report.user_message);
        return json({ error: "rate_limited" }, 429);
      }
      const issue = await github.createIssue(publicData, {
        needsReview: result.injection_risk >= cfg.thresholds.injection,
        // Nobody wrote an automatic report, so "probably not a bug" says nothing about it.
        feedback: !isAuto && result.is_bug < cfg.thresholds.isBug,
        auto: isAuto,
      });
      remember(fp, issue.html_url, issue.number);
      if (isBackend) await notifyBackend(cfg, "report.created", issue.html_url, data);
      return json({ ok: true, report_id: data.report_id }, 202);
    } catch (err) {
      console.error("[glitchback] failed to file report:", err);
      return json({ error: "upstream_failed" }, 502);
    }
  };
}

/** Until a GitHub token is set, reports show up where the developer already looks. */
function logToConsole(d: IssueData) {
  const c = d.report.context;
  const t = d.triage;
  const lines = [
    "",
    `┌ Glitchback: new ${d.report.source === "auto" ? "automatic " : ""}report (${t.area}, severity ${Math.round(t.severity * 100)}%, decided by ${t.decided_by})`,
    `│ ${d.report.user_message.split("\n").join("\n│ ")}`,
    `│ page: ${c.route ?? "-"}  ${c.url}`,
    ...c.console_errors.slice(-3).map((e) => `│ console: ${e.split("\n")[0].slice(0, 160)}`),
    ...c.failed_requests.slice(-3).map((f) => `│ request: ${f.method} ${f.url} → ${f.status}`),
    "└ Set GLITCHBACK_GITHUB_TOKEN to turn reports into GitHub issues.",
    "",
  ];
  console.log(lines.join("\n"));
}
