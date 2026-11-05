/**
 * Canonical todo state for `@sigrun/todo`. The shape is pinned: every
 * state-changing `todo` result carries it as `details`, and replay reads the
 * latest snapshot off the transcript, so field names and field order are a
 * cross-version compatibility surface.
 */
export const EMPTY_STATE = { tasks: [], nextId: 1 };
