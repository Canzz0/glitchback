/**
 * Machine-readable blocks hidden inside GitHub issue bodies and comments.
 * Content is base64 encoded so it can never contain "-->" and break out of the
 * HTML comment. Readers always take the LAST block, and writers escape "<!--"
 * in user-provided text, so a user cannot spoof a block. The fixer additionally
 * only trusts suggestion blocks written by the bot account.
 */
const b64encode = (s: string) => Buffer.from(s, "utf8").toString("base64");
const b64decode = (s: string) => Buffer.from(s, "base64").toString("utf8");

export type MarkerKind = "data" | "suggestion";

export function encodeMarker(kind: MarkerKind, value: unknown): string {
  return `<!-- bugloop:${kind} ${b64encode(JSON.stringify(value))} -->`;
}

export function decodeMarker<T = unknown>(kind: MarkerKind, text: string | null | undefined): T | null {
  if (!text) return null;
  const re = new RegExp(`<!-- bugloop:${kind} ([A-Za-z0-9+/=]+) -->`, "g");
  const last = [...text.matchAll(re)].at(-1);
  if (!last) return null;
  try {
    return JSON.parse(b64decode(last[1])) as T;
  } catch {
    return null;
  }
}

/** Neutralise user text before putting it into Markdown. */
export function escapeUserText(s: string): string {
  return s
    .replace(/<!--/g, "&lt;!--")
    .replace(/<(\/?[a-z])/gi, "&lt;$1")
    .replace(/@(\w)/g, "@\u200b$1"); // no accidental @mentions
}
