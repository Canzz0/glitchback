import { encodeMarker, escapeUserText, type IssueData } from "../schema/index.ts";

const API = "https://api.github.com";

export const LABELS = {
  base: { name: "bugloop", color: "5319e7", description: "Created by Bugloop" },
  needsReview: { name: "bugloop:needs-review", color: "d93f0b", description: "Flagged; no automatic suggestion" },
  feedback: { name: "bugloop:feedback", color: "c5def5", description: "Probably not a bug" },
  autofix: { name: "autofix", color: "0e8a16", description: "Apply the Bugloop suggestion and open a PR" },
  auto: { name: "bugloop:auto", color: "ededed", description: "Sent automatically by the widget, not typed by a user" },
  suggest: { name: "bugloop:suggest", color: "bfdadc", description: "Re-run the Bugloop suggestion" },
} as const;

const DYNAMIC_COLORS: Record<string, string> = { area: "1d76db", severity: "b60205", tier: "fbca04" };

export function createGitHub({ token, repo }: { token: string; repo: string }) {

  async function gh<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!res.ok) throw Object.assign(new Error(`GitHub ${init.method ?? "GET"} ${path} → ${res.status}`), { status: res.status });
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  async function ensureLabel(name: string, color: string, description = "") {
    try {
      await gh(`/repos/${repo}/labels`, { method: "POST", body: JSON.stringify({ name, color, description }) });
    } catch (err) {
      if ((err as { status?: number }).status !== 422) throw err; // 422 = already exists
    }
  }

  return {
    async ensureBaseLabels() {
      for (const l of Object.values(LABELS)) await ensureLabel(l.name, l.color, l.description);
    },

    /** Search has a short indexing delay; a duplicate arriving within seconds may create a second issue. */
    async findOpenByFingerprint(fp: string): Promise<{ number: number; html_url: string } | null> {
      const q = encodeURIComponent(`repo:${repo} is:issue is:open label:bugloop "bl-fp-${fp}" in:body`);
      const data = await gh<{ items: { number: number; html_url: string }[] }>(`/search/issues?q=${q}&per_page=1`);
      return data.items[0] ?? null;
    },

    async createIssue(data: IssueData, flags: { needsReview: boolean; feedback: boolean; auto?: boolean }) {
      const t = data.triage;
      const dynamic = [`area:${t.area}`, `severity:${bucket(t.severity)}`, `tier:${t.tier}`];
      for (const name of dynamic) await ensureLabel(name, DYNAMIC_COLORS[name.split(":")[0]]);
      const labels = [
        LABELS.base.name,
        ...dynamic,
        ...(flags.needsReview ? [LABELS.needsReview.name] : []),
        ...(flags.feedback ? [LABELS.feedback.name] : []),
        ...(flags.auto ? [LABELS.auto.name] : []),
      ];
      return gh<{ number: number; html_url: string }>(`/repos/${repo}/issues`, {
        method: "POST",
        body: JSON.stringify({ title: issueTitle(data), body: issueBody(data, flags.needsReview), labels }),
      });
    },

    async addDuplicateComment(issueNumber: number, data: IssueData) {
      const body = [
        "**Another user reported this problem.**",
        "",
        quote(data.report.user_message),
        "",
        `<sub>Page: \`${inline(data.report.context.url)}\` · version: \`${inline(data.report.context.app_version ?? "unknown")}\` · ${data.created_at}</sub>`,
      ].join("\n");
      await gh(`/repos/${repo}/issues/${issueNumber}/comments`, { method: "POST", body: JSON.stringify({ body }) });
    },
  };
}

const bucket = (x: number) => (x < 0.25 ? "low" : x < 0.5 ? "medium" : x < 0.75 ? "high" : "critical");
const pct = (x: number) => `${Math.round(x * 100)}%`;
/**
 * For text inside a code span or code fence: no backticks (cannot close the code), and for
 * one-line spans no line breaks or pipes either, so a report field can never leave its table
 * cell and inject Markdown, links or live @mentions into the issue.
 */
const code = (s: string) => s.replace(/`/g, "'");
const inline = (s: string) =>
  s
    .replace(/[\r\n\u2028\u2029\u0085]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/`/g, "'")
    .replace(/\|/g, "\\|")
    .slice(0, 2000);
const quote = (s: string) =>
  escapeUserText(s)
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

function issueTitle(d: IssueData): string {
  const first = d.report.user_message
    .split("\n")[0]
    .replace(/^Automatic report: /, "auto: ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const short = first.length > 70 ? `${first.slice(0, 67)}…` : first;
  return `[${d.triage.area}] ${short}`;
}

function issueBody(d: IssueData, flagged: boolean): string {
  const c = d.report.context;
  const t = d.triage;
  const section = (title: string, lines: string[]) =>
    lines.length ? [`<details><summary>${title} (${lines.length})</summary>`, "", "```", ...lines.map(code), "```", "</details>", ""] : [];

  const tr = d.report.trigger;
  const header =
    d.report.source === "auto"
      ? [
          "### Automatic report",
          "",
          "_Sent by the Bugloop widget without user input._",
          "",
          tr?.kind === "request"
            ? `**Trigger:** \`${inline(`${tr.method} ${tr.url} → ${tr.status === 0 ? "no response" : tr.status}`)}\``
            : tr?.kind === "error"
              ? ["**Trigger:** uncaught error", "", "```", code(tr.message), "```"].join("\n")
              : "",
          "",
        ]
      : ["### User report", "", quote(d.report.user_message), ""];

  return [
    ...header,
    "### Context",
    "",
    "| | |",
    "|---|---|",
    `| Page | \`${inline(c.url)}\` |`,
    `| Route | \`${inline(c.route ?? "-")}\` |`,
    `| App version | \`${inline(c.app_version ?? "-")}\` |`,
    `| Browser | \`${inline(c.user_agent ?? "-")}\` |`,
    `| Viewport | ${c.viewport ? `${c.viewport.width}×${c.viewport.height}` : "-"} |`,
    "",
    ...section("Console errors", c.console_errors),
    ...section("Failed requests", c.failed_requests.map((f) => `${f.method} ${f.url} → ${f.status}`)),
    ...section("Recent actions", c.breadcrumbs.map((b) => `${b.at} ${b.type}: ${b.message}`)),
    "### Triage",
    "",
    `| Bug | Frontend | Backend | Severity | Difficulty | Decided by |`,
    `|---|---|---|---|---|---|`,
    `| ${pct(t.is_bug)} | ${pct(t.frontend)} | ${pct(t.backend)} | ${bucket(t.severity)} | ${t.tier} | ${t.decided_by} |`,
    "",
    flagged
      ? "> [!WARNING]\n> This report looks like it contains instructions for an AI system. No automatic suggestion was generated. Review it manually."
      : "",
    "",
    `<sub>Bugloop report \`${d.report_id}\` · fingerprint \`bl-fp-${d.fingerprint}\`</sub>`,
    "",
    encodeMarker("data", d),
  ].join("\n");
}
