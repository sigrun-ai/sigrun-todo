# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-11-07

## [Unreleased]

### Changed

- peer pi-durable/pi-ai/chord ~1.5.0 (requires sigrun 0.11.0).

## [0.1.2] - 2026-11-05
### Fixed
- The published 0.1.1 could not load: `src/panel.ts` imported the host's
  block builders (`@sigrun/sigrun/blocks`) at RUNTIME, and an extension
  installed from the registry cannot resolve the host package — it is the
  host, not a dependency. The panel tree is now built as a plain object
  (`{ v: 1, root: … }`) with type-only imports from `@sigrun/shared/blocks`,
  matching `sigrun-escalations`. The tree is unchanged in content and
  still validates against the host's `validateTree`.

## [0.1.1] - 2026-11-04
### Added
- The todo extension: an agent-kept task list with a read-only
  per-conversation Todos panel in the webui.
- The `todo` tool (model-only): create, update, delete, clear, list, and get,
  with the full post-change snapshot carried on every state-changing result
  for transcript replay.
- The freshness checks: an end-of-turn check that asks the agent to account
  for open items (completed, deleted with a note, or kept open with a note),
  and a mid-run reminder every `reminderRounds` work rounds (default 6).
- The Todos panel: open items with an in-flight spinner and `activeForm`
  label, completed items visible and greyed, and a `done/total` line.
  Deleted items are tombstones — never shown, never counted.
