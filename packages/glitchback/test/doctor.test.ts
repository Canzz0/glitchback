import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { init } from "../src/cli/init.ts";
import { doctor, type DoctorItem } from "../src/cli/doctor.ts";
import { checkGithubToken, checkModelKey } from "../src/cli/checks.ts";

const KEYS = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "TRIAGE_MODEL", "TYPESAFE_API_KEY", "GLITCHBACK_GITHUB_TOKEN", "GLITCHBACK_GITHUB_REPO", "GITHUB_TOKEN", "GITHUB_REPOSITORY"];

function nextApp(): string {
  const root = mkdtempSync(join(tmpdir(), "pb-doctor-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "shop", dependencies: { next: "15.2.1", react: "19.0.0" } }),
    "tsconfig.json": `{ "compilerOptions": { "paths": { "@/*": ["./*"] } } }`,
    "package-lock.json": "{}",
    ".gitignore": "node_modules\n",
    "app/layout.tsx": `export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html>\n      <body>{children}</body>\n    </html>\n  );\n}\n`,
    "app/page.tsx": "export default function Home() { return null }",
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/shop.git"], { cwd: root });
  return root;
}

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;
/** Every network call in a test goes through here; anything unexpected is a connection error. */
function withFetch<T>(route: Route, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return route(url, init);
  }) as typeof fetch;
  return fn().finally(() => (globalThis.fetch = original));
}

const okGitHub: Route = (url, init) => {
  if (url.endsWith("/repos/acme/shop")) return Response.json({ full_name: "acme/shop" });
  if (url.endsWith("/repos/acme/shop/labels") && init.method === "POST") return new Response("{}", { status: 422 });
  if (url.includes("/models")) return Response.json({ data: [] });
  throw new TypeError("fetch failed"); // dev server not running
};

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = original;
  }
}

async function setUp(env: Record<string, string>) {
  const root = nextApp();
  const saved = { ...process.env };
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  await quietly(() => init({ dir: root, yes: true, install: false, force: false, useGh: false }));
  // doctor reads the app's .env files; the shell's variables must not leak in.
  for (const k of KEYS) delete process.env[k];
  return { root, restore: () => { process.env = saved; rmSync(root, { recursive: true, force: true }); } };
}

const find = (items: DoctorItem[], re: RegExp) => items.find((i) => re.test(i.name));

test("a finished setup is all green (dev server not running is not an error)", async () => {
  const { root, restore } = await setUp({ GEMINI_API_KEY: "g", GLITCHBACK_GITHUB_TOKEN: "github_pat_x" });
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "shop", dependencies: { next: "15.2.1", glitchback: "^0.1.0" } }));
    const r = await withFetch(okGitHub, () => quietly(() => doctor({ dir: root, useGh: false })));
    assert.deepEqual(r.items.filter((i) => i.state === "fail").map((i) => i.name), []);
    assert.equal(r.exitCode, 0);
    assert.equal(find(r.items, /GitHub issue/i)?.state, "ok");
    assert.equal(find(r.items, /Yapay zekâ|^AI$/i)?.state, "ok");
    assert.equal(find(r.items, /Geliştirme sunucusu|Dev server/i)?.state, "off");
  } finally {
    restore();
  }
});

test("a token that GitHub rejects is an error with a way to fix it", async () => {
  const { root, restore } = await setUp({ GLITCHBACK_GITHUB_TOKEN: "github_pat_bad" });
  try {
    const r = await withFetch((url, init) => (url.includes("api.github.com") ? new Response("{}", { status: 401 }) : okGitHub(url, init)), () => quietly(() => doctor({ dir: root, useGh: false })));
    const gh = find(r.items, /GitHub issue/i)!;
    assert.equal(gh.state, "fail");
    assert.match(gh.fix ?? "", /personal-access-tokens/);
    assert.equal(r.exitCode, 1);
  } finally {
    restore();
  }
});

test("checkGithubToken tells access and the Issues permission apart", async () => {
  const run = (repoStatus: number, labelStatus: number) =>
    withFetch((url) => new Response("{}", { status: url.endsWith("/labels") ? labelStatus : repoStatus }), () => checkGithubToken("t", "acme/shop"));
  assert.equal((await run(200, 201)).ok, true);
  assert.equal((await run(200, 422)).ok, true, "label already there: write access proven");
  const noWrite = await run(200, 403);
  assert.equal(noWrite.ok, false);
  assert.match(!noWrite.ok ? noWrite.reason : "", /Issues/);
  const noRepo = await run(404, 201);
  assert.match(!noRepo.ok ? noRepo.reason : "", /acme\/shop/);
  const offline = await withFetch(() => { throw new TypeError("fetch failed"); }, () => checkGithubToken("t", "acme/shop"));
  assert.equal(offline.ok, false);
});

test("checkModelKey: 200 is valid, 401 is not, and the key goes in the provider's header", async () => {
  let seen: Headers | null = null;
  const valid = await withFetch((url, init) => { seen = new Headers(init.headers); return Response.json({ data: [] }); }, () => checkModelKey("anthropic", "sk-ant", {}));
  assert.equal(valid.ok, true);
  assert.equal(seen!.get("x-api-key"), "sk-ant");
  const bad = await withFetch(() => new Response("{}", { status: 401 }), () => checkModelKey("gemini", "nope", {}));
  assert.equal(bad.ok, false);
});

test("a project without the Glitchback files gets a fix for each missing piece", async () => {
  const root = nextApp();
  const saved = { ...process.env };
  for (const k of KEYS) delete process.env[k];
  try {
    const r = await withFetch(okGitHub, () => quietly(() => doctor({ dir: root, useGh: false })));
    for (const re of [/glitchback paketi|glitchback package/i, /uç nokta|endpoint/i, /bileşen|component/i, /layout/i]) {
      const item = find(r.items, re);
      assert.equal(item?.state, "fail", String(re));
      assert.ok(item?.fix, `${re} has a fix`);
    }
    assert.equal(r.exitCode, 1);
  } finally {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a running dev server that does not see the token is flagged; --test shows the new issue", async () => {
  const { root, restore } = await setUp({ GLITCHBACK_GITHUB_TOKEN: "github_pat_x" });
  try {
    let posted: any = null;
    const route: Route = (url, init) => {
      if (url.startsWith("http://localhost:3000/api/glitchback")) {
        if (init.method === "POST") {
          posted = JSON.parse(String(init.body));
          return Response.json({ ok: true, report_id: "rpt_1", issue_url: "https://github.com/acme/shop/issues/9" }, { status: 202 });
        }
        return Response.json({ ok: true, github: false, triage: "rules", auto_reports: true });
      }
      return okGitHub(url, init);
    };
    const r = await withFetch(route, () => quietly(() => doctor({ dir: root, useGh: false, test: true })));
    const dev = find(r.items, /Geliştirme sunucusu|Dev server/i)!;
    assert.equal(dev.state, "warn");
    assert.match(dev.fix ?? "", /yeniden başlatın|restart/i);
    const sent = find(r.items, /Test raporu|Test report/i)!;
    assert.equal(sent.state, "ok");
    assert.match(sent.note ?? "", /issues\/9/);
    assert.equal(posted.schema_version, "1.0");
  } finally {
    restore();
  }
});

test("after switching AI, doctor reports the one TRIAGE_MODEL names, not the first key it finds", async () => {
  const { root, restore } = await setUp({ GEMINI_API_KEY: "g" });
  try {
    writeFileSync(join(root, ".env.local"), "GEMINI_API_KEY=g\nANTHROPIC_API_KEY=a\nTRIAGE_MODEL=anthropic:claude-sonnet-5-5\n");
    let keyHeader: string | null = null;
    const r = await withFetch((url, init) => {
      if (url.includes("anthropic.com")) keyHeader = new Headers(init.headers).get("x-api-key");
      return okGitHub(url, init);
    }, () => quietly(() => doctor({ dir: root, useGh: false })));
    const ai = find(r.items, /Yapay zekâ|^AI$/i)!;
    assert.match(ai.note ?? "", /Anthropic/);
    assert.equal(keyHeader, "a", "the Anthropic key is the one checked");
  } finally {
    restore();
  }
});

/* ---- Auto-fix ön koşulları ---- */
function setOriginHead(root: string) {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", sha], { cwd: root });
  execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: root });
}

test("auto-fix needs the workflow on the default branch: doctor says so until it is pushed there", async () => {
  const { root, restore } = await setUp({ GEMINI_API_KEY: "g", GLITCHBACK_GITHUB_TOKEN: "github_pat_x" });
  try {
    setOriginHead(root);
    const before = await withFetch(okGitHub, () => quietly(() => doctor({ dir: root, useGh: false })));
    const item = find(before.items, /varsayılan branch|default branch/i)!;
    assert.equal(item.state, "warn");
    assert.match(item.fix ?? "", /git push/);
    assert.match(item.note ?? "", /main/);

    // Committed and on origin/main: fine.
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "glitchback"], { cwd: root });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });
    const after = await withFetch(okGitHub, () => quietly(() => doctor({ dir: root, useGh: false })));
    assert.equal(find(after.items, /varsayılan branch|default branch/i)?.state, "ok");
  } finally {
    restore();
  }
});

test("doctor checks that Actions may open pull requests (needed for autofix)", async () => {
  const { root, restore } = await setUp({ GEMINI_API_KEY: "g", GLITCHBACK_GITHUB_TOKEN: "github_pat_x" });
  try {
    const ghOff = (out: string) => (args: string[]) =>
      args.some((a) => a.includes("permissions/workflow")) ? { ok: true, stdout: out, stderr: "" } : { ok: true, stdout: "GEMINI_API_KEY\t2026-10-19", stderr: "" };
    const off = await withFetch(okGitHub, () => quietly(() => doctor({ dir: root, ghRun: ghOff('{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}') })));
    const pr = find(off.items, /PR izni|PR permission/i)!;
    assert.equal(pr.state, "warn");
    assert.match(pr.fix ?? "", /settings\/actions/);
    assert.match(pr.note ?? "", /Allow GitHub Actions to create and approve pull requests/);
    const on = await withFetch(okGitHub, () => quietly(() => doctor({ dir: root, ghRun: ghOff('{"can_approve_pull_request_reviews":true}') })));
    assert.equal(find(on.items, /PR izni|PR permission/i)?.state, "ok");
    // Without gh it cannot be checked: says where to look instead.
    const noGh = await withFetch(okGitHub, () => quietly(() => doctor({ dir: root, useGh: false })));
    assert.match(find(noGh.items, /PR izni|PR permission/i)?.fix ?? "", /settings\/actions/);
  } finally {
    restore();
  }
});
