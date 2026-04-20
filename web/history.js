// Undo / redo history based on full-canvas snapshots.
//
// We use a snapshot stack rather than a command stack because the canvas
// state is small (a few KB for 500 nodes) and snapshot-diff is
// conceptually simpler - every mutation in canvas.js already fires a
// single `graph-change` event, so we just capture a snapshot there.
//
// The stack has three regions at any moment:
//   past    -> older states (oldest ... newest before current)
//   current -> the state currently visible on the canvas
//   future  -> states that were popped by undo and can be redone
//
// Recording a new state (after a user action) pushes current onto past
// and drops future. Undo/redo shuttle one state at a time.
//
// `suspended` guards against the re-entrant graph-change events that fire
// while we're applying a restored snapshot - those should NOT be recorded.

export class History {
  constructor({ cap = 50 } = {}) {
    this.cap = cap;
    this.past = [];
    this.current = null;
    this.future = [];
    this.suspended = false;
  }

  /** Reset history with a fresh baseline snapshot. Future/past are wiped. */
  init(snapshot) {
    this.past = [];
    this.future = [];
    this.current = snapshot ?? null;
  }

  /**
   * Record a new snapshot as the current state. The previous current goes
   * on `past`. Future is cleared. No-ops when the new snapshot equals the
   * current one (back-to-back duplicate events).
   */
  record(snapshot) {
    if (this.suspended) return;
    if (this.current !== null && snapshotsEqual(this.current, snapshot)) return;
    if (this.current !== null) {
      this.past.push(this.current);
      if (this.past.length > this.cap) this.past.shift();
    }
    this.current = snapshot;
    this.future = [];
  }

  canUndo() {
    return this.past.length > 0;
  }

  canRedo() {
    return this.future.length > 0;
  }

  /** Step back; returns the snapshot to apply, or null if nothing to undo. */
  undo() {
    if (this.past.length === 0) return null;
    this.future.push(this.current);
    if (this.future.length > this.cap) this.future.shift();
    this.current = this.past.pop();
    return this.current;
  }

  /** Step forward; returns the snapshot to apply, or null if nothing to redo. */
  redo() {
    if (this.future.length === 0) return null;
    this.past.push(this.current);
    if (this.past.length > this.cap) this.past.shift();
    this.current = this.future.pop();
    return this.current;
  }

  /**
   * Run `fn` with recording suspended - used by the restore path so
   * graph-change events emitted by the restore don't pollute history.
   */
  withSuspended(fn) {
    const prev = this.suspended;
    this.suspended = true;
    try {
      return fn();
    } finally {
      this.suspended = prev;
    }
  }

  stats() {
    return { past: this.past.length, future: this.future.length, cap: this.cap };
  }
}

function snapshotsEqual(a, b) {
  // Snapshots are plain serialisable objects. We use a key-sorted
  // canonical stringify so two snapshots that differ only in property
  // insertion order (a likely outcome once Cytoscape internals, evaluator
  // post-writes like sc1/nc1/nc2, or lazily-set data fields touch the
  // underlying objects in different orders) compare equal and do not
  // pollute the 50-slot history ring.
  try {
    return canonicalStringify(a) === canonicalStringify(b);
  } catch {
    return false;
  }
}

/**
 * Key-sorted JSON stringify. Exported so the audit-trail SHA-256 hash
 * (app.js::computeArtefactHash) uses the same canonical representation
 * as history equality - two architectures with identical semantics
 * produce the same hash regardless of property insertion order.
 */
export function canonicalStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(v[k])).join(',') + '}';
}
