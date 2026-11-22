import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampWidth, MIN_DETAIL_WIDTH, MIN_LIST_WIDTH } from '../src/ui/splitter.ts';

test('detail panel width stays within the window (UI-6)', () => {
  assert.equal(clampWidth(500, 1400), 500);
  assert.equal(clampWidth(100, 1400), MIN_DETAIL_WIDTH);
  assert.equal(clampWidth(5000, 1400), 1400 - MIN_LIST_WIDTH);
  assert.equal(clampWidth(Infinity, 1400), 1400 - MIN_LIST_WIDTH);
  // narrow window: the panel keeps its minimum
  assert.equal(clampWidth(500, 400), MIN_DETAIL_WIDTH);
  assert.equal(clampWidth(433.6, 1400), 434);
});
