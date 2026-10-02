import type { ReportInput } from "../schema/index.ts";

/**
 * Best-effort masking of personal data BEFORE anything is sent to a model or
 * written to GitHub. Regexes are not perfect; keep the widget from collecting
 * sensitive data in the first place (it never reads form values).
 */
const RULES: [RegExp, string][] = [
  [/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[token]"], // JWT
  [/\bBearer\s+[\w.~+/-]+=*/gi, "Bearer [token]"],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  [/\b\d(?:[ -]?\d){12,18}\b/g, "[card]"], // card-like digit runs
  [/\b[1-9]\d{10}\b/g, "[national-id]"], // e.g. TC kimlik no
  [/(?:\+?90[ .-]?)?\(?0?5\d{2}\)?[ .-]?\d{3}[ .-]?\d{2}[ .-]?\d{2}\b/g, "[phone]"], // TR mobile
  [/\+\d{1,3}[ .-]?\d{2,4}[ .-]?\d{3,4}[ .-]?\d{3,4}\b/g, "[phone]"], // international
];

const SENSITIVE_QUERY = /token|key|secret|pass|pwd|code|session|auth|sig|email|phone/i;

/**
 * Query (and fragment) parameters inside free text (stack traces, console messages, navigation
 * breadcrumbs), absolute or relative: "?session=abc&page=2" → "?session=REDACTED&page=2".
 */
const QUERY_PARAM_IN_TEXT = /([?&;#])([^=\s&#;?"'<>]+)=([^&\s#;"'<>]*)/g;

function redactParamsInText(s: string): string {
  return s.replace(QUERY_PARAM_IN_TEXT, (m, sep: string, key: string) =>
    SENSITIVE_QUERY.test(key) ? `${sep}${key}=REDACTED` : m,
  );
}

/** Path segments right after these carry a secret: /reset-password/<token>, /invite/<code>. */
const SECRET_AFTER = /^(reset|reset-password|password-reset|forgot-password|verify|verify-email|verification|confirm|confirmation|activate|activation|invite|invitation|join|magic|magic-link|token|tokens|unsubscribe|auth|callback|signin|sign-in|login|share|download|key|keys)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
/** Long, mixed letters and digits: what tokens look like, and what record ids (UUIDs, ObjectIds) are excluded from. */
const TOKENISH = /^(?=[^/]*\d)(?=[^/]*[A-Za-z])[A-Za-z0-9_\-.~%=+]{20,}$/;

function maskPath(pathname: string): string {
  const segs = pathname.split("/");
  return segs
    .map((seg, i) => {
      if (!seg) return seg;
      let d = seg;
      try {
        d = decodeURIComponent(seg);
      } catch {}
      if (UUID.test(d) || OBJECT_ID.test(d)) return seg;
      if (TOKENISH.test(d)) return "[redacted]";
      if (i > 0 && SECRET_AFTER.test(segs[i - 1]) && d.length >= 8 && /\d/.test(d)) return "[redacted]";
      return seg;
    })
    .join("/");
}

/** Query, fragment and path handling only; maskText adds the PII rules. */
function maskUrlParts(raw: string): string {
  try {
    const u = new URL(raw, "http://placeholder.invalid");
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_QUERY.test(key)) u.searchParams.set(key, "REDACTED");
    }
    // Fragments carry OAuth implicit-flow tokens (#access_token=...) and are never needed to debug.
    u.hash = "";
    u.pathname = maskPath(u.pathname);
    return u.origin === "http://placeholder.invalid" ? u.pathname + u.search : u.toString();
  } catch {
    return raw;
  }
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>()]+/g;

export function maskText(s: string): string {
  const withUrls = s.replace(URL_IN_TEXT, (m) => maskUrlParts(m));
  return RULES.reduce((acc, [re, rep]) => acc.replace(re, rep), redactParamsInText(withUrls));
}

export function maskUrl(raw: string): string {
  return maskText(maskUrlParts(raw));
}

export function maskReport(r: ReportInput): ReportInput {
  return {
    ...r,
    user_message: maskText(r.user_message),
    trigger:
      r.trigger?.kind === "request"
        ? { ...r.trigger, url: maskUrl(r.trigger.url) }
        : r.trigger?.kind === "error"
          ? { ...r.trigger, message: maskText(r.trigger.message) }
          : undefined,
    contact: r.contact, // kept on purpose: the user typed it to be contacted. Not sent to models.
    context: {
      ...r.context,
      url: maskUrl(r.context.url),
      console_errors: r.context.console_errors.map(maskText),
      failed_requests: r.context.failed_requests.map((f) => ({ ...f, url: maskUrl(f.url) })),
      breadcrumbs: r.context.breadcrumbs.map((b) => ({
        ...b,
        message: b.type === "navigation" ? maskUrl(b.message) : maskText(b.message),
      })),
    },
  };
}
