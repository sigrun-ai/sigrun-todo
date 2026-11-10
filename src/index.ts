/**
 * The todo extension factory (Task 9): one {@link TodoLog} in front of the
 * transcript, shared by the tool, the hooks, and the panel, with one
 * `onChanged` notifying the panel's canonical instance key.
 *
 * The factory declares ONE parameter so the loader passes the host in
 * (`factory.length > 0` gates the host argument); a defaulted first
 * parameter would swallow it instead.
 */

import { defineExtension } from "@earendil-works/pi-durable";
import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";
import { createTodoHooks } from "./hooks.js";
import { TodoLog, hostEntryReader } from "./log.js";
import { createTodoPanel, panelKey } from "./panel.js";
import { todoSection } from "./section.js";
import { TODO_SETTINGS_SCHEMA, type TodoSettings } from "./settings-schema.js";
import { createTodoTool } from "./tool.js";

/**
 * The todo extension: an agent-kept task list with a per-conversation panel.
 * The required host parameter keeps the factory at arity one for the loader.
 */
export default function createTodo(host: SigrunHost): SigrunExtensionResult {
	const settings = host.settings.declare<TodoSettings>({ schema: TODO_SETTINGS_SCHEMA });
	// ONE log: the tool's mutations, the hooks' freshness reads, and the
	// panel's renders must see the same cache so `settle` re-reads the
	// transcript exactly once per round.
	const log = new TodoLog(hostEntryReader(host));

	const onChanged = (id: Parameters<typeof panelKey>[0]): void => {
		host.surfaces.changed("todos", panelKey(id));
	};

	const deps = { log, onChanged };

	return {
		extension: defineExtension({
			name: "todo",
			tools: [createTodoTool(deps)],
			sections: [todoSection],
			hooks: [
				createTodoHooks({
					...deps,
					// Read PER USE so an edit to the extension's settings applies
					// on the next request, without a reload. The declared checked
					// read applies the default and repairs malformed values to it.
					reminderRounds: async () => (await settings.get()).reminderRounds,
				}),
			],
		}),
		surfaces: { panels: [createTodoPanel({ host, log })] },
		runSettled: (event) => {
			// Settle at RUN end, not round end: `afterTools` never runs on an
			// aborted round, so this is the only notification path that always
			// fires. A dirty entry means the round's change is in the
			// transcript; a clean one means nothing changed.
			if (log.settle(event.conversationId)) onChanged(event.conversationId);
		},
	};
}
