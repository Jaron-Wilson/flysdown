import test from "node:test";
import assert from "node:assert/strict";
import { clampWidth, LIMITS } from "../public/js/resize.js";

test("a panel can widen, but never past its cap or into the map", () => {
  assert.equal(clampWidth(500, { viewport: 1600, other: 360 }), 500);
  assert.equal(clampWidth(100, { viewport: 1600, other: 360 }), LIMITS.min);
  assert.equal(clampWidth(2000, { viewport: 2400, other: 360 }), LIMITS.max);
  // 1280 wide with a 320 px right panel leaves 1280 - 320 - 360 = 600 for the left.
  assert.equal(clampWidth(700, { viewport: 1280, other: 320 }), 600);
});
