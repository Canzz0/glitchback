import { test } from "node:test";
import assert from "node:assert/strict";
import { clientIp } from "../src/server/clientip.ts";

test("behind one proxy, the proxy-appended entry is used, not the forged left side", () => {
  assert.equal(clientIp("6.6.6.6, 203.0.113.9", "10.0.0.2", 1), "203.0.113.9");
});

test("two trusted hops skip the last proxy", () => {
  assert.equal(clientIp("6.6.6.6, 203.0.113.9, 10.0.0.5", "10.0.0.2", 2), "203.0.113.9");
});

test("with no trusted proxy the header is ignored", () => {
  assert.equal(clientIp("1.2.3.4", "198.51.100.7", 0), "198.51.100.7");
});

test("missing header falls back to the socket address", () => {
  assert.equal(clientIp(undefined, "198.51.100.7", 1), "198.51.100.7");
  assert.equal(clientIp(undefined, undefined, 1), "unknown");
});
