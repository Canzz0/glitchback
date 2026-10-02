import type { AutoTrigger, FailedRequest, ReportContext, ReportInput } from "../schema/index.ts";

/**
 * Automatic reports: the widget files a report by itself when a request fails or an
 * uncaught error is thrown, without the user pressing the button.
 *
 * Noise control happens on both sides. Here: a status filter, one report per distinct
 * failure per browser session, a per-page cap and a short delay so the errors that
 * follow a failure land in the same report. On the server: a separate rate limit,
 * fingerprint dedupe (one broken endpoint = one issue) and an hourly cap on new issues.
 */
export interface AutoReportOptions {
  /** Report failed requests. Default true. */
  requests?: boolean;
  /** Report uncaught exceptions and unhandled promise rejections. Default true. */
  errors?: boolean;
  /**
   * Which statuses count. Default: 0 (no response, while online) and 400+ except
   * 401, 403, 404 and 429, which are usually expected (logged out, not found, throttled).
   */
  statuses?: number[] | ((status: number) => boolean);
  /** At most this many automatic reports per page load. Default 5. */
  maxPerPage?: number;
  /** Wait this long before sending, so related errors are included. Default 1500 ms. */
  delayMs?: number;
}

const EXPECTED = new Set([401, 403, 404, 429]);
const defaultStatus = (s: number) => (s === 0 ? navigator.onLine !== false : s >= 400 && !EXPECTED.has(s));

/** Noise every site has; none of it is a bug in the app. */
const IGNORED_ERRORS = /^Script error\.?|ResizeObserver loop|extension:\/\/|Non-Error promise rejection captured/i;

const SESSION_KEY = "glitchback:auto-sent";

function pathOf(url: string): string {
  try {
    return new URL(url, location.href).pathname;
  } catch {
    return url.split("?")[0];
  }
}

function absolute(url: string): string {
  try {
    return new URL(url, location.href).href;
  } catch {
    return url;
  }
}

/** Ids and numbers out, so /api/orders/17 and /api/orders/18 are the same failure. */
const shape = (s: string) => s.replace(/[0-9a-f]{8,}/gi, ":id").replace(/\d+/g, ":n").slice(0, 300);

export interface AutoReporter {
  onFailedRequest(req: FailedRequest): void;
  onUncaughtError(message: string): void;
}

export function createAutoReporter(
  opts: AutoReportOptions,
  deps: {
    endpoint: string;
    projectKey?: string;
    snapshot: () => ReportContext;
    fetch: typeof fetch;
  },
): AutoReporter {
  const statusOk =
    typeof opts.statuses === "function"
      ? opts.statuses
      : Array.isArray(opts.statuses)
        ? (s: number) => (opts.statuses as number[]).includes(s)
        : defaultStatus;
  const maxPerPage = opts.maxPerPage ?? 5;
  const delayMs = opts.delayMs ?? 1500;

  let sentThisPage = 0;
  let stopped = false; // the server said no (rate limited, turned off): stay quiet for this page
  const seen = new Set<string>(readSession());

  function readSession(): string[] {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "[]");
    } catch {
      return [];
    }
  }
  function remember(key: string) {
    seen.add(key);
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify([...seen].slice(-50)));
    } catch {}
  }

  function schedule(key: string, trigger: AutoTrigger, message: string) {
    if (stopped || seen.has(key) || sentThisPage >= maxPerPage) return;
    remember(key);
    sentThisPage += 1;
    setTimeout(() => send(trigger, message), delayMs);
  }

  async function send(trigger: AutoTrigger, message: string) {
    if (stopped) return;
    const payload: ReportInput = {
      schema_version: "1.0",
      ...(deps.projectKey ? { project_key: deps.projectKey } : {}),
      user_message: message.slice(0, 5000),
      source: "auto",
      trigger,
      context: deps.snapshot(),
    };
    try {
      const res = await deps.fetch(deps.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      });
      if (res.status === 429 || res.status === 403) stopped = true;
    } catch {
      // Reporting must never break the page; a lost automatic report is acceptable.
    }
  }

  return {
    onFailedRequest(req) {
      if (opts.requests === false || !statusOk(req.status)) return;
      const path = pathOf(req.url);
      const outcome = req.status === 0 ? "got no response" : `returned ${req.status}`;
      schedule(
        `r ${req.method} ${shape(path)} ${req.status}`,
        { kind: "request", method: req.method, url: absolute(req.url), status: req.status },
        `Automatic report: ${req.method} ${path} ${outcome}`,
      );
    },
    onUncaughtError(message) {
      if (opts.errors === false || IGNORED_ERRORS.test(message)) return;
      const first = message.split("\n")[0].replace(/\s*\([^)]*:\d+:\d+\)\s*$/, "");
      schedule(
        `e ${location.pathname} ${shape(first)}`,
        { kind: "error", message },
        `Automatic report: uncaught error on ${location.pathname}: ${first.slice(0, 200)}`,
      );
    },
  };
}
