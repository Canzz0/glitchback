/**
 * patchback suggest  → read-only: analyse the issue, post a diff as a comment
 * patchback fix      → write: apply the approved diff on a branch and open a PR
 *
 * Called by the CLI, either inside GitHub Actions (issue from GITHUB_EVENT_PATH)
 * or locally on a temporary clone (see cli/fixer-local.ts).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decodeMarker, encodeMarker, escapeUserText, IssueData } from "../schema/index.ts";
import { loadRepoConfig, type RepoConfig } from "./config.ts";
import { collectContext } from "./context.ts";
import { changedLineCount, diffAndReset, git, isPathAllowed, tryGit } from "./git.ts";
import { fence } from "./format.ts";
import * as gh from "./github.ts";
import { proposeFix, type FixProposal } from "./llm.ts";

export interface Suggestion {
  /** The issue it was written for; a block copied from another issue is ignored. */
  issue: number;
  patch: string;
  model: string;
  summary: string;
}

const T: Record<"tr"|"en", any> = {
  tr: {
    title: "### Patchback önerisi",
    rootCause: "**Muhtemel neden:**",
    change: "**Önerilen değişiklik:**",
    confidence: "Güven",
    model: "Model",
    apply: "Bu değişikliği uygulamak için issue'ya `autofix` etiketini ekleyin; Patchback bir branch açıp PR oluşturur.",
    noFix: "Patchback güvenli bir düzeltme bulamadı.",
    noFiles:
      "Bu hatayla ilgili dosya bulunamadı. `.patchback.yml` içindeki `routes` alanına bu sayfanın dosyalarını eklerseniz sonraki önerilerde kullanılır.",
    tooBig: (n: number, max: number) => `Önerilen değişiklik çok büyük (${n} satır, sınır ${max}). Elle incelenmeli.`,
    blocked: (p: string) => `Model izin verilmeyen bir dosyayı değiştirmeye çalıştı: \`${p}\`. Öneri atıldı.`,
    prOpened: (url: string) => `PR açıldı: ${url}`,
    hiddenChars: "Önerilen değişiklik görünmez ya da yön değiştiren karakterler içeriyor. Güvenlik nedeniyle uygulanmadı.",
    notAllowed: (who: string) => `@${who} bu repoya yazma yetkisine sahip değil; \`autofix\` yalnızca yazma yetkisi olanlar tarafından kullanılabilir.`,
    applyFailed: "Onaylanan öneri artık koda uygulanamıyor (kod değişmiş olabilir). `patchback:suggest` etiketiyle yeni öneri isteyin.",
    flagged:
      "Bu rapor inceleme için işaretli olduğundan otomatik düzeltme yapılmadı. Raporu inceledikten sonra `patchback:needs-review` etiketini kaldırıp tekrar deneyebilirsiniz.",
    noSuggestion:
      "Uygulanacak bir Patchback önerisi yok. Önce `patchback:suggest` etiketiyle öneri isteyin, diff'i inceleyin, sonra `autofix` etiketini ekleyin.",
  },
  en: {
    title: "### Patchback suggestion",
    rootCause: "**Likely cause:**",
    change: "**Proposed change:**",
    confidence: "Confidence",
    model: "Model",
    apply: "Add the `autofix` label to apply this change; Patchback will open a branch and a PR.",
    noFix: "Patchback could not find a safe fix.",
    noFiles:
      "No related files were found. Map this page to its files under `routes` in `.patchback.yml` to help future suggestions.",
    tooBig: (n: number, max: number) => `The proposed change is too large (${n} lines, limit ${max}). Needs manual review.`,
    blocked: (p: string) => `The model tried to change a file that is not allowed: \`${p}\`. Suggestion discarded.`,
    prOpened: (url: string) => `Opened a PR: ${url}`,
    hiddenChars: "The proposed change contains invisible or bidirectional control characters. It was not applied, for safety.",
    notAllowed: (who: string) => `@${who} does not have write access to this repository; only people with write access can use \`autofix\`.`,
    applyFailed: "The approved suggestion no longer applies (the code may have changed). Add `patchback:suggest` for a new one.",
    flagged:
      "This report is flagged for review, so no automatic fix was made. After reviewing it, remove the `patchback:needs-review` label and try again.",
    noSuggestion:
      "There is no Patchback suggestion to apply. Add `patchback:suggest` to get one, review the diff, then add `autofix`.",
  },
};

/**
 * Model output is shaped by the end user's report, so it is untrusted text:
 * escaping it keeps it from smuggling a hidden suggestion block, HTML or @mentions
 * into a comment posted by the bot account.
 */
const safe = (s: string) => escapeUserText(s);

/**
 * Invisible and bidirectional control characters can make a diff read differently from what
 * it does ("Trojan Source"). A patch that adds any of them is never suggested or applied.
 */
const HIDDEN_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
export const hasHiddenChars = (patch: string) =>
  patch.split("\n").some((l) => l.startsWith("+") && !l.startsWith("+++") && HIDDEN_CHARS.test(l));

/** Largest patch shown in a comment. Bigger patches are not suggested at all, so what is applied is always what was shown. */
const MAX_PATCH_CHARS = 40_000;

/** Write proposed files into the working tree, enforcing the path gate. Returns the patch. */
function materialise(proposal: FixProposal, cfg: RepoConfig): { patch: string } | { blocked: string } {
  for (const c of proposal.changes) {
    if (!isPathAllowed(c.path, cfg)) return { blocked: c.path };
  }
  for (const c of proposal.changes) {
    mkdirSync(dirname(c.path), { recursive: true });
    writeFileSync(c.path, c.content);
  }
  return { patch: diffAndReset() };
}

async function generate(data: IssueData, cfg: RepoConfig) {
  const model = cfg.models[data.triage.tier];
  const { files, tree } = collectContext(data, cfg);
  if (files.length === 0) return { kind: "no-files" as const, model };
  const proposal = await proposeFix(model, data, files, tree, cfg);
  if (proposal.changes.length === 0) return { kind: "no-fix" as const, model, proposal };
  const result = materialise(proposal, cfg);
  if ("blocked" in result) return { kind: "blocked" as const, model, path: result.blocked };
  const lines = changedLineCount(result.patch);
  if (!result.patch.trim()) return { kind: "no-fix" as const, model, proposal };
  if (hasHiddenChars(result.patch)) return { kind: "hidden-chars" as const, model };
  if (lines > cfg.max_changed_lines) return { kind: "too-big" as const, model, lines };
  return { kind: "ok" as const, model, proposal, patch: result.patch };
}

/** The comment a person reviews; its hidden block carries exactly the diff shown in it. */
export function suggestionComment(lang: "tr" | "en", issueNumber: number, proposal: FixProposal, patch: string, model: string): string {
  const t = T[lang];
  const summary = safe(proposal.summary);
  const suggestion: Suggestion = { issue: issueNumber, patch, model, summary };
  const f = fence(patch);
  return [
    t.title,
    "",
    summary,
    "",
    `${t.rootCause} ${safe(proposal.root_cause)}`,
    "",
    t.change,
    "",
    `${f}diff`,
    patch,
    f,
    "",
    `<sub>${t.confidence}: ${Math.round(proposal.confidence * 100)}% · ${t.model}: \`${model.replace(/`/g, "'")}\`</sub>`,
    "",
    t.apply,
    "",
    encodeMarker("suggestion", suggestion),
  ].join("\n");
}

async function suggest(issueNumber: number, data: IssueData, cfg: RepoConfig) {
  const t = T[cfg.language];
  const g = await generate(data, cfg);
  switch (g.kind) {
    case "no-files":
      return gh.comment(issueNumber, `${t.title}\n\n${t.noFiles}`);
    case "no-fix":
      return gh.comment(issueNumber, `${t.title}\n\n${t.noFix}\n\n${t.rootCause} ${safe(g.proposal?.root_cause ?? "")}`);
    case "blocked":
      return gh.comment(issueNumber, `${t.title}\n\n${t.blocked(g.path)}`);
    case "too-big":
      return gh.comment(issueNumber, `${t.title}\n\n${t.tooBig(g.lines, cfg.max_changed_lines)}`);
    case "hidden-chars":
      return gh.comment(issueNumber, `${t.title}\n\n${t.hiddenChars}`);
    case "ok": {
      if (g.patch.length > MAX_PATCH_CHARS) {
        return gh.comment(issueNumber, `${t.title}\n\n${t.tooBig(changedLineCount(g.patch), cfg.max_changed_lines)}`);
      }
      const body = suggestionComment(cfg.language, issueNumber, g.proposal, g.patch, g.model);
      if (body.length > 65_000) return gh.comment(issueNumber, `${t.title}\n\n${t.tooBig(changedLineCount(g.patch), cfg.max_changed_lines)}`);
      return gh.comment(issueNumber, body);
    }
  }
}

async function fix(issueNumber: number, cfg: RepoConfig, labels: string[], issueTitle: string) {
  try {
    await applyApproved(issueNumber, cfg, labels, issueTitle);
  } finally {
    // Always drop the trigger label so the team can add it again after fixing the cause.
    await gh.removeLabel(issueNumber, "autofix");
  }
}

/**
 * Applies exactly the diff a human saw in a bot comment. It never asks a model
 * for new code: this job has write permission, and an unseen diff must not
 * reach a branch.
 */
async function applyApproved(issueNumber: number, cfg: RepoConfig, labels: string[], issueTitle: string) {
  const t = T[cfg.language];
  if (labels.includes("patchback:needs-review")) {
    await gh.comment(issueNumber, t.flagged);
    return;
  }

  // Only trust suggestions posted by the bot account, never by other users.
  // The patch was materialised through the path gate when it was suggested; it is re-checked below.
  // Every workflow in a repo comments as github-actions[bot], so the author alone proves little.
  // A block is accepted only if it was written for this issue, sits in a Patchback suggestion
  // comment, and its patch is exactly the diff shown in that comment: what is applied was visible.
  const comments = await gh.listComments(issueNumber);
  const approved = comments
    .filter((c) => c.user.login === cfg.bot_login)
    .map((c) => ({ body: c.body, s: decodeMarker<Suggestion>("suggestion", c.body) }))
    .filter((x): x is { body: string; s: Suggestion } => !!x.s && isVisibleSuggestion(x.body, x.s, issueNumber))
    .map((x) => x.s)
    .at(-1);

  const base = await gh.defaultBranch();
  const branch = `patchback/issue-${issueNumber}`;
  git(["checkout", "-B", branch, `origin/${base}`]);

  if (!approved) {
    await gh.comment(issueNumber, t.noSuggestion);
    return;
  }
  if (hasHiddenChars(approved.patch)) {
    await gh.comment(issueNumber, t.hiddenChars);
    return;
  }
  if (!tryGit(["apply", "--whitespace=nowarn", "-"], approved.patch)) {
    await gh.comment(issueNumber, t.applyFailed);
    return;
  }
  const summary = safe(approved.summary);
  const model = approved.model.replace(/`/g, "'");

  // Re-check the final change set against the path gate.
  git(["add", "--all"]);
  const changed = git(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
  const bad = changed.find((p) => !isPathAllowed(p, cfg));
  if (bad) {
    await gh.comment(issueNumber, t.blocked(bad));
    return;
  }

  git(["-c", "user.name=patchback[bot]", "-c", "user.email=patchback@users.noreply.github.com",
    "commit", "--quiet", "-m", `fix: ${cleanTitle(issueTitle)} (#${issueNumber})`]);
  git(["push", "--force-with-lease", "origin", branch]);

  const pr = await gh.openPullRequest(
    branch,
    base,
    `fix: ${cleanTitle(issueTitle)}`,
    [`Fixes #${issueNumber}`, "", summary, "", `<sub>Generated by Patchback with \`${model}\`. Review before merging.</sub>`].join("\n"),
  );
  await gh.comment(issueNumber, t.prOpened(pr.html_url));
}

export function isVisibleSuggestion(body: string, s: Suggestion, issueNumber: number): boolean {
  if (s.issue !== issueNumber || typeof s.patch !== "string" || !s.patch.trim()) return false;
  if (!body.startsWith(T.tr.title) && !body.startsWith(T.en.title)) return false;
  const f = fence(s.patch);
  return body.includes(`\n${f}diff\n${s.patch}\n${f}\n`);
}

/** Issue titles come from end users: no closing keywords or issue references in commits and PR titles. */
export const cleanTitle = (title: string) =>
  title
    .replace(/^\[\w+\]\s*/, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/#(?=\d)/g, "")
    .replace(/@/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);

export interface IssueEvent {
  number: number;
  title: string;
  body: string | null;
  labels: ({ name: string } | string)[];
}

export async function runFixer(mode: "suggest" | "fix", issue: IssueEvent, opts: { explicit?: boolean } = {}): Promise<void> {
  const labels = issue.labels.map((l) => (typeof l === "string" ? l : l.name));

  const parsed = IssueData.safeParse(decodeMarker("data", issue.body));
  if (!parsed.success) {
    console.log("Not a Patchback issue (no valid data block). Nothing to do.");
    return;
  }
  const data = parsed.data;
  const cfg = loadRepoConfig();
  if (!cfg.allowed_paths.length) throw new Error(".patchback.yml: allowed_paths must not be empty");

  if (!["frontend", "both"].includes(data.triage.area) && mode === "suggest") {
    console.log(`Area is ${data.triage.area}; suggestions only run for frontend issues.`);
    return;
  }
  if (mode === "suggest" && labels.includes("patchback:needs-review")) {
    console.log("Issue is flagged for review; skipping automatic suggestion.");
    return;
  }
  // Without a model, the server could only screen the report with keyword rules. Such issues
  // get a suggestion only when a person asks for one (the patchback:suggest label or the CLI).
  if (mode === "suggest" && data.triage.decided_by === "rules" && !opts.explicit && !labels.includes("patchback:suggest")) {
    console.log("Report was triaged by rules only (no model screened it); add the patchback:suggest label to get a suggestion.");
    return;
  }

  if (mode === "suggest") await suggest(issue.number, data, cfg);
  else await fix(issue.number, cfg, labels, issue.title);
}

/** GitHub Actions: the triggering issue is in the event payload. */
export async function runFixerFromActions(mode: "suggest" | "fix"): Promise<void> {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8"));
  if (mode === "fix") {
    // Labels can be added with Triage access, which cannot push code. Writing a branch must
    // need the same right as pushing one.
    const who: string = event.sender?.login ?? "";
    if (!who || !(await gh.canWrite(who))) {
      const cfg = loadRepoConfig();
      await gh.comment(event.issue.number, T[cfg.language].notAllowed(who.replace(/[^\w-]/g, "") || "unknown"));
      await gh.removeLabel(event.issue.number, "autofix");
      return;
    }
  }
  await runFixer(mode, event.issue as IssueEvent);
}
