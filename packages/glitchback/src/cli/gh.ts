import { LABELS } from "../server/github.ts";
import { hasCommand, run } from "./util.ts";

/** The GitHub CLI, when installed and logged in, sets up labels and secrets without any token pasting. */
export function ghReady(): boolean {
  return hasCommand("gh") && run("gh", ["auth", "status"], { quiet: true }).ok;
}

export function ghToken(): string | null {
  const r = run("gh", ["auth", "token"], { quiet: true });
  return r.ok && r.stdout ? r.stdout : null;
}

export function ghCreateLabels(repo: string): boolean {
  let all = true;
  for (const l of Object.values(LABELS)) {
    const r = run("gh", ["label", "create", l.name, "--color", l.color, "--description", l.description, "--force", "--repo", repo], { quiet: true });
    all &&= r.ok;
  }
  return all;
}

export function ghSetSecret(repo: string, name: string, value: string): boolean {
  return run("gh", ["secret", "set", name, "--repo", repo], { input: value }).ok;
}
