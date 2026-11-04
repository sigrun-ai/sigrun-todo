/**
 * The freshness decision table (Task 7). Every case is a hand-built transcript
 * plus a list, because this module is pure: `analyze` reads the message array,
 * the predicates read the view.
 *
 * The two questions the table answers are "may the agent be nagged now?" and
 * "is this the check's own continuation?" — the nagging rules are the spec's
 * anti-goal surface, so each row is a named decision, not a derived number.
 *
 * The helpers below build messages the way the harness does: the tool set
 * arrives on a leading `system` message (`toolsAdded`), a round is an
 * assistant message with a tool call, and a human turn is a `user` message.
 */

import { describe, expect, it } from "vitest";
import {
	Type,
	type AssistantMessage,
	type Message,
	type SystemMessage,
	type Tool,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	TODO_CHECK_MARKER,
	analyze,
	checkText,
	openItems,
	reminderText,
	shouldCheck,
	shouldRemind,
} from "../src/freshness.js";
import type { TaskStatus, TodoState } from "../src/types.js";

/** A tool definition; `analyze` only reads the name, but the type is the real one. */
function toolNamed(name: string): Tool {
	return { name, description: `${name} tool`, parameters: Type.Object({}) };
}

/** The leading system message: the tools the model is offered this request. */
function offering(...names: string[]): SystemMessage {
	return {
		role: "system",
		content: "You are a helpful agent.",
		toolsAdded: names.map(toolNamed),
		timestamp: 0,
	};
}

/** A system message that withdraws a tool mid-transcript. */
function withdrawing(name: string): SystemMessage {
	return { role: "system", content: "", toolsRemoved: [{ name }], timestamp: 0 };
}

/** A human turn. */
function user(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

/** A human turn with no text at all: an image with no caption. */
function imageOnlyUser(): UserMessage {
	return {
		role: "user",
		content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
		timestamp: 0,
	};
}

/** A round: an assistant message with one tool call per name. */
function round(...toolNames: string[]): AssistantMessage {
	return fauxAssistantMessage(
		toolNames.map((name) => fauxToolCall(name, {}, { id: `call-${name}` })),
		{ stopReason: "toolUse" },
	);
}

/** An assistant message that called no tool: prose, not a round. */
function prose(text: string): AssistantMessage {
	return fauxAssistantMessage(text);
}

/** A list holding one task per entry; `nextId` is one past the highest id. */
function list(...entries: Array<[id: number, subject: string, status: TaskStatus]>): TodoState {
	return {
		tasks: entries.map(([id, subject, status]) => ({ id, subject, status })),
		nextId: entries.reduce((highest, [id]) => Math.max(highest, id), 0) + 1,
	};
}

/** Two open items: the list every "may nag" row starts from. */
const OPEN_TWO = list([1, "Design", "pending"], [2, "Write tests", "in_progress"]);

describe("analyze", () => {
	it("reports the tool set the system messages leave in force", () => {
		expect(analyze([offering("todo", "read")]).offered).toBe(true);
		expect(analyze([offering("read", "write")]).offered).toBe(false);
		expect(analyze([offering("todo"), withdrawing("todo")]).offered).toBe(false);
	});

	it("counts a last-round todo call as zero — a read is that same call here", () => {
		const view = analyze([offering("todo"), user("what is left?"), round("todo")]);

		expect(view.roundsSinceTouch).toBe(0);
	});
	it("counts the work rounds after the last todo call", () => {
		const view = analyze([
			offering("todo"),
			user("start"),
			round("todo"),
			round("bash"),
			round("read", "edit"),
		]);

		expect(view.roundsSinceTouch).toBe(2);
	});

	it("counts every round of a run that never touched the list", () => {
		const view = analyze([offering("todo"), user("fix it"), round("bash"), round("read")]);

		expect(view.roundsSinceTouch).toBe(2);
	});

	it("does not count prose as a round", () => {
		const view = analyze([
			offering("todo"),
			user("start"),
			round("todo"),
			prose("thinking about it"),
		]);

		expect(view.roundsSinceTouch).toBe(0);
	});

	it("starts the run at the last user message, not the first", () => {
		const view = analyze([
			offering("todo"),
			user("first task"),
			round("todo"),
			round("bash"),
			user("second task"),
			round("read"),
		]);

		expect(view.roundsSinceTouch).toBe(1);
	});

	it("ignores a todo call from before the last user message", () => {
		const view = analyze([
			offering("todo"),
			user("first task"),
			round("todo"),
			user("second task"),
			round("bash"),
			round("bash"),
		]);

		expect(view.roundsSinceTouch).toBe(2);
		expect(view.lastUserIsCheck).toBe(false);
	});

	it("treats a list with no user message as a single run", () => {
		const view = analyze([offering("todo"), round("bash"), round("todo"), round("read")]);

		expect(view.roundsSinceTouch).toBe(1);
		expect(view.lastUserIsCheck).toBe(false);
	});

	it("flags a user message that opens with the check marker", () => {
		const text = `${TODO_CHECK_MARKER} These items are still open.`;
		expect(analyze([offering("todo"), user(text)]).lastUserIsCheck).toBe(true);
	});

	it("stays quiet when the marker is not at the start of the first text", () => {
		const embedded = user(`please look ${TODO_CHECK_MARKER}`);

		expect(analyze([offering("todo"), embedded]).lastUserIsCheck).toBe(false);
		expect(analyze([offering("todo"), user("unrelated")]).lastUserIsCheck).toBe(false);
	});

	it("does not flag a user message with no text parts", () => {
		expect(analyze([offering("todo"), imageOnlyUser()]).lastUserIsCheck).toBe(false);
	});
});

describe("openItems", () => {
	it("keeps pending and in_progress, drops completed and deleted, orders by id", () => {
		const state = list(
			[3, "Ship", "pending"],
			[1, "Design", "completed"],
			[2, "Write tests", "in_progress"],
			[4, "Drop", "deleted"],
		);

		expect(openItems(state).map((task) => task.id)).toEqual([2, 3]);
	});

	it("is empty for a list with nothing open", () => {
		expect(openItems(list([1, "Design", "completed"]))).toEqual([]);
	});
});

describe("shouldCheck", () => {
	const oneWorkRound = analyze([offering("todo"), user("start"), round("bash")]);

	it("stays quiet on a turn that used no tools at all", () => {
		const view = analyze([offering("todo"), user("hello"), prose("hi!")]);

		expect(view.roundsSinceTouch).toBe(0);
		expect(shouldCheck(view, OPEN_TWO)).toBe(false);
	});
	it("stays quiet when the last round touched the list", () => {
		const view = analyze([offering("todo"), user("start"), round("bash"), round("todo")]);

		expect(shouldCheck(view, OPEN_TWO)).toBe(false);
	});

	it("asks after two work rounds following a todo call", () => {
		const view = analyze([
			offering("todo"),
			user("start"),
			round("todo"),
			round("bash"),
			round("bash"),
		]);

		expect(shouldCheck(view, OPEN_TWO)).toBe(true);
	});

	it("asks after a work round that never touched the list", () => {
		expect(shouldCheck(oneWorkRound, OPEN_TWO)).toBe(true);
	});

	it("stays quiet when the last user message is the check's own continuation", () => {
		const view = analyze([
			offering("todo"),
			user("start"),
			round("bash"),
			user(`${TODO_CHECK_MARKER} still open`),
			round("bash"),
		]);

		expect(shouldCheck(view, OPEN_TWO)).toBe(false);
	});

	it("stays quiet when the tool is not offered", () => {
		const view = analyze([offering("bash", "read"), user("start"), round("bash")]);

		expect(shouldCheck(view, OPEN_TWO)).toBe(false);
	});

	it("stays quiet when nothing is open", () => {
		expect(shouldCheck(oneWorkRound, list([1, "Design", "completed"]))).toBe(false);
		expect(shouldCheck(oneWorkRound, list())).toBe(false);
	});
});

describe("shouldRemind", () => {
	/** One run of `rounds` work rounds: the cadence is measured in them. */
	function runOf(rounds: number): Message[] {
		return [
			offering("todo"),
			user("start"),
			...Array.from({ length: rounds }, () => round("bash")),
		];
	}

	it("reminds on every sixth work round", () => {
		expect(shouldRemind(analyze(runOf(6)), OPEN_TWO, 6)).toBe(true);
		expect(shouldRemind(analyze(runOf(12)), OPEN_TWO, 6)).toBe(true);
	});

	it("stays quiet between the multiples", () => {
		expect(shouldRemind(analyze(runOf(5)), OPEN_TWO, 6)).toBe(false);
		expect(shouldRemind(analyze(runOf(7)), OPEN_TWO, 6)).toBe(false);
	});

	it("stays quiet before any round has run", () => {
		expect(shouldRemind(analyze(runOf(0)), OPEN_TWO, 6)).toBe(false);
	});

	it("stays quiet when the tool is not offered", () => {
		const messages = [offering("bash"), ...runOf(6).slice(1)];

		expect(shouldRemind(analyze(messages), OPEN_TWO, 6)).toBe(false);
	});

	it("stays quiet when nothing is open", () => {
		expect(shouldRemind(analyze(runOf(6)), list([1, "Design", "completed"]), 6)).toBe(false);
	});
});

describe("checkText", () => {
	const text = checkText(openItems(OPEN_TWO));

	it("starts with the marker, so the agent can tell it apart from a human turn", () => {
		expect(text.startsWith(TODO_CHECK_MARKER)).toBe(true);
	});

	it("says it comes from the extension, not the user", () => {
		expect(text).toMatch(/`todo` extension/);
		expect(text).toMatch(/not a message from the user/);
	});

	it("lists every open item as `#<id> <subject> (<status>)`", () => {
		expect(text).toContain("#1 Design (pending)");
		expect(text).toContain("#2 Write tests (in_progress)");
	});

	it("offers the honest way out alongside completed and deleted", () => {
		expect(text).toMatch(/mark it completed/);
		expect(text).toMatch(/delete it with a note/);
		expect(text).toMatch(/update it with a note/);
		expect(text).toMatch(/why it stays open/);
	});
});

describe("reminderText", () => {
	it("states the open count and lists the items in list format", () => {
		const text = reminderText(OPEN_TWO);

		expect(text).toContain("2 open items");
		expect(text).toContain("#1 Design (pending)");
		expect(text).toContain("#2 Write tests (in_progress)");
	});

	it("uses the singular for one item", () => {
		expect(reminderText(list([1, "Design", "pending"]))).toContain("1 open item");
	});
});
