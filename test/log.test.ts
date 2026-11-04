/**
 * Transcript replay + the per-conversation cache (Task 5).
 *
 * Unit tests drive `replay` and `TodoLog` over an array-backed
 * {@link EntryReader}; the one harness test at the bottom proves the fork
 * boundary over a REAL pi-durable Harness (the entry ids are not synthetic —
 * they come from two real runs).
 */

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, Cursor, EntryId, EntryRecord, Page } from "@earendil-works/pi-durable";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { SigrunHost } from "@sigrun/sigrun/extension";
import { applyTodo } from "../src/state.js";
import { EMPTY_STATE, type TodoSnapshot, type TodoState } from "../src/types.js";
import { TodoLog, hostEntryReader, replay, type EntryReader } from "../src/log.js";
import { cleanupDir, closeOpened, openTodoHarness, tempDir } from "./harness.js";

const CID = 1 as ConversationId;

/** One toolResult message with a `details` payload. */
function toolResultMessage(
	id: number,
	toolName: string,
	isError: boolean,
	details?: unknown,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${id}`,
		toolName,
		content: [{ type: "text", text: "x" }],
		...(details === undefined ? {} : { details: details as ToolResultMessage["details"] }),
		isError,
		timestamp: id,
	};
}

/** A synthetic `pi.tool-result` entry carrying a `todo` snapshot. */
function snapshotEntry(id: number, state: TodoState): EntryRecord {
	const details: TodoSnapshot = { ...state, action: "create" };
	return {
		id: id as EntryId,
		conversationId: CID,
		kind: "pi.tool-result",
		model: [toolResultMessage(id, "todo", false, details)],
	};
}

/** A synthetic `pi.tool-result` entry for any tool / error shape. */
function toolResultEntry(
	id: number,
	toolName: string,
	isError: boolean,
	details?: unknown,
): EntryRecord {
	return {
		id: id as EntryId,
		conversationId: CID,
		kind: "pi.tool-result",
		model: [toolResultMessage(id, toolName, isError, details)],
	};
}

/** A synthetic bookkeeping entry (`pi.reset`, `pi.compaction`, …). */
function markerEntry(id: number, kind: string): EntryRecord {
	return { id: id as EntryId, conversationId: CID, kind };
}

/**
 * An array-backed {@link EntryReader}: the newest entry FIRST, exactly as a
 * descending scan yields it. `calls` records each invocation.
 */
function arrayReader(entries: readonly EntryRecord[]): {
	read: EntryReader;
	calls: () => number;
} {
	let calls = 0;
	return {
		calls: () => calls,
		read: async function* () {
			calls += 1;
			for (const entry of entries) yield entry;
		},
	};
}

/** Create tasks #1..#count into a state. */
function seedState(count: number): TodoState {
	let state = EMPTY_STATE;
	for (let i = 1; i <= count; i++) {
		const result = applyTodo(state, { action: "create", subject: `Task ${i}` });
		if (result.op.kind !== "create") throw new Error("seed create failed");
		state = result.state;
	}
	return state;
}

describe("replay", () => {
	it("returns the newest todo snapshot", async () => {
		const older = seedState(1);
		const newer = seedState(2);
		const { read } = arrayReader([
			snapshotEntry(3, newer), // newest first
			markerEntry(2, "pi.assistant"),
			snapshotEntry(1, older),
		]);
		expect(await replay(read, CID)).toEqual({ tasks: newer.tasks, nextId: newer.nextId });
	});

	it("ignores error results and other tools", async () => {
		const state = seedState(1);
		const { read } = arrayReader([
			toolResultEntry(5, "todo", true, { ...seedState(9), action: "create" }), // error: skip
			toolResultEntry(4, "other_tool", false, { ...seedState(9), action: "create" }), // wrong tool: skip
			toolResultEntry(3, "todo", false, { garbage: true }), // malformed details: skip
			snapshotEntry(2, state),
		]);
		expect(await replay(read, CID)).toEqual({ tasks: state.tasks, nextId: state.nextId });
	});

	it("stops at pi.reset", async () => {
		const { read } = arrayReader([
			markerEntry(3, "pi.reset"),
			snapshotEntry(2, seedState(2)),
		]);
		expect(await replay(read, CID)).toEqual(EMPTY_STATE);
	});

	it("walks past pi.compaction", async () => {
		const state = seedState(2);
		const { read } = arrayReader([
			markerEntry(4, "pi.compaction"),
			markerEntry(3, "pi.user"),
			snapshotEntry(2, state),
		]);
		expect(await replay(read, CID)).toEqual({ tasks: state.tasks, nextId: state.nextId });
	});

	it("returns EMPTY_STATE when no snapshot exists", async () => {
		const { read } = arrayReader([markerEntry(2, "pi.user"), markerEntry(1, "pi.assistant")]);
		expect(await replay(read, CID)).toEqual(EMPTY_STATE);
	});

	it("hostEntryReader pages until exhausted, threading the cursor", async () => {
		const state = seedState(2);
		const seenCursors: (Cursor | undefined)[] = [];
		const page2Cursor = { offset: 100 } as unknown as Cursor;
		const host = {
			conversations: {
				entries: async (
					id: ConversationId,
					query: { order?: "ascending" | "descending" },
					limit: number,
					cursor?: Cursor,
				): Promise<Page<EntryRecord, Cursor>> => {
					expect(id).toBe(CID);
					expect(query).toEqual({ order: "descending" });
					expect(limit).toBe(100);
					seenCursors.push(cursor);
					if (cursor === undefined) {
						// Page 1: bookkeeping only, more pages.
						return { items: [markerEntry(300, "pi.compaction")], next: page2Cursor };
					}
					expect(cursor).toBe(page2Cursor);
					// Page 2: the snapshot lives here, no further pages.
					return { items: [snapshotEntry(200, state), snapshotEntry(150, EMPTY_STATE)] };
				},
			},
		} as Pick<SigrunHost, "conversations">;
		const found = await replay(hostEntryReader(host), CID);
		expect(found).toEqual({ tasks: state.tasks, nextId: state.nextId });
		expect(seenCursors).toEqual([undefined, page2Cursor]);
	});
});

describe("TodoLog", () => {
	it("concurrent calls serialize through the cache", async () => {
		const { read } = arrayReader([snapshotEntry(1, EMPTY_STATE)]);
		const log = new TodoLog(read);
		const [a, b] = await Promise.all([
			log.mutate(CID, (state) => applyTodo(state, { action: "create", subject: "Task A" })),
			log.mutate(CID, (state) => applyTodo(state, { action: "create", subject: "Task B" })),
		]);
		const state = await log.get(CID);
		expect(state.tasks.map((task) => task.id)).toEqual([1, 2]);
		// Each mutation saw the other's result: ids did not collide.
		expect([a.state.nextId, b.state.nextId]).toEqual([2, 3]);
	});

	it("get seeds from the reader once, shared across concurrent callers", async () => {
		const { read, calls } = arrayReader([snapshotEntry(1, seedState(1))]);
		const log = new TodoLog(read);
		const [first, second, third] = await Promise.all([log.get(CID), log.get(CID), log.get(CID)]);
		expect(calls()).toBe(1);
		expect(first).toBe(second);
		expect(third.tasks).toHaveLength(1);
		// Later gets hit the cache, not the transcript.
		await log.get(CID);
		expect(calls()).toBe(1);
	});

	it("forget drops an uncommitted change; settle reports dirty once", async () => {
		const clean = seedState(1);
		const { read } = arrayReader([snapshotEntry(1, clean)]);
		const log = new TodoLog(read);

		// A mutation the transcript never sees (the tool call aborts).
		await log.mutate(CID, (state) => applyTodo(state, { action: "create", subject: "Phantom" }));

		// Dirty → settle clears, forgets, and reports true.
		expect(log.settle(CID)).toBe(true);
		// The next get re-seeds from the transcript: the uncommitted change is gone.
		expect(await log.get(CID)).toEqual({ tasks: clean.tasks, nextId: clean.nextId });
		// Clean now: settle reports false.
		expect(log.settle(CID)).toBe(false);
	});

	it("a non-state-changing op does not dirty the cache", async () => {
		const { read } = arrayReader([snapshotEntry(1, seedState(1))]);
		const log = new TodoLog(read);
		await log.mutate(CID, (state) => applyTodo(state, { action: "list" }));
		expect(log.settle(CID)).toBe(false);
	});

	it("forget drops the cache entry so the next get re-seeds", async () => {
		const { read, calls } = arrayReader([snapshotEntry(1, seedState(1))]);
		const log = new TodoLog(read);
		await log.get(CID);
		log.forget(CID);
		await log.get(CID);
		expect(calls()).toBe(2);
	});

	it("a rejected seed is not cached: the next get retries the reader", async () => {
		const state = seedState(1);
		let calls = 0;
		const read: EntryReader = async function* () {
			calls += 1;
			if (calls === 1) throw new Error("reader blew up");
			yield snapshotEntry(1, state);
		};
		const log = new TodoLog(read);
		await expect(log.get(CID)).rejects.toThrow("reader blew up");
		// The rejection is not pinned: the retry re-reads and seeds.
		expect(await log.get(CID)).toEqual({ tasks: state.tasks, nextId: state.nextId });
		expect(calls).toBe(2);
	});
});

describe("fork boundary (real harness)", () => {
	it("fork inherits the list at the fork point", async () => {
		const dir = await tempDir("sigrun-todo-log-");
		try {
			const opened = await openTodoHarness(dir, [
				// Turn 1: the model creates tasks 1–2 in one batch.
				fauxAssistantMessage(
					fauxToolCall(
						"todo",
						{ action: "create", tasks: [{ subject: "Task 1" }, { subject: "Task 2" }] },
						{ id: "call-1" },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("created"),
				// Turn 2 (the parent, AFTER the fork): complete task 1.
				fauxAssistantMessage(
					fauxToolCall("todo", { action: "update", id: 1, status: "completed" }, { id: "call-2" }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("completed task 1"),
			]);
			try {
				const root = await opened.harness.root(BACKGROUND_CONTEXT, {
					agent: { model: opened.defaultModel },
				});

				// Turn 1 on the parent: tasks 1–2 created.
				let submission = await root.submit(
					{ type: "input", content: "create the tasks" },
					BACKGROUND_CONTEXT,
				);
				expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
				await root.waitForIdle(BACKGROUND_CONTEXT);

				// Fork at the newest entry of that run.
				const newest = await root.entries({}, 1, undefined, BACKGROUND_CONTEXT);
				const forkPoint = newest.items[0];
				if (!forkPoint) throw new Error("expected at least one entry after turn 1");
				const forked = await root.fork(
					forkPoint.id,
					{ ownership: { kind: "ownerless" } },
					BACKGROUND_CONTEXT,
				);

				// Turn 2 on the PARENT: task 1 completed (post-fork).
				submission = await root.submit(
					{ type: "input", content: "complete task 1" },
					BACKGROUND_CONTEXT,
				);
				expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
				await root.waitForIdle(BACKGROUND_CONTEXT);

				// The parent replay sees the completion…
				const parentState = await replay(opened.read, root.id);
				expect(parentState.tasks.find((task) => task.id === 1)?.status).toBe("completed");

				// …but the fork's history stops at the fork point: task 1 stays pending.
				const forkState = await replay(opened.read, forked.id);
				expect(forkState.tasks.map((task) => task.id)).toEqual([1, 2]);
				expect(forkState.tasks.find((task) => task.id === 1)?.status).toBe("pending");
			} finally {
				await closeOpened(opened);
			}
		} finally {
			await cleanupDir(dir);
		}
	});
});
