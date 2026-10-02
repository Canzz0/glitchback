/** A code fence longer than any backtick run inside the text, so the content cannot close it early. */
export function fence(s: string): string {
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));
  return "`".repeat(Math.max(3, longest + 1));
}
