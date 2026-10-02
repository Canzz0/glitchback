import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint } from "../src/server/fingerprint.ts";

const base = {
  schema_version: "1.0" as const,
  project_key: "k",
  user_message: "checkout is broken",
  source: "user_report" as const,
  context: {
    url: "https://app.acme.com/checkout?session=abc123",
    route: "/checkout",
    console_errors: ["TypeError: Cannot read properties of undefined (reading 'total') at Cart.tsx:42:10"],
    failed_requests: [{ method: "POST", url: "https://app.acme.com/api/pay/9982", status: 500 }],
    breadcrumbs: [],
  },
};

test("same bug with volatile ids produces the same fingerprint", () => {
  const a = fingerprint(base);
  const b = fingerprint({
    ...base,
    user_message: "the checkout page is broken!!",
    context: {
      ...base.context,
      url: "https://app.acme.com/checkout?session=zzz999",
      console_errors: ["TypeError: Cannot read properties of undefined (reading 'total') at Cart.tsx:88:3"],
      failed_requests: [{ method: "POST", url: "https://app.acme.com/api/pay/1", status: 500 }],
    },
  });
  assert.equal(a, b);
});

test("a different page produces a different fingerprint", () => {
  const other = fingerprint({ ...base, context: { ...base.context, route: "/profile" } });
  assert.notEqual(fingerprint(base), other);
});

test("automatic reports dedupe on the failure that fired them, not on earlier noise", () => {
  const auto = (failed: { method: string; url: string; status: number }[], route: string) => ({
    ...base,
    user_message: "Automatic report: POST /api/orders/17 returned 400",
    source: "auto" as const,
    trigger: { kind: "request" as const, method: "POST", url: "https://app.acme.com/api/orders/17", status: 400 },
    context: { ...base.context, route, console_errors: [], failed_requests: failed },
  });
  const a = fingerprint(auto([], "/checkout"));
  const b = fingerprint(
    auto([{ method: "GET", url: "https://app.acme.com/api/me", status: 500 }], "/cart"),
  );
  assert.equal(a, b, "same endpoint + status = one issue, whatever page or earlier failures");
  const other = fingerprint({ ...auto([], "/checkout"), trigger: { kind: "request", method: "POST", url: "https://app.acme.com/api/orders/17", status: 422 } });
  assert.notEqual(a, other);
});
