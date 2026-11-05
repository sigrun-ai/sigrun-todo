# @sigrun/todo

An agent-kept task list for [sigrun](https://github.com/sigrun-ai/sigrun).
The agent owns the list through its `todo` tool; the webui shows it read-only
in the conversation's right panel, updated live as the agent works.

## Install

Add the extension to `extensions[]` in the sigrun settings file and restart:

```json
{
  "extensions": ["@sigrun/todo"]
}
```

(a git source — `git:host/path[@ref]` — works too; the repo's committed
`dist/` is what git-source installs load.)

Until `@sigrun/todo` is published, install from a local path pointing at the
BUILT entry — `"/path/to/sigrun-todo/dist/index.js"` in `extensions[]` —
because the loader rejects a bare directory path (`Directory import … is not
supported`).

## What you get

- **The `todo` tool** (model-only): one call per unit of work —
  `create`/`update`/`delete`, `in_progress` when the agent starts an item,
  `completed` when it is done.
- **The Todos panel** in the conversation's right panel: the open items,
  with a spinner and the agent's `activeForm` label on the item in flight,
  completed items greyed (`neutral`) but visible, and a `done/total` line.
  Deleted items are tombstones — they never appear and do not count.
- **The freshness checks.** The list belongs to the work, and the extension
  nudges the agent to keep it current:
  - *End-of-turn check*: when a run ends after tool rounds have passed since
    the last `todo` call while items are still open, the run continues once
    with a check message.
  - *Mid-run reminder*: every `reminderRounds` work rounds without a `todo`
    call, a one-request reminder lists the open items.
  - The check always offers three honest answers — mark it completed, delete
    it as obsolete, or keep it open with a note saying why; the checks never
    push a model to fabricate progress.

## Settings

`reminderRounds` — rounds between mid-run reminders (default `6`). There is
no settings section in v1: edit the extension's settings object through the
**Extensions** settings raw-JSON editor, e.g. `{ "reminderRounds": 3 }`.

## Known limits

- The TUI does not show extension panels yet — the list is webui-only there;
  the tool, section, and freshness checks work in every channel.
- The panel is read-only by design: the agent owns the list.
