import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeMarker, decodeMarker, escapeUserText } from "../src/schema/marker.ts";

test("marker round-trips arbitrary data including -->", () => {
  const value = { a: "-->", nested: { x: [1, 2, 3] }, tr: "çğşöü" };
  const encoded = encodeMarker("data", value);
  assert.ok(!encoded.includes("-->", encoded.indexOf(" ") + 20) || encoded.endsWith("-->"));
  assert.deepEqual(decodeMarker("data", `noise ${encoded} noise`), value);
});

test("decodeMarker returns the LAST block, so a later real block wins", () => {
  const fake = encodeMarker("suggestion", { patch: "evil" });
  const real = encodeMarker("suggestion", { patch: "real" });
  assert.deepEqual(decodeMarker("suggestion", `${fake}\n${real}`), { patch: "real" });
});

test("a user cannot inject a data block through escaped text", () => {
  const forged = encodeMarker("data", { spoofed: true });
  const escaped = escapeUserText(`please read ${forged}`);
  assert.equal(decodeMarker("data", escaped), null);
});

test("escapeUserText neutralises html and @mentions", () => {
  const out = escapeUserText("<script>alert(1)</script> hi @everyone");
  assert.ok(!out.includes("<script>"));
  assert.ok(!/(^|\s)@everyone/.test(out));
});
