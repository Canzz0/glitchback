import type { ReportContext, ReportInput } from "../schema/index.ts";
import { createAutoReporter, type AutoReporter, type AutoReportOptions } from "./auto.ts";
import { createCapture, type CaptureOptions } from "./capture.ts";
import { LABELS, detectLocale, type Labels } from "./i18n.ts";

export type { AutoReportOptions } from "./auto.ts";
export { labelsEN, labelsTR, type Labels } from "./i18n.ts";

export interface GlitchbackOptions extends Omit<CaptureOptions, "endpoint" | "onFailedRequest" | "onUncaughtError"> {
  /**
   * Where reports are sent. Defaults to "/api/glitchback", the route `npx glitchback init`
   * adds to your app. For a separate `glitchback serve` server use its full URL.
   */
  endpoint?: string;
  /** Only needed when the server sets GLITCHBACK_PROJECT_KEY. */
  projectKey?: string;
  /** Show the floating button. Set false to open the form yourself with Glitchback.open(). */
  button?: boolean;
  /** Ask for an optional email so the team can follow up. */
  askContact?: boolean;
  /**
   * "tr", "en" or "auto" (default): the page's <html lang>, then the browser language.
   * Turkish pages get Turkish, everything else English.
   */
  locale?: "tr" | "en" | "auto";
  /** Override any text. Applied on top of the detected language. */
  labels?: Partial<Labels>;
  /** "auto" (default) follows the page: a dark page background gets the dark widget. */
  theme?: "light" | "dark" | "auto";
  /** "right" (default) or "left". */
  position?: "right" | "left";
  /**
   * Send a report by itself, without the user pressing the button, when a request fails
   * (400+ except 401/403/404/429, or no response) or an uncaught error is thrown.
   * On by default; `false` turns it off, an object tunes it. The server can also turn
   * it off for every site with GLITCHBACK_AUTO_REPORTS=off.
   */
  autoReport?: boolean | AutoReportOptions;
}

const ICON_REPORT = `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M4 3.5h12a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H9l-3.6 2.7a.5.5 0 0 1-.8-.4V14.5H4A1.5 1.5 0 0 1 2.5 13V5A1.5 1.5 0 0 1 4 3.5Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M10 6.5v3.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="10" cy="11.9" r=".95" fill="currentColor"/></svg>`;
const ICON_CLOSE = `<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M5.5 5.5l9 9m0-9l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6.5 12.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/*
 * The widget lives inside other people's sites, so it borrows their font, stays neutral,
 * and lets them restyle it with --glitchback-* variables. Everything is in a shadow root.
 */
const STYLE = `
:host { all: initial; font-family: inherit; color-scheme: light;
  --pb-accent: var(--glitchback-accent, #2557c4);
  --pb-on-accent: var(--glitchback-on-accent, #ffffff);
  --pb-bg: var(--glitchback-bg, #ffffff);
  --pb-fg: var(--glitchback-fg, #17191e);
  --pb-muted: var(--glitchback-muted, #5d6371);
  --pb-border: var(--glitchback-border, #e2e4e9);
  --pb-subtle: var(--glitchback-subtle, #f5f6f8);
  --pb-danger: #b42318; --pb-success: #1d7a4c; --pb-success-bg: #e7f4ed;
  --pb-shadow: 0 1px 2px rgba(16,18,24,.06), 0 12px 32px -8px rgba(16,18,24,.18);
  --pb-radius: var(--glitchback-radius, 14px);
}
:host([data-theme="dark"]) { color-scheme: dark;
  --pb-accent: var(--glitchback-accent, #7aa2ff);
  --pb-on-accent: var(--glitchback-on-accent, #0e1424);
  --pb-bg: var(--glitchback-bg, #1b1d22);
  --pb-fg: var(--glitchback-fg, #eceef2);
  --pb-muted: var(--glitchback-muted, #a3a8b3);
  --pb-border: var(--glitchback-border, #30333b);
  --pb-subtle: var(--glitchback-subtle, #23262c);
  --pb-danger: #ff8a7a; --pb-success: #6fd3a0; --pb-success-bg: #1f3329;
  --pb-shadow: 0 1px 2px rgba(0,0,0,.3), 0 16px 40px -8px rgba(0,0,0,.6);
}
* { box-sizing: border-box; font-family: inherit; margin: 0; }
button { font: inherit; }

.fab { position: fixed; bottom: 20px; z-index: 2147483000; display: inline-flex; align-items: center; gap: 8px;
  height: 40px; padding: 0 16px 0 14px; border-radius: 999px; border: 1px solid var(--pb-border);
  background: var(--pb-bg); color: var(--pb-fg); font-size: 14px; font-weight: 500; letter-spacing: -.005em;
  cursor: pointer; box-shadow: var(--pb-shadow); transition: border-color .15s, transform .15s; }
.fab svg { color: var(--pb-accent); flex: none; }
.fab:hover { border-color: color-mix(in srgb, var(--pb-accent) 45%, var(--pb-border)); }
.fab:active { transform: translateY(1px); }
.fab[aria-expanded="true"] { visibility: hidden; }
.right { right: 20px; } .left { left: 20px; }

.backdrop { position: fixed; inset: 0; z-index: 2147483001; background: transparent; }
.panel { position: fixed; bottom: 20px; z-index: 2147483002; width: 380px; max-height: calc(100vh - 40px); overflow: auto;
  display: flex; flex-direction: column; background: var(--pb-bg); color: var(--pb-fg);
  border: 1px solid var(--pb-border); border-radius: var(--pb-radius); box-shadow: var(--pb-shadow);
  transform-origin: bottom right; animation: pb-in .18s cubic-bezier(.2,.8,.2,1); }
.panel.left { transform-origin: bottom left; }
@keyframes pb-in { from { opacity: 0; transform: translateY(8px) scale(.98); } }

header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 18px 18px 0 20px; }
h2 { font-size: 16px; font-weight: 600; line-height: 1.35; letter-spacing: -.01em; }
.sub { font-size: 13.5px; color: var(--pb-muted); margin-top: 2px; line-height: 1.45; }
.x { display: grid; place-items: center; width: 32px; height: 32px; margin: -6px -6px 0 0; border: 0; border-radius: 8px;
  background: transparent; color: var(--pb-muted); cursor: pointer; flex: none; }
.x:hover { background: var(--pb-subtle); color: var(--pb-fg); }

.body { padding: 16px 20px 0; display: grid; gap: 14px; }
textarea, input { width: 100%; border: 1px solid var(--pb-border); border-radius: 10px; padding: 10px 12px;
  font-size: 14.5px; line-height: 1.5; color: var(--pb-fg); background: var(--pb-bg); transition: border-color .15s, box-shadow .15s; }
textarea { min-height: 112px; resize: vertical; display: block; }
textarea::placeholder, input::placeholder { color: color-mix(in srgb, var(--pb-muted) 80%, transparent); }
textarea:focus, input:focus { outline: none; border-color: var(--pb-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--pb-accent) 22%, transparent); }
textarea[aria-invalid="true"] { border-color: var(--pb-danger); }
.field label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; }
.field .hint { font-weight: 400; color: var(--pb-muted); }
.error { font-size: 13px; color: var(--pb-danger); line-height: 1.45; margin-top: -6px; }

.attached { background: var(--pb-subtle); border-radius: 10px; padding: 12px 14px; font-size: 13px; color: var(--pb-muted); line-height: 1.5; }
.attached p { color: var(--pb-fg); font-weight: 500; margin-bottom: 4px; }
.attached ul { list-style: none; padding: 0; display: grid; gap: 2px; }
.attached li { display: flex; gap: 8px; align-items: baseline; }
.attached li::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: .55; flex: none; transform: translateY(-2px); }
.attached li.hot::before { background: var(--pb-danger); opacity: 1; }
.attached .privacy { margin-top: 8px; }

footer { display: flex; gap: 8px; justify-content: flex-end; padding: 16px 20px 20px; }
.btn { height: 38px; padding: 0 16px; border-radius: 10px; font-size: 14px; font-weight: 500; cursor: pointer; transition: background .15s, border-color .15s, opacity .15s; }
.primary { background: var(--pb-accent); color: var(--pb-on-accent); border: 1px solid transparent; }
.primary:hover { background: color-mix(in srgb, var(--pb-accent) 88%, var(--pb-fg)); }
.secondary { background: transparent; color: var(--pb-fg); border: 1px solid var(--pb-border); }
.secondary:hover { background: var(--pb-subtle); }
.btn:disabled { opacity: .6; cursor: progress; }

.done { padding: 28px 24px 22px; text-align: center; display: grid; justify-items: center; gap: 6px; }
.badge { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; background: var(--pb-success-bg); color: var(--pb-success); margin-bottom: 6px; }
.done .btn { margin-top: 14px; min-width: 120px; }

button:focus-visible, .x:focus-visible { outline: 2px solid var(--pb-accent); outline-offset: 2px; }

@media (max-width: 520px) {
  .fab { bottom: 16px; } .right { right: 16px; } .left { left: 16px; }
  .backdrop { background: rgba(10,12,16,.4); }
  .panel, .panel.left, .panel.right { left: 0; right: 0; bottom: 0; width: auto; max-height: 92vh;
    border-radius: var(--pb-radius) var(--pb-radius) 0 0; border-bottom: 0; animation-name: pb-sheet; }
  footer { padding-bottom: max(20px, env(safe-area-inset-bottom)); }
  footer .btn { flex: 1; }
  @keyframes pb-sheet { from { transform: translateY(24px); opacity: 0; } }
}
@media (prefers-reduced-motion: reduce) { .panel, .fab { animation: none; transition: none; } }
`;

/** Luminance of the first non-transparent background up from <body>. */
function pageIsDark(): boolean {
  for (const el of [document.body, document.documentElement]) {
    if (!el) continue;
    const m = getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]+)\)/);
    if (!m) continue;
    const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (a === 0) continue;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 110;
  }
  return false;
}

let instance: { open: () => void } | null = null;

export function init(options: GlitchbackOptions = {}) {
  if (instance) return instance;
  if (typeof window === "undefined") return { open() {} }; // SSR no-op

  const endpoint = new URL(options.endpoint ?? "/api/glitchback", location.href).href;
  const locale = detectLocale(options.locale);
  const t: Labels = { ...LABELS[locale], ...options.labels };
  const side = options.position === "left" ? "left" : "right";

  let auto: AutoReporter | null = null;
  const capture = createCapture({
    ...options,
    endpoint,
    onFailedRequest: (req) => auto?.onFailedRequest(req),
    onUncaughtError: (message) => auto?.onUncaughtError(message),
  });
  if (options.autoReport !== false) {
    auto = createAutoReporter(options.autoReport === true || !options.autoReport ? {} : options.autoReport, {
      endpoint,
      projectKey: options.projectKey,
      snapshot: () => capture.snapshot(),
      fetch: capture.fetch,
    });
  }

  const host = document.createElement("glitchback-root");
  host.setAttribute("lang", locale);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${STYLE}</style>`;
  document.body.appendChild(host);

  const applyTheme = () =>
    host.setAttribute("data-theme", options.theme === "dark" || (options.theme !== "light" && pageIsDark()) ? "dark" : "light");
  applyTheme();

  let fab: HTMLButtonElement | null = null;
  if (options.button !== false) {
    fab = document.createElement("button");
    fab.className = `fab ${side}`;
    fab.type = "button";
    fab.setAttribute("aria-haspopup", "dialog");
    fab.setAttribute("aria-expanded", "false");
    fab.innerHTML = `${ICON_REPORT}<span></span>`;
    fab.querySelector("span")!.textContent = t.button;
    fab.addEventListener("click", () => open());
    root.appendChild(fab);
  }

  let openDialog: { focus: () => void } | null = null;

  function attachedList(ctx: ReportContext): string {
    const items: [string, boolean][] = [[t.attachedPage, false]];
    if (ctx.console_errors.length) items.push([t.attachedErrors(ctx.console_errors.length), true]);
    if (ctx.failed_requests.length) items.push([t.attachedRequests(ctx.failed_requests.length), true]);
    if (ctx.breadcrumbs.length) items.push([t.attachedActions(ctx.breadcrumbs.length), false]);
    return items.map(([text, hot]) => `<li${hot ? ' class="hot"' : ""}>${escapeHtml(text)}</li>`).join("");
  }

  function open() {
    // Already open (e.g. open() called twice): bring it back instead of stacking a second dialog.
    if (openDialog) return openDialog.focus();
    applyTheme(); // the page may have switched theme since load
    const previousFocus = document.activeElement as HTMLElement | null;
    // Snapshot BEFORE the user starts typing, so the form itself is not in the context.
    const context = capture.snapshot();

    const backdrop = document.createElement("div");
    backdrop.className = "backdrop";
    const panel = document.createElement("div");
    panel.className = `panel ${side}`;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "pb-title");
    panel.setAttribute("aria-describedby", "pb-sub");

    function renderForm() {
      panel.innerHTML = `
        <header>
          <div><h2 id="pb-title"></h2><p class="sub" id="pb-sub"></p></div>
          <button type="button" class="x" data-close>${ICON_CLOSE}</button>
        </header>
        <div class="body">
          <textarea id="pb-msg" aria-labelledby="pb-sub" aria-describedby="pb-error"></textarea>
          <p class="error" id="pb-error" role="alert" hidden></p>
          ${options.askContact ? `<div class="field"><label for="pb-contact"><span></span> <span class="hint"></span></label><input id="pb-contact" type="email" autocomplete="email" inputmode="email"></div>` : ""}
          <div class="attached"><p></p><ul>${attachedList(context)}</ul><div class="privacy"></div></div>
        </div>
        <footer>
          <button type="button" class="btn secondary" data-close></button>
          <button type="button" class="btn primary" id="pb-send"></button>
        </footer>`;
      const $ = <T extends HTMLElement>(sel: string) => panel.querySelector(sel) as T;
      $("#pb-title").textContent = t.title;
      $("#pb-sub").textContent = t.subtitle;
      $(".x").setAttribute("aria-label", t.close);
      $(".attached p").textContent = t.attachedTitle;
      $(".privacy").textContent = t.privacy;
      $("footer .secondary").textContent = t.cancel;
      const msg = $<HTMLTextAreaElement>("#pb-msg");
      msg.placeholder = t.placeholder;
      if (options.askContact) {
        const spans = panel.querySelectorAll(".field label span");
        spans[0].textContent = t.contact;
        spans[1].textContent = t.contactHint;
      }
      const send = $<HTMLButtonElement>("#pb-send");
      const error = $("#pb-error");
      send.textContent = t.send;
      panel.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));

      const showError = (text: string) => {
        error.textContent = text;
        error.hidden = false;
      };
      msg.addEventListener("input", () => {
        error.hidden = true;
        msg.removeAttribute("aria-invalid");
      });
      msg.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send.click();
      });

      send.addEventListener("click", async () => {
        const text = msg.value.trim();
        if (text.length < 3) {
          showError(t.tooShort);
          msg.setAttribute("aria-invalid", "true");
          msg.focus();
          return;
        }
        send.disabled = true;
        send.textContent = t.sending;
        const payload: ReportInput = {
          schema_version: "1.0",
          ...(options.projectKey ? { project_key: options.projectKey } : {}),
          user_message: text,
          contact: options.askContact ? ($<HTMLInputElement>("#pb-contact").value.trim() || undefined) : undefined,
          source: "user_report",
          context,
        };
        try {
          const res = await capture.fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!res.ok) throw Object.assign(new Error("request failed"), { status: res.status });
          renderDone();
        } catch (err) {
          showError((err as { status?: number }).status === 429 ? t.rateLimited : t.failed);
          send.disabled = false;
          send.textContent = t.send;
        }
      });
      msg.focus();
    }

    function renderDone() {
      panel.setAttribute("aria-describedby", "pb-done-body");
      panel.innerHTML = `
        <div class="done">
          <div class="badge">${ICON_CHECK}</div>
          <h2 id="pb-title"></h2>
          <p class="sub" id="pb-done-body"></p>
          <button type="button" class="btn primary"></button>
        </div>`;
      panel.querySelector("h2")!.textContent = t.sent;
      panel.querySelector(".sub")!.textContent = t.sentBody;
      const done = panel.querySelector<HTMLButtonElement>(".btn")!;
      done.textContent = t.done;
      done.addEventListener("click", close);
      done.focus();
    }

    function close() {
      backdrop.remove();
      panel.remove();
      document.removeEventListener("keydown", onKey, true);
      openDialog = null;
      fab?.setAttribute("aria-expanded", "false");
      (previousFocus && previousFocus !== document.body ? previousFocus : fab)?.focus?.();
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") return close();
      if (e.key !== "Tab") return;
      // Keep keyboard focus inside the dialog while it is open.
      const focusable = [...panel.querySelectorAll<HTMLElement>("textarea, input, button:not([disabled])")];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = root.activeElement;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("click", close);
    root.append(backdrop, panel);
    fab?.setAttribute("aria-expanded", "true");
    renderForm();
    openDialog = { focus: () => (panel.querySelector<HTMLElement>("textarea, .btn") ?? panel).focus() };
  }

  instance = { open };
  return instance;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function open() {
  if (!instance) throw new Error("Glitchback.init() must be called first");
  instance.open();
}
