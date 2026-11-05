/**
 * The `todo` tool: the only writer of a conversation's task list, and the
 * source of the snapshots `replay` reads.
 *
 * One call applies one reducer step ({@link applyTodo}) to the conversation's
 * {@link TodoLog}, and the reducer's op decides what the result carries:
 *
 * - `output` — the model's terse status line, always ending with the open-item
 *   count (open = `pending` + `in_progress`);
 * - `details` — the full post-change snapshot, so the transcript can be
 *   replayed. STATE-CHANGING calls only: `replay` ignores a snapshot's
 *   `action`, so a read-only result carrying `{tasks, nextId}` (a filtered
 *   `list`, say) would silently become the conversation's list;
 * - `onChanged` — the panel's cue, fired once per call that changed the list,
 *   and never for a read, a failure or a no-effect update.
 *
 * An error op carries `isError` and the reducer's message, with no details.
 *
 * `callers: ["model"]` keeps the tool out of code mode: a nested call's result
 * is not recorded in the transcript, so a script-made change could never be
 * replayed. `replay` stays at its `"unsafe"` default — an interrupted call is
 * abandoned and the model re-issues it, where `"safe"` could apply a
 * non-idempotent create twice.
 */
import { defineTool } from "@earendil-works/pi-durable";
import { applyTodo, changesState, TodoParamsSchema } from "./state.js";
/** Statuses as they read inside a sentence: `in_progress` is two words. */
const STATUS_TEXT = {
    pending: "pending",
    in_progress: "in progress",
    completed: "completed",
    deleted: "deleted",
};
/** `1 task` / `2 tasks`, with an optional filter name: `1 pending task`. */
function countOf(count, noun, scope) {
    const text = scope === undefined ? noun : `${STATUS_TEXT[scope]} ${noun}`;
    return `${count} ${text}${count === 1 ? "" : "s"}`;
}
/**
 * The count sentence that ends every successful result — the model's answer to
 * "how much is left". A read's filter never narrows it: it always counts the
 * whole list.
 */
function openSummary(state) {
    const open = state.tasks.filter((task) => task.status === "pending" || task.status === "in_progress");
    const inProgress = open.filter((task) => task.status === "in_progress").length;
    const suffix = inProgress === 0 ? "" : ` (${inProgress} in progress)`;
    return `${open.length} open${suffix}`;
}
/** `#3 Wire the panel` — a task named by id and subject. */
function labelOf(id, subject) {
    return `#${id} ${subject}`;
}
/** The subject of the task an `update` or `delete` addressed. */
function subjectOf(state, id) {
    return state.tasks.find((task) => task.id === id)?.subject ?? "";
}
/**
 * `#3 [in_progress] Wire the panel` — one entry of a list. The bracket repeats
 * the parameter's own spelling, so the model reads back the token it passes.
 */
function listEntry(task) {
    return `#${task.id} [${task.status}] ${task.subject}`;
}
/**
 * The `list` view: the matching tasks and the whole-list count. Deleted tasks
 * are tombstones — kept in the snapshot so replay and ids stay stable, but left
 * out of an unfiltered list.
 */
function listText(state, statusFilter, summary) {
    const shown = statusFilter === undefined
        ? state.tasks.filter((task) => task.status !== "deleted")
        : state.tasks.filter((task) => task.status === statusFilter);
    if (shown.length === 0) {
        const scope = statusFilter === undefined ? "" : ` ${STATUS_TEXT[statusFilter]}`;
        return `No${scope} tasks. ${summary}.`;
    }
    const header = countOf(shown.length, "task", statusFilter);
    return `${header}: ${shown.map(listEntry).join("; ")}. ${summary}.`;
}
/**
 * The `get` view: the task with the fields the list view omits — the
 * description, what it waits on, and its note.
 */
function getText(task, summary) {
    const extras = [];
    if (task.blockedBy?.length) {
        extras.push(`blocked by ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
    }
    if (task.note !== undefined)
        extras.push(`note: ${task.note}`);
    const description = task.description === undefined ? "" : ` — ${task.description}`;
    const suffix = extras.length === 0 ? "" : ` (${extras.join("; ")})`;
    return `${listEntry(task)}${description}${suffix}. ${summary}.`;
}
/**
 * The model's view of one round — the text {@link createTodoTool} returns as
 * `output`. A mutation is one sentence; a read is a list; an error is its own
 * message with no count, because nothing changed and a count would only pad the
 * reason it failed.
 */
function formatOutput(state, op) {
    const summary = openSummary(state);
    switch (op.kind) {
        case "create": {
            const created = op.taskIds.map((id) => labelOf(id, subjectOf(state, id))).join(", ");
            return `Created ${created}. ${summary}.`;
        }
        case "update": {
            const label = labelOf(op.id, subjectOf(state, op.id));
            // A no-effect update says so: a bare "updated" drives a model to
            // re-issue the same call in a loop.
            if (!op.changed)
                return `No change to ${label}. ${summary}.`;
            if (op.fromStatus === op.toStatus)
                return `Updated ${label}. ${summary}.`;
            const to = STATUS_TEXT[op.toStatus];
            return `Updated ${label}: ${STATUS_TEXT[op.fromStatus]} → ${to}. ${summary}.`;
        }
        case "delete":
            return `Deleted ${labelOf(op.id, op.subject)}. ${summary}.`;
        case "clear":
            return `Cleared ${countOf(op.count, "task")}. ${summary}.`;
        case "get":
            return getText(op.task, summary);
        case "list":
            return listText(state, op.statusFilter, summary);
        case "error":
            return op.message;
    }
}
/**
 * The `details` of a state-changing result: the whole post-change list,
 * deleted tasks included. `TodoSnapshot` is an interface without an index
 * signature, so it is not structurally a `JsonValue`; `satisfies` checks the
 * fields and the cast only satisfies the tool-result typing.
 */
function snapshotOf(action, state) {
    const snapshot = {
        action,
        tasks: state.tasks,
        nextId: state.nextId,
    };
    return snapshot;
}
/** The `todo` tool over one conversation-scoped {@link TodoLog}. */
export function createTodoTool(deps) {
    const { log, onChanged } = deps;
    return defineTool({
        name: "todo",
        description: "Maintain this conversation's task list. Use it to plan multi-step work and to keep the user's panel current: one entry per unit of work, `in_progress` when you start it, `completed` when it is done.",
        callers: ["model"],
        parameters: TodoParamsSchema,
        execute: async (args, api) => {
            const { state, op } = await log.mutate(api.conversationId, (current) => applyTodo(current, args));
            const output = [{ type: "text", text: formatOutput(state, op) }];
            if (op.kind === "error")
                return { output, isError: true };
            // Reads, and an update that re-sent the values already stored: nothing
            // changed, so there is nothing to persist and nothing to refresh. A
            // snapshot here would re-stamp the transcript with the state it holds.
            if (!changesState(op))
                return { output };
            onChanged(api.conversationId);
            return { output, details: snapshotOf(args.action, state) };
        },
    });
}
