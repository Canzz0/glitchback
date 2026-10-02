import { test } from "node:test";
import assert from "node:assert/strict";
import { fence } from "../src/fixer/format.ts";

test("the diff fence is longer than any backtick run in the patch", () => {
  assert.equal(fence("+const a = 1;"), "```");
  assert.equal(fence("+const s = `x`;\n+// ``` not a fence"), "````");
  assert.equal(fence("+/* ````` */"), "``````");
});
