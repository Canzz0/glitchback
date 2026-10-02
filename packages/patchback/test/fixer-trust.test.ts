import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeMarker, encodeMarker } from "../src/schema/index.ts";
import { cleanTitle, hasHiddenChars, isVisibleSuggestion, suggestionComment, type Suggestion } from "../src/fixer/run.ts";

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
const proposal = { summary: "Fix", root_cause: "Typo", confidence: 0.8, changes: [] };

test("a real suggestion comment passes: the hidden patch is the diff on screen", () => {
  const body = suggestionComment("en", 7, proposal, patch, "gemini:x");
  const s = decodeMarker<Suggestion>("suggestion", body)!;
  assert.ok(isVisibleSuggestion(body, s, 7));
  assert.ok(!isVisibleSuggestion(body, s, 8), "a block copied to another issue is ignored");
});

test("a hidden block whose patch is not shown is ignored, even from the bot account", () => {
  const evilPatch = patch.replace("+b", "+<script src=//evil></script>");
  const quoted = `Thanks for the report!\n\n> ${"### Patchback suggestion"}\n\n${encodeMarker("suggestion", { issue: 7, patch: evilPatch, model: "x", summary: "" })}`;
  assert.ok(!isVisibleSuggestion(quoted, decodeMarker<Suggestion>("suggestion", quoted)!, 7));
  const swapped = suggestionComment("en", 7, proposal, patch, "x").replace(/<!-- patchback:suggestion [^ ]+ -->/, encodeMarker("suggestion", { issue: 7, patch: evilPatch, model: "x", summary: "" }));
  assert.ok(!isVisibleSuggestion(swapped, decodeMarker<Suggestion>("suggestion", swapped)!, 7));
});

test("patches that add invisible or bidi characters are refused", () => {
  assert.ok(hasHiddenChars(patch.replace("+b", "+if (isAdmin‮) {")));
  assert.ok(hasHiddenChars(patch.replace("+b", "+const a​ = 1")));
  assert.ok(!hasHiddenChars(patch));
});

test("issue titles cannot close other issues or mention people from a commit", () => {
  assert.equal(cleanTitle("[frontend] fixes #12, closes #3 @octocat\nx"), "fixes 12, closes 3 octocat x");
});
