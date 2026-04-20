// Unit tests for the snapshot-stack history used by Stage E undo/redo.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { History } from '../../web/history.js';

test('init establishes baseline; past and future start empty', () => {
  const h = new History();
  h.init({ v: 0 });
  assert.deepEqual(h.current, { v: 0 });
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), false);
});

test('record pushes current onto past and clears future', () => {
  const h = new History();
  h.init({ v: 0 });
  h.record({ v: 1 });
  assert.deepEqual(h.current, { v: 1 });
  assert.equal(h.canUndo(), true);
  h.record({ v: 2 });
  assert.equal(h.past.length, 2);
  assert.equal(h.future.length, 0);
});

test('undo/redo roundtrip', () => {
  const h = new History();
  h.init({ v: 0 });
  h.record({ v: 1 });
  h.record({ v: 2 });
  assert.deepEqual(h.undo(), { v: 1 });
  assert.deepEqual(h.undo(), { v: 0 });
  assert.equal(h.canUndo(), false);
  assert.deepEqual(h.redo(), { v: 1 });
  assert.deepEqual(h.redo(), { v: 2 });
  assert.equal(h.canRedo(), false);
});

test('record after undo clears redo branch', () => {
  const h = new History();
  h.init({ v: 0 });
  h.record({ v: 1 });
  h.record({ v: 2 });
  h.undo();           // current = {v:1}, future = [{v:2}]
  h.record({ v: 3 }); // diverges: future should be dropped
  assert.equal(h.canRedo(), false);
  assert.deepEqual(h.current, { v: 3 });
});

test('duplicate snapshots are not recorded', () => {
  const h = new History();
  h.init({ v: 0 });
  h.record({ v: 1 });
  h.record({ v: 1 });  // same - skipped
  h.record({ v: 1 });  // same - skipped
  assert.equal(h.past.length, 1);
  assert.deepEqual(h.current, { v: 1 });
});

test('equality is insensitive to property insertion order', () => {
  const h = new History();
  h.init({ a: 1, b: 2, c: 3 });
  // Semantically identical snapshot with keys constructed in a
  // different order. Naive JSON.stringify would stringify these
  // distinctly and record a spurious history entry; the canonical
  // key-sorted stringifier collapses them to equal.
  h.record({ c: 3, b: 2, a: 1 });
  assert.equal(h.past.length, 0);
  h.record({ b: 2, a: 1, c: 3 });
  assert.equal(h.past.length, 0);
});

test('equality survives nested object key reordering', () => {
  const h = new History();
  h.init({ meta: { name: 'n', domain: 'd' }, nodes: [{ id: 'n1', label: 'L' }] });
  h.record({ nodes: [{ label: 'L', id: 'n1' }], meta: { domain: 'd', name: 'n' } });
  assert.equal(h.past.length, 0);
});

test('equality still distinguishes genuinely different content', () => {
  const h = new History();
  h.init({ a: 1, b: 2 });
  h.record({ a: 1, b: 3 });       // different
  h.record({ a: 2, b: 3 });       // different
  assert.equal(h.past.length, 2);
  assert.deepEqual(h.current, { a: 2, b: 3 });
});

test('cap enforces bounded past length (drops oldest)', () => {
  const h = new History({ cap: 3 });
  h.init({ v: 0 });
  for (let i = 1; i <= 10; i += 1) h.record({ v: i });
  assert.equal(h.past.length, 3);
  // Oldest retained should be snapshots {v:7},{v:8},{v:9}; current is {v:10}.
  assert.deepEqual(h.past[0], { v: 7 });
  assert.deepEqual(h.past[1], { v: 8 });
  assert.deepEqual(h.past[2], { v: 9 });
  assert.deepEqual(h.current, { v: 10 });
});

test('undo on empty past is a no-op returning null', () => {
  const h = new History();
  h.init({ v: 0 });
  assert.equal(h.undo(), null);
  assert.deepEqual(h.current, { v: 0 });
});

test('redo on empty future is a no-op returning null', () => {
  const h = new History();
  h.init({ v: 0 });
  h.record({ v: 1 });
  assert.equal(h.redo(), null);
  assert.deepEqual(h.current, { v: 1 });
});

test('withSuspended prevents record during callback', () => {
  const h = new History();
  h.init({ v: 0 });
  h.withSuspended(() => {
    h.record({ v: 'should not land' });
    h.record({ v: 'also not' });
  });
  assert.equal(h.past.length, 0);
  assert.deepEqual(h.current, { v: 0 });
  // After suspension lifts, recording resumes normally.
  h.record({ v: 1 });
  assert.equal(h.past.length, 1);
  assert.deepEqual(h.current, { v: 1 });
});

test('suspended state is restored after exception inside withSuspended', () => {
  const h = new History();
  h.init({ v: 0 });
  assert.throws(() => {
    h.withSuspended(() => {
      throw new Error('boom');
    });
  }, /boom/);
  assert.equal(h.suspended, false);
  h.record({ v: 1 });
  assert.equal(h.past.length, 1);
});

test('stats reflects stack sizes', () => {
  const h = new History({ cap: 5 });
  h.init({ v: 0 });
  h.record({ v: 1 });
  h.record({ v: 2 });
  h.undo();
  const s = h.stats();
  assert.equal(s.past, 1);
  assert.equal(s.future, 1);
  assert.equal(s.cap, 5);
});
