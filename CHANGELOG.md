# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
