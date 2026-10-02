import type { Breadcrumb, FailedRequest, ReportContext } from "../schema/index.ts";

const MAX_ITEMS = 20;

function push<T>(list: T[], item: T, max = MAX_ITEMS) {
  list.push(item);
  if (list.length > max) list.shift();
}

function stringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Short, value-free description of a clicked element. Never reads input values. */
function describe(el: Element | null): string {
  if (!el) return "unknown";
  const target = el.closest("button, a, [role=button], input, select, label, [data-testid]") ?? el;
  const tag = target.tagName.toLowerCase();
  const id = target.id ? `#${target.id}` : "";
  const testId = target.getAttribute("data-testid");
  const isField = tag === "input" || tag === "select" || tag === "textarea";
  const text = isField ? "" : (target.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
  return [tag + id, testId && `[data-testid=${testId}]`, text && `"${text}"`].filter(Boolean).join(" ");
}

export interface CaptureOptions {
  /** Requests to these URLs are never recorded (the intake endpoint is always ignored). */
  ignoreUrls?: (string | RegExp)[];
  endpoint: string;
  appVersion?: string;
  /**
   * Optional. Return the current route pattern, e.g. "/products/:id".
   * Without it the widget sends location.pathname and the intake service folds
   * ids into a pattern itself ("/products/8421" → "/products/:id"). Pass it for
   * pages whose URLs use readable slugs ("/blog/my-first-post").
   */
  getRoute?: () => string | undefined;
  /** Called after a failed request is recorded (status 0 = no response). */
  onFailedRequest?: (req: FailedRequest) => void;
  /** Called on uncaught exceptions and unhandled promise rejections (not on console.error). */
  onUncaughtError?: (message: string) => void;
}

export function createCapture(opts: CaptureOptions) {
  const consoleErrors: string[] = [];
  const failedRequests: FailedRequest[] = [];
  const breadcrumbs: Breadcrumb[] = [];
  const now = () => new Date().toISOString();

  const absolute = (url: string) => {
    try {
      return new URL(url, location.href).href;
    } catch {
      return url;
    }
  };
  const ignored = (url: string) =>
    absolute(url).startsWith(opts.endpoint) ||
    (opts.ignoreUrls ?? []).some((p) => (typeof p === "string" ? url.startsWith(p) : p.test(url)));

  // Console errors and uncaught exceptions
  const originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    push(consoleErrors, args.map(stringify).join(" ").slice(0, 2000));
    originalConsoleError(...args);
  };
  const uncaught = (message: string) => {
    push(consoleErrors, message);
    try {
      opts.onUncaughtError?.(message);
    } catch {}
  };
  window.addEventListener("error", (e) => {
    // Resource load errors (img/script 404s) have no message; they are not exceptions.
    if (!e.message) return;
    uncaught(`${e.message} (${e.filename}:${e.lineno}:${e.colno})`.slice(0, 2000));
  });
  window.addEventListener("unhandledrejection", (e) => {
    uncaught(`Unhandled rejection: ${stringify(e.reason)}`.slice(0, 2000));
  });

  /** `aborted`: the app cancelled the request itself (AbortController, navigation); recorded, never reported on its own. */
  const failed = (req: FailedRequest, aborted = false) => {
    push(failedRequests, req);
    if (aborted) return;
    try {
      opts.onFailedRequest?.(req);
    } catch {} // a reporting bug must never break the app's own request
  };

  // fetch
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const started = performance.now();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    try {
      const res = await originalFetch(input, init);
      if (!res.ok && !ignored(url)) {
        failed({ method, url, status: res.status, duration_ms: Math.round(performance.now() - started) });
      }
      return res;
    } catch (err) {
      if (!ignored(url)) {
        failed(
          { method, url, status: 0, duration_ms: Math.round(performance.now() - started) },
          (err as { name?: string })?.name === "AbortError",
        );
      }
      throw err;
    }
  };

  // XMLHttpRequest (axios and older libraries)
  const proto = XMLHttpRequest.prototype as any;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  proto.open = function (method: string, url: string | URL, ...rest: unknown[]) {
    this.__glitchback = { method: String(method).toUpperCase(), url: String(url) };
    return originalOpen.call(this, method, url, ...rest);
  };
  proto.send = function (body?: unknown) {
    const meta = this.__glitchback as { method: string; url: string } | undefined;
    const started = performance.now();
    let aborted = false;
    this.addEventListener("abort", () => (aborted = true));
    this.addEventListener("loadend", () => {
      if (meta && (this.status === 0 || this.status >= 400) && !ignored(meta.url)) {
        failed({ ...meta, status: this.status, duration_ms: Math.round(performance.now() - started) }, aborted);
      }
    });
    return originalSend.call(this, body);
  };

  // Breadcrumbs: clicks and SPA navigation
  document.addEventListener(
    "click",
    (e) => {
      const el = e.target as Element | null;
      // Clicks on the widget itself (retargeted to its shadow host) say nothing about the bug.
      if (el?.closest?.("glitchback-root")) return;
      push(breadcrumbs, { type: "click", message: describe(el), at: now() }, 30);
    },
    true,
  );
  const recordNavigation = () =>
    push(breadcrumbs, { type: "navigation", message: location.pathname + location.search, at: now() }, 30);
  for (const fn of ["pushState", "replaceState"] as const) {
    const original = history[fn].bind(history);
    history[fn] = (...args: Parameters<History["pushState"]>) => {
      const result = original(...args);
      recordNavigation();
      return result;
    };
  }
  window.addEventListener("popstate", recordNavigation);

  return {
    /** The untouched fetch, so the widget's own reports never pass through the recorder. */
    fetch: originalFetch,
    snapshot(): ReportContext {
      return {
        url: location.href.split("#")[0], // fragments can hold OAuth tokens
        route: opts.getRoute?.() ?? location.pathname,
        app_version: opts.appVersion,
        user_agent: navigator.userAgent,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        console_errors: [...consoleErrors],
        failed_requests: [...failedRequests],
        breadcrumbs: [...breadcrumbs],
      };
    },
  };
}
