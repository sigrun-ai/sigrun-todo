/**
 * Generation hooks: the freshness policy (Task 7) wired into a run.
 *
 * Three handlers, three jobs:
 *
 * - `afterTools` ends each round: a round that changed the list makes the
 *   log's cache entry dirty, and `settle` dropping it reports `true` — the
 *   signal to refresh whatever panel is open (`onChanged`).
 * - `beforeRequest` runs before every request attempt. It analyzes the
 *   request's messages (the only place the current tool list exists) and
 *   stashes the {@link RunView} for `onYield`, and appends the mid-run
 *   reminder to the messages it returns — that request only, never a
 *   transcript entry.
 * - `onYield` fires the end-of-turn check: read AND DELETE the stashed view
 *   (the next request's `beforeRequest` overwrites it anyway), and when
 *   {@link shouldCheck} holds, continue the run with the check message.
 *
 * Once-per-run needs no state of its own: after the check's continuation,
 * the check message is the run's last user message, so `lastUserIsCheck`
 * holds for the rest of the run — even after more work rounds. `api.memo`
 * must not be used instead: it is per generation task and does not survive
 * the handover to the successor generation.
 *
 * Error isolation is pi-durable's job (a throwing hook is reported as
 * `extension_error`), so these handlers carry no try/catch of their own.
 */

import type { Message } from "@earendil-works/pi-ai";
import {
	GenerationTask,
	hook,
	type ConversationId,
	type HookRegistration,
} from "@earendil-works/pi-durable";
import {
	analyze,
	checkText,
	openItems,
	reminderText,
	shouldCheck,
	shouldRemind,
	type RunView,
} from "./freshness.js";
import type { TodoLog } from "./log.js";

export interface TodoHooksDeps {
	readonly log: TodoLog;
	/** The reminder cadence `k` (rounds), read per request so settings changes apply. */
	readonly reminderRounds: () => Promise<number>;
	/** The panel's cue that the committed list changed (after a `todo` round). */
	readonly onChanged: (conversationId: ConversationId) => void;
}

export function createTodoHooks(deps: TodoHooksDeps): HookRegistration {
	const { log, reminderRounds, onChanged } = deps;
	// `beforeRequest` → `onYield` handoff: `onYield` has no tool list, so the
	// view computed where one exists is stashed per conversation.
	const views = new Map<ConversationId, RunView>();

	return hook(GenerationTask, {
		afterTools(_assistant, _results, api) {
			if (log.settle(api.conversationId)) onChanged(api.conversationId);
		},

		async beforeRequest(request, api) {
			const view = analyze(request.messages);
			views.set(api.conversationId, view);
			const state = await log.get(api.conversationId);
			if (!shouldRemind(view, state, await reminderRounds())) return undefined;
			const reminder: Message = {
				role: "user",
				content: [{ type: "text", text: reminderText(state) }],
				timestamp: Date.now(),
			};
			return { messages: [...request.messages, reminder] };
		},

		async onYield(_answer, api) {
			const view = views.get(api.conversationId);
			views.delete(api.conversationId);
			if (view === undefined) return undefined;
			const state = await log.get(api.conversationId);
			if (!shouldCheck(view, state)) return undefined;
			return { continue: [{ type: "text", text: checkText(openItems(state)) }] };
		},
	});
}
