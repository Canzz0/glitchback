import { env } from "./config.ts";

const API = "https://api.github.com";

async function gh<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env("GITHUB_TOKEN")}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!res.ok) throw Object.assign(new Error(`GitHub ${init.method ?? "GET"} ${path} → ${res.status}`), { status: res.status });
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const repo = () => env("GITHUB_REPOSITORY");

export interface Comment {
  body: string;
  user: { login: string };
}

export const comment = (issue: number, body: string) =>
  gh(`/repos/${repo()}/issues/${issue}/comments`, { method: "POST", body: JSON.stringify({ body }) });

/** All comments, oldest first. Popular bugs collect many duplicate-report comments, so this pages through them. */
export async function listComments(issue: number): Promise<Comment[]> {
  const all: Comment[] = [];
  for (let page = 1; page <= 50; page++) {
    const batch = await gh<Comment[]>(`/repos/${repo()}/issues/${issue}/comments?per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

export const removeLabel = (issue: number, name: string) =>
  gh(`/repos/${repo()}/issues/${issue}/labels/${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => {});

export async function openPullRequest(head: string, base: string, title: string, body: string) {
  try {
    return await gh<{ html_url: string; number: number }>(`/repos/${repo()}/pulls`, {
      method: "POST",
      body: JSON.stringify({ head, base, title, body }),
    });
  } catch (err) {
    if ((err as { status?: number }).status !== 422) throw err;
    // A PR for this branch already exists (re-run): return it.
    const owner = repo().split("/")[0];
    const open = await gh<{ html_url: string; number: number }[]>(`/repos/${repo()}/pulls?head=${owner}:${head}&state=open`);
    if (!open[0]) throw err;
    return open[0];
  }
}

export const defaultBranch = async () => (await gh<{ default_branch: string }>(`/repos/${repo()}`)).default_branch;

/** True for admin, maintain and write; false for triage, read or no access. */
export async function canWrite(login: string): Promise<boolean> {
  try {
    const r = await gh<{ permission: string; role_name?: string }>(
      `/repos/${repo()}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    return ["admin", "maintain", "write"].includes(r.role_name ?? "") || ["admin", "write"].includes(r.permission);
  } catch {
    return false;
  }
}
