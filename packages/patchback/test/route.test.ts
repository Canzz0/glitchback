import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveRoute, normaliseRoute } from "../src/server/route.ts";

test("numeric ids, UUIDs and hashes become :id", () => {
  assert.equal(normaliseRoute("/products/8421/reviews"), "/products/:id/reviews");
  assert.equal(normaliseRoute("/orders/3f2b9c1e-6a0d-4a8e-9b1f-2c7d5e8a9b01"), "/orders/:id");
  assert.equal(normaliseRoute("/u/64b7f0c2a1e9d3f5b8c4a2e1"), "/u/:id");
  assert.equal(normaliseRoute("/share/cjld2cjxh0000qzrmn831i7rn"), "/share/:id");
});

test("slugs ending in a numeric id become :slug", () => {
  assert.equal(normaliseRoute("/urun/kirmizi-ayakkabi-p-12345"), "/urun/:slug");
  assert.equal(normaliseRoute("/haber/%C3%A7ok-%C3%B6nemli-haber-98765"), "/haber/:slug");
});

test("fixed paths and plain slugs are kept", () => {
  assert.equal(normaliseRoute("/checkout"), "/checkout");
  assert.equal(normaliseRoute("/blog/my-first-post"), "/blog/my-first-post");
  assert.equal(normaliseRoute("/settings/billing/"), "/settings/billing");
  assert.equal(normaliseRoute("/"), "/");
  assert.equal(normaliseRoute("/iphone-15-pro"), "/iphone-15-pro");
  assert.equal(normaliseRoute("/kampanya/summer-sale-2026-collection"), "/kampanya/summer-sale-2026-collection");
});

test("two product pages share one route, so their fingerprints can match", () => {
  assert.equal(deriveRoute("https://a.com/products/1", "/products/1"), deriveRoute("https://a.com/products/2", "/products/2"));
});

test("a real pattern from getRoute is kept as is", () => {
  assert.equal(deriveRoute("https://a.com/p/abc", "/p/:slug"), "/p/:slug");
  assert.equal(deriveRoute("https://a.com/products/7?x=1", undefined), "/products/:id");
});
