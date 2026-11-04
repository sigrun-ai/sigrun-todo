import { describe, expect, it } from "vitest";
import { applyTodo, changesState, type Op } from "../src/state.js";
import { EMPTY_STATE, type TodoState } from "../src/types.js";

/** Create one task and return the resulting state plus its id. */
function createOne(state: TodoState, subject: string): { state: TodoState; id: number } {
	const result = applyTodo(state, { action: "create", subject });
	if (result.op.kind !== "create") throw new Error(`expected a create op, got ${JSON.stringify(result.op)}`);
	return { state: result.state, id: result.op.taskIds[0] as number };
}

/** Create tasks #1..#count, so tests can start from a populated list. */
function seed(count: number): TodoState {
	let state = EMPTY_STATE;
	for (let i = 1; i <= count; i++) state = createOne(state, `Task ${i}`).state;
	return state;
}

function expectError(op: Op): string {
	expect(op.kind).toBe("error");
	if (op.kind !== "error") throw new Error("unreachable");
	return op.message;
}

describe("create", () => {
	it("allocates ids from 1 and advances nextId", () => {
		const result = applyTodo(EMPTY_STATE, { action: "create", subject: "Write the reducer" });

		expect(result.op).toEqual({ kind: "create", taskIds: [1] });
		expect(result.state.nextId).toBe(2);
		expect(result.state.tasks).toEqual([{ id: 1, subject: "Write the reducer", status: "pending" }]);
		expect(changesState(result.op)).toBe(true);
	});

	it("stores description, activeForm and blockedBy", () => {
		const first = createOne(EMPTY_STATE, "Design");
		const result = applyTodo(first.state, {
			action: "create",
			subject: "Implement",
			description: "Write the reducer",
			activeForm: "writing the reducer",
			blockedBy: [first.id],
		});

		expect(result.op).toEqual({ kind: "create", taskIds: [2] });
		expect(result.state.tasks[1]).toEqual({
			id: 2,
			subject: "Implement",
			description: "Write the reducer",
			activeForm: "writing the reducer",
			status: "pending",
			blockedBy: [1],
		});
	});

	it("creates a batch with sequential ids", () => {
		const result = applyTodo(EMPTY_STATE, {
			action: "create",
			tasks: [{ subject: "One" }, { subject: "Two", activeForm: "doing two" }, { subject: "Three" }],
		});

		expect(result.op).toEqual({ kind: "create", taskIds: [1, 2, 3] });
		expect(result.state.nextId).toBe(4);
		expect(result.state.tasks.map((task) => task.subject)).toEqual(["One", "Two", "Three"]);
		expect(result.state.tasks.every((task) => task.status === "pending")).toBe(true);
	});

	it("rejects a create without a subject", () => {
		const result = applyTodo(EMPTY_STATE, { action: "create" });

		expect(expectError(result.op)).toBe("subject required for create");
		expect(result.state).toBe(EMPTY_STATE);
	});

	it("rejects a batch whose items block on each other", () => {
		const result = applyTodo(EMPTY_STATE, {
			action: "create",
			tasks: [{ subject: "One" }, { subject: "Two", blockedBy: [1] }],
		});

		expect(expectError(result.op)).toBe(
			"blockedBy: #1 is another item in this batch; create the prerequisite first, then the dependent with blockedBy",
		);
		expect(result.state).toBe(EMPTY_STATE);
	});
});

describe("update", () => {
	it("moves pending to in_progress and reports the change", () => {
		const { state, id } = createOne(EMPTY_STATE, "Write tests");

		const result = applyTodo(state, { action: "update", id, status: "in_progress" });

		expect(result.op).toEqual({
			kind: "update",
			id,
			fromStatus: "pending",
			toStatus: "in_progress",
			changed: true,
		});
		expect(result.state.tasks[0]?.status).toBe("in_progress");
		expect(changesState(result.op)).toBe(true);
	});

	it("reports a same-status update as not changing state", () => {
		const { state, id } = createOne(EMPTY_STATE, "Write tests");

		const result = applyTodo(state, { action: "update", id, status: "pending" });

		expect(result.op).toEqual({
			kind: "update",
			id,
			fromStatus: "pending",
			toStatus: "pending",
			changed: false,
		});
		expect(changesState(result.op)).toBe(false);
		expect(result.state.tasks[0]?.status).toBe("pending");
	});

	it("stores a note and counts it as a change", () => {
		const { state, id } = createOne(EMPTY_STATE, "Write tests");

		const result = applyTodo(state, { action: "update", id, note: "still open because the reducer moved" });

		expect(result.op).toEqual({
			kind: "update",
			id,
			fromStatus: "pending",
			toStatus: "pending",
			changed: true,
		});
		expect(result.state.tasks[0]?.note).toBe("still open because the reducer moved");
	});

	it("rejects an update with no mutable field", () => {
		const { state, id } = createOne(EMPTY_STATE, "Write tests");

		const result = applyTodo(state, { action: "update", id });

		expect(expectError(result.op)).toBe(
			"update requires at least one mutable field: subject, description, activeForm, status, note, addBlockedBy, or removeBlockedBy",
		);
		expect(result.state).toBe(state);
	});

	it("rejects an unknown id", () => {
		const state = seed(1);

		const result = applyTodo(state, { action: "update", id: 99, status: "in_progress" });

		expect(expectError(result.op)).toBe("#99 not found");
		expect(result.state).toBe(state);
	});
});

describe("status transitions", () => {
	function completed(): { state: TodoState; id: number } {
		const created = createOne(EMPTY_STATE, "Done thing");
		const result = applyTodo(created.state, { action: "update", id: created.id, status: "completed" });
		return { state: result.state, id: created.id };
	}

	it("allows completed to deleted", () => {
		const { state, id } = completed();

		const result = applyTodo(state, { action: "update", id, status: "deleted" });

		expect(result.op.kind).toBe("update");
		expect(result.state.tasks[0]?.status).toBe("deleted");
	});

	it("rejects completed back to in_progress", () => {
		const { state, id } = completed();

		const result = applyTodo(state, { action: "update", id, status: "in_progress" });

		expect(expectError(result.op)).toBe("illegal transition completed → in_progress");
		expect(result.state).toBe(state);
	});

	it("treats deleted as terminal", () => {
		const state = seed(1);
		const deleted = applyTodo(state, { action: "delete", id: 1 }).state;

		const result = applyTodo(deleted, { action: "update", id: 1, status: "pending" });

		expect(expectError(result.op)).toBe("illegal transition deleted → pending");
		expect(result.state).toBe(deleted);
	});
});

describe("delete", () => {
	it("tombstones the task and stores the note", () => {
		const state = seed(1);

		const result = applyTodo(state, { action: "delete", id: 1, note: "dropped: direction changed" });

		expect(result.op).toEqual({ kind: "delete", id: 1, subject: "Task 1" });
		expect(result.state.tasks[0]).toEqual({
			id: 1,
			subject: "Task 1",
			status: "deleted",
			note: "dropped: direction changed",
		});
		expect(changesState(result.op)).toBe(true);
	});

	it("rejects deleting an already-deleted task", () => {
		const state = seed(1);
		const deleted = applyTodo(state, { action: "delete", id: 1 }).state;

		const result = applyTodo(deleted, { action: "delete", id: 1 });

		expect(expectError(result.op)).toBe("#1 is already deleted");
		expect(result.state).toBe(deleted);
	});

	it("rejects an unknown id", () => {
		const state = seed(1);

		const result = applyTodo(state, { action: "delete", id: 7 });

		expect(expectError(result.op)).toBe("#7 not found");
		expect(result.state).toBe(state);
	});
});

describe("blockedBy invariants", () => {
	it("rejects a dangling dependency on create", () => {
		const result = applyTodo(EMPTY_STATE, { action: "create", subject: "Dependent", blockedBy: [5] });

		expect(expectError(result.op)).toBe("blockedBy: #5 not found");
		expect(result.state).toBe(EMPTY_STATE);
	});

	it("rejects a dependency on a deleted task", () => {
		const state = seed(2);
		const withDeleted = applyTodo(state, { action: "delete", id: 2 }).state;

		const result = applyTodo(withDeleted, { action: "create", subject: "Dependent", blockedBy: [2] });

		expect(expectError(result.op)).toBe("blockedBy: #2 is deleted");
		expect(result.state).toBe(withDeleted);
	});

	it("rejects self-blocking on update", () => {
		const state = seed(1);

		const result = applyTodo(state, { action: "update", id: 1, addBlockedBy: [1] });

		expect(expectError(result.op)).toBe("cannot block #1 on itself");
		expect(result.state).toBe(state);
	});

	it("rejects a cycle", () => {
		const state = seed(2);
		const blocked = applyTodo(state, { action: "update", id: 2, addBlockedBy: [1] });
		expect(blocked.op.kind).toBe("update");
		expect(blocked.state.tasks[1]?.blockedBy).toEqual([1]);

		const result = applyTodo(blocked.state, { action: "update", id: 1, addBlockedBy: [2] });

		expect(expectError(result.op)).toBe("addBlockedBy would create a cycle in the blockedBy graph");
		expect(result.state).toBe(blocked.state);
	});

	it("rejects adding a dangling or deleted dependency on update", () => {
		const state = seed(2);
		const withDeleted = applyTodo(state, { action: "delete", id: 2 }).state;

		expect(expectError(applyTodo(withDeleted, { action: "update", id: 1, addBlockedBy: [9] }).op)).toBe(
			"addBlockedBy: #9 not found",
		);
		expect(expectError(applyTodo(withDeleted, { action: "update", id: 1, addBlockedBy: [2] }).op)).toBe(
			"addBlockedBy: #2 is deleted",
		);
	});

	it("adds and removes dependencies", () => {
		const state = seed(2);
		const withDep = applyTodo(state, { action: "update", id: 1, addBlockedBy: [2] });
		expect(withDep.state.tasks[0]?.blockedBy).toEqual([2]);

		const withoutDep = applyTodo(withDep.state, { action: "update", id: 1, removeBlockedBy: [2] });

		expect(withoutDep.state.tasks[0]?.blockedBy).toBeUndefined();
		expect(withoutDep.op).toMatchObject({ kind: "update", changed: true });
	});
});

describe("reads", () => {
	it("list leaves state untouched", () => {
		const state = seed(2);

		const result = applyTodo(state, { action: "list" });

		expect(result.op).toEqual({ kind: "list" });
		expect(result.state).toBe(state);
		expect(changesState(result.op)).toBe(false);
	});

	it("list carries the status filter", () => {
		const state = seed(2);

		const result = applyTodo(state, { action: "list", status: "pending" });

		expect(result.op).toEqual({ kind: "list", statusFilter: "pending" });
		expect(result.state).toBe(state);
	});

	it("get returns the task without changing state", () => {
		const state = seed(2);

		const result = applyTodo(state, { action: "get", id: 2 });

		expect(result.op).toEqual({ kind: "get", task: { id: 2, subject: "Task 2", status: "pending" } });
		expect(result.state).toBe(state);
		expect(changesState(result.op)).toBe(false);
	});

	it("get rejects an unknown id", () => {
		const state = seed(1);

		const result = applyTodo(state, { action: "get", id: 4 });

		expect(expectError(result.op)).toBe("#4 not found");
		expect(result.state).toBe(state);
	});
});

describe("clear", () => {
	it("removes every task but keeps nextId so ids are never reused", () => {
		const state = seed(3);

		const result = applyTodo(state, { action: "clear" });

		expect(result.op).toEqual({ kind: "clear", count: 3 });
		expect(result.state).toEqual({ tasks: [], nextId: 4 });
		expect(changesState(result.op)).toBe(true);

		const recreated = applyTodo(result.state, { action: "create", subject: "After clear" });
		expect(recreated.op).toEqual({ kind: "create", taskIds: [4] });
	});
});
