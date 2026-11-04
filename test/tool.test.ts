/**
 * The `todo` tool (Task 6). The result envelope is the contract the rest of
 * the extension is built on, and three parts of it are load-bearing:
 *
 * - `details` is the FULL post-change snapshot, and it is on STATE-CHANGING
 *   results only. `replay` ignores a snapshot's `action`, so a read-only
 *   result whose `details` looked like `{tasks, nextId}` (a filtered `list`,
 *   say) would silently become the conversation's list.
 * - `onChanged` fires once per call that changed the list, and never
 *   otherwise, so the panel is not refreshed for reads or failures.
 * - `callers` is model-only and `replay` is left at its `"unsafe"` default:
 *   a nested call's result is not recorded in the transcript (unreplayable),
 *   and a rerun of a `"safe"` non-idempotent call would apply it twice.
 *
 * The harness test at the bottom proves the envelope survives a real run: a
 * FRESH `TodoLog` over the transcript — not the cache the round populated —
 * sees the changes.
 */

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type {
	ConversationId,
	ToolExecutionApi,
	ToolExecutionResult,
	ToolRegistration,
} from "@earendil-works/pi-durable";
import { TodoLog, type EntryReader } from "../src/log.js";
import type { TodoParams } from "../src/state.js";
import { createTodoTool } from "../src/tool.js";
import { cleanupDir, closeOpened, openTodoHarness, tempDir } from "./harness.js";

const CID = 1 as ConversationId;
const OTHER = 2 as ConversationId;

/** An empty transcript: these tests start from an empty list. */
const emptyRead: EntryReader = async function* () {};

/** A tool over an empty list, plus the conversations its `onChanged` recorded. */
function setup(): { tool: ToolRegistration; changed: ConversationId[] } {
	const changed: ConversationId[] = [];
	const tool = createTodoTool({
		log: new TodoLog(emptyRead),
		onChanged: (id) => changed.push(id),
	});
	return { tool, changed };
}

/** The tool reads only `api.conversationId`; the rest of the API is unused. */
function apiFor(conversationId: ConversationId): ToolExecutionApi {
	return { conversationId } as unknown as ToolExecutionApi;
}

async function call(
	tool: ToolRegistration,
	params: TodoParams,
	conversationId: ConversationId = CID,
): Promise<ToolExecutionResult> {
	return await tool.execute(params, apiFor(conversationId), BACKGROUND_CONTEXT);
}

/** The text the model sees; a result that omits `output` is a defect. */
function textOf(result: ToolExecutionResult): string {
	if (result.output === undefined) throw new Error("the tool returned no output text");
	return result.output.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("create", () => {
	it("create returns details with the new task and calls onChanged once", async () => {
		const { tool, changed } = setup();

		const result = await call(tool, { action: "create", subject: "Wire the panel" });

		expect(result.isError).toBeUndefined();
		expect(result.details).toEqual({
			action: "create",
			tasks: [{ id: 1, subject: "Wire the panel", status: "pending" }],
			nextId: 2,
		});
		expect(changed).toEqual([CID]);
		expect(textOf(result)).toBe("Created #1 Wire the panel. 1 open.");
	});

	it("a batch create reports every new id", async () => {
		const { tool, changed } = setup();

		const result = await call(tool, {
			action: "create",
			tasks: [{ subject: "Design" }, { subject: "Implement" }],
		});

		// One call, one notification: the batch is a single round change.
		expect(changed).toEqual([CID]);
		expect(result.details).toEqual({
			action: "create",
			tasks: [
				{ id: 1, subject: "Design", status: "pending" },
				{ id: 2, subject: "Implement", status: "pending" },
			],
			nextId: 3,
		});
		expect(textOf(result)).toBe("Created #1 Design, #2 Implement. 2 open.");
	});
});

describe("update", () => {
	it("an invalid transition returns isError and does not call onChanged", async () => {
		const { tool, changed } = setup();
		await call(tool, { action: "create", subject: "Wire the panel" });
		await call(tool, { action: "update", id: 1, status: "completed" });
		changed.length = 0;

		const result = await call(tool, { action: "update", id: 1, status: "in_progress" });

		expect(result.isError).toBe(true);
		expect(result.details).toBeUndefined();
		expect(changed).toEqual([]);
		expect(textOf(result)).toBe("illegal transition completed → in_progress");
	});

	it("a no-effect update returns no details and does not call onChanged", async () => {
		const { tool, changed } = setup();
		await call(tool, { action: "create", subject: "Wire the panel" });
		changed.length = 0;

		const result = await call(tool, { action: "update", id: 1, status: "pending" });

		// Nothing changed, so there is nothing to persist: a snapshot here would
		// only re-stamp the transcript with the state it already holds.
		expect(result.isError).toBeUndefined();
		expect(result.details).toBeUndefined();
		expect(changed).toEqual([]);
		expect(textOf(result)).toBe("No change to #1 Wire the panel. 1 open.");
	});

	it("an update that changes only a field reports the change without a transition", async () => {
		const { tool, changed } = setup();
		await call(tool, { action: "create", subject: "Design" });
		changed.length = 0;

		const result = await call(tool, { action: "update", id: 1, activeForm: "designing" });

		expect(changed).toEqual([CID]);
		expect(textOf(result)).toBe("Updated #1 Design. 1 open.");
	});

	it("a status change reports the transition and the open count", async () => {
		const { tool, changed } = setup();
		await call(tool, { action: "create", tasks: [{ subject: "Design" }, { subject: "Implement" }] });
		changed.length = 0;

		const result = await call(tool, { action: "update", id: 1, status: "in_progress" });

		expect(changed).toEqual([CID]);
		expect(result.details).toEqual({
			action: "update",
			tasks: [
				{ id: 1, subject: "Design", status: "in_progress" },
				{ id: 2, subject: "Implement", status: "pending" },
			],
			nextId: 3,
		});
		expect(textOf(result)).toBe(
			"Updated #1 Design: pending → in progress. 2 open (1 in progress).",
		);
	});
});

describe("list", () => {
	it("list returns no details", async () => {
		const { tool, changed } = setup();
		await call(tool, { action: "create", tasks: [{ subject: "Design" }, { subject: "Implement" }] });
		await call(tool, { action: "update", id: 1, status: "in_progress" });
		changed.length = 0;

		const result = await call(tool, { action: "list" });

		// No details: a snapshot-shaped result would become the list on replay.
		expect(result.isError).toBeUndefined();
		expect(result.details).toBeUndefined();
		expect(changed).toEqual([]);
		expect(textOf(result)).toBe(
			"2 tasks: #1 [in_progress] Design; #2 [pending] Implement. 2 open (1 in progress).",
		);
	});

	it("a filtered list returns no details", async () => {
		const { tool } = setup();
		await call(tool, { action: "create", tasks: [{ subject: "Design" }, { subject: "Implement" }] });
		await call(tool, { action: "update", id: 1, status: "in_progress" });

		const result = await call(tool, { action: "list", status: "pending" });

		// A filter must never narrow what replay reads.
		expect(result.details).toBeUndefined();
		expect(textOf(result)).toBe("1 pending task: #2 [pending] Implement. 2 open (1 in progress).");
	});

	it("an empty list says so and still reports the open count", async () => {
		const { tool } = setup();

		const result = await call(tool, { action: "list" });

		expect(result.details).toBeUndefined();
		expect(textOf(result)).toBe("No tasks. 0 open.");
	});
});

describe("get", () => {
	it("get returns no details", async () => {
		const { tool, changed } = setup();
		await call(tool, { action: "create", subject: "Design" });
		await call(tool, {
			action: "create",
			subject: "Wire the panel",
			description: "Render the right panel",
			blockedBy: [1],
		});
		// `note` is not a create field (the reducer stores it on update/delete).
		await call(tool, { action: "update", id: 2, note: "blocked on design" });
		changed.length = 0;

		const result = await call(tool, { action: "get", id: 2 });

		expect(result.isError).toBeUndefined();
		expect(result.details).toBeUndefined();
		expect(changed).toEqual([]);
		// The detail fields a list line omits: description, dependencies, note.
		expect(textOf(result)).toBe(
			"#2 [pending] Wire the panel — Render the right panel (blocked by #1; note: blocked on design). 2 open.",
		);
	});

	it("get for an unknown id is an error with no details", async () => {
		const { tool, changed } = setup();

		const result = await call(tool, { action: "get", id: 7 });

		expect(result.isError).toBe(true);
		expect(result.details).toBeUndefined();
		expect(changed).toEqual([]);
		expect(textOf(result)).toBe("#7 not found");
	});
});

describe("delete and clear", () => {
	it("delete keeps the deleted task in details", async () => {
		const { tool, changed } = setup();
		await call(tool, { action: "create", tasks: [{ subject: "Design" }, { subject: "Implement" }] });
		changed.length = 0;

		const result = await call(tool, { action: "delete", id: 1 });

		expect(changed).toEqual([CID]);
		// The panel hides deleted tasks; replay must keep them, and nextId must
		// survive so an id is never reused.
		expect(result.details).toEqual({
			action: "delete",
			tasks: [
				{ id: 1, subject: "Design", status: "deleted" },
				{ id: 2, subject: "Implement", status: "pending" },
			],
			nextId: 3,
		});
		expect(textOf(result)).toBe("Deleted #1 Design. 1 open.");
	});

	it("clear empties the list and keeps nextId", async () => {
		const { tool, changed } = setup();
		await call(tool, { action: "create", tasks: [{ subject: "Design" }, { subject: "Implement" }] });
		changed.length = 0;

		const result = await call(tool, { action: "clear" });

		expect(changed).toEqual([CID]);
		expect(result.details).toEqual({ action: "clear", tasks: [], nextId: 3 });
		expect(textOf(result)).toBe("Cleared 2 tasks. 0 open.");
	});
});

describe("registration", () => {
	it("the registration has callers equal to [\"model\"]", () => {
		const { tool } = setup();

		expect(tool.name).toBe("todo");
		// Nested (code mode) results are not recorded in the transcript, so a
		// script-made change could never be replayed.
		expect(tool.callers).toEqual(["model"]);
	});

	it("the registration is not replay-safe", () => {
		const { tool } = setup();

		// Default "unsafe": an interrupted call is abandoned and the model
		// re-issues it; "safe" could apply a create twice.
		expect(tool.replay).toBeUndefined();
	});

	it("each conversation keeps its own list", async () => {
		const { tool, changed } = setup();

		await call(tool, { action: "create", subject: "Design" }, CID);
		const other = await call(tool, { action: "create", subject: "Implement" }, OTHER);

		// Ids are per conversation: a shared list would have allocated 2 here.
		expect(other.details).toEqual({
			action: "create",
			tasks: [{ id: 1, subject: "Implement", status: "pending" }],
			nextId: 2,
		});
		expect(changed).toEqual([CID, OTHER]);
	});
});

describe("a todo round persists and replays", () => {
	it("a fresh log over the transcript sees the updated state", async () => {
		const dir = await tempDir("sigrun-todo-tool-");
		try {
			const opened = await openTodoHarness(dir, [
				fauxAssistantMessage(
					fauxToolCall("todo", { action: "create", subject: "Wire the panel" }, { id: "call-1" }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("created"),
				fauxAssistantMessage(
					fauxToolCall("todo", { action: "update", id: 1, status: "in_progress" }, { id: "call-2" }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("started"),
			]);
			try {
				const root = await opened.harness.root(BACKGROUND_CONTEXT, {
					agent: { model: opened.defaultModel },
				});
				for (const content of ["create the task", "start it"]) {
					const submission = await root.submit({ type: "input", content }, BACKGROUND_CONTEXT);
					expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
					await root.waitForIdle(BACKGROUND_CONTEXT);
				}

				// A FRESH log has no cache: this reads the transcript, so it passes
				// only if the round's snapshots were committed as tool results.
				const persisted = await new TodoLog(opened.read).get(root.id);

				expect(persisted).toEqual({
					tasks: [{ id: 1, subject: "Wire the panel", status: "in_progress" }],
					nextId: 2,
				});
			} finally {
				await closeOpened(opened);
			}
		} finally {
			await cleanupDir(dir);
		}
	});
});
