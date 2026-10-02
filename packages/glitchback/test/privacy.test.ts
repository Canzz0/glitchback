import { test } from "node:test";
import assert from "node:assert/strict";
import { maskReport, maskText, maskUrl } from "../src/server/privacy.ts";

test("masks common PII", () => {
  const out = maskText("ali@veli.com, 0532 123 45 67, 4111 1111 1111 1111, tc 12345678901");
  assert.ok(out.includes("[email]"));
  assert.ok(out.includes("[phone]"));
  assert.ok(out.includes("[card]"));
  assert.ok(out.includes("[national-id]"));
  assert.ok(!out.includes("ali@veli.com"));
});

test("masks JWTs and bearer tokens", () => {
  const out = maskText("Authorization: Bearer abc.def-ghi and eyJhbGciOi.eyJzdWIi.sig123456");
  assert.ok(out.includes("[token]"));
  assert.ok(!out.includes("eyJhbGciOi.eyJzdWIi"));
});

test("redacts sensitive URL query params but keeps the shape", () => {
  const out = maskUrl("https://a.com/pay?token=abc&order=5&email=x@y.com");
  assert.ok(out.includes("token=REDACTED"));
  assert.ok(out.includes("email=REDACTED"));
  assert.ok(out.includes("order=5"));
});

test("sensitive params inside console text and navigation breadcrumbs are redacted", () => {
  const r = maskReport({
    schema_version: "1.0",
    project_key: "k",
    user_message: "broken",
    source: "user_report",
    context: {
      url: "https://a.com/x",
      console_errors: ["GET https://api.a.com/me?access_token=abc123&lang=tr 401"],
      failed_requests: [],
      breadcrumbs: [{ type: "navigation", message: "/reset?code=998877&step=2", at: "t" }],
    },
  } as any);
  assert.ok(!r.context.console_errors[0].includes("abc123"));
  assert.ok(r.context.console_errors[0].includes("lang=tr"));
  assert.ok(!r.context.breadcrumbs[0].message.includes("998877"));
  assert.ok(r.context.breadcrumbs[0].message.includes("step=2"));
});

test("fragments and tokens in URL paths never leave the server", () => {
  const a = maskUrl("https://shop.com/auth/callback#access_token=ya29.SECRET&token_type=bearer");
  assert.ok(!a.includes("SECRET") && !a.includes("#"));
  const b = maskUrl("https://shop.com/reset-password/9f8e7d6c5b4a39281706f5e4d3c2b1a0");
  assert.ok(!b.includes("9f8e7d6c5b4a"));
  const c = maskUrl("https://shop.com/invite/AB12CD34");
  assert.ok(!c.includes("AB12CD34"));
  const keep = maskUrl("https://shop.com/orders/3f2b8c1e-9d4a-4f6b-8e2a-1c5d7e9f0a3b/items/42");
  assert.ok(keep.includes("3f2b8c1e-9d4a") && keep.includes("/items/42"), "record ids stay for debugging");
  const t = maskText("GET https://api.shop.com/verify/eyJabcdefgh12345678xyz?lang=tr 401");
  assert.ok(!t.includes("eyJabcdefgh12345678xyz") && t.includes("lang=tr"));
});
