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
import { type ConversationId, type ToolRegistration } from "@earendil-works/pi-durable";
import type { TodoLog } from "./log.js";
import { TodoParamsSchema } from "./state.js";
export interface TodoToolDeps {
    /** The conversation's cache in front of the transcript. */
    log: TodoLog;
    /** Called once per call whose result changed the list. */
    onChanged: (conversationId: ConversationId) => void;
}
/** The `todo` tool over one conversation-scoped {@link TodoLog}. */
export declare function createTodoTool(deps: TodoToolDeps): ToolRegistration<typeof TodoParamsSchema>;
