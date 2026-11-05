# AGENTS.md — sigrun-todo

Guidance for coding agents working in this repository.

## What this is

The todo extension for [sigrun](https://github.com/sigrun-ai/sigrun): an
agent-kept task list rendered in the conversation's right panel. The agent
owns the list through the `todo` tool; the panel is read-only.

A sigrun extension (pi-durable loader contract): a default-export factory
taking the `SigrunHost` and returning a `SigrunExtensionResult` (types from
`@sigrun/sigrun/extension`, a types-only subpath — never a runtime import).

## Layout

- `src/index.ts` — the default-export factory: ONE `TodoLog` shared by the
  tool, the hooks, and the panel, with one `onChanged` notifying the panel's
  canonical instance key, plus `runSettled` (the aborted-round-safe settle
  notification) and the per-use `reminderRounds` settings read.
- `src/types.ts` — `Task`, `TaskStatus`, `TodoState`, `TodoSnapshot`; the
  snapshot field names and order are a cross-version compatibility surface.
- `src/state.ts` — the pure reducer (`applyTodo`, `changesState`,
  `TodoParamsSchema`, `Op`).
- `src/log.ts` — `TodoLog`: transcript replay (`replay`, `hostEntryReader`)
  plus a per-conversation cache; `settle` drops a dirty entry so the next
  read sees the committed transcript (or the state without an aborted call).
- `src/tool.ts` — the `todo` tool: model-only, unsafe replay, state-changing
  results carry the full snapshot in `details`.
- `src/freshness.ts` / `src/hooks.ts` — the end-of-turn check and the
  mid-run reminder (`beforeRequest`/`onYield`/`afterTools`).
- `src/section.ts` — the static prompt section (the discipline, never the
  list — changing prompt bytes break the provider's caches).
- `src/panel.ts` — the `perConversation` Todos panel: `conversationIdOf`,
  `panelKey`, `createTodoPanel`.
- `test/fake-host.ts` — the in-memory `SigrunHost` (unit tests never boot
  core); `test/harness.ts` — a real pi-durable `Harness` helper.
- `dist/` — **committed build output** (git-source installs load
  `dist/index.js` with no build step). Rebuild with `npm run build` and
  commit whenever `src/` moves; a stale dist is ship-blocking.

## Run and test

```sh
npm install
npm test            # check-manifest + vitest
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/ (commit the result)
```

## Conventions

- **Commit dist**: tracked by design. If `git status` shows `dist/` changes
  after a build, those belong in the same commit as the source change.
- **Verification before completion**: `npm test` + `npm run typecheck` +
  `npm run build` with a clean `git status -- dist` before claiming done.
- The factory declares one `host` parameter (arity one) and no default: the
  loader passes the host only when `factory.length > 0`.
- One `TodoLog` per factory call. The tool, hooks, and panel must share it:
  the cache is what makes `settle` re-read the transcript exactly once.
- The tool is the only writer. `onChanged` fires once per call that changed
  the list — never for a read, a failure, or a no-effect update.
- State-changing results carry the FULL post-change snapshot in `details`;
  read-only results never do (replay treats any snapshot as the list).
- Deleted tasks are tombstones: kept in the snapshot so replay and ids stay
  stable, excluded from `list` output, panel items, and the panel's total.
- The panel declares NO `instanceKey`: `perConversation: true` panels are
  routed by the default canonical-JSON key (`panelKey` must equal it — the
  panel test pins it against `canonicalJson` from `@sigrun/shared/blocks`).
- Client-supplied `conversationId` params are checked: unknown conversation
  (a `meta` throw) or a `none` access verdict hides the panel (`none`).
- Never auto-close a task from a check. The end-of-turn check always offers
  three honest answers: completed, deleted with a note, or kept open with a
  note. The freshness unit is a ROUND (an assistant message with a tool
  call), not a message.
- Tests own their literals: synthetic ids, users, and subjects; no real
  hosts, tokens, or private URLs in fixtures.
- Host modules (`@earendil-works/*`) are peerDependencies; development pins
  exact devDependencies. The `dependencies` field stays empty.
- Local `@sigrun/*` development links are not committed.
