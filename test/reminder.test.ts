/**
 * The reminderRounds setting (Task 9): read per request from the extension's
 * settings object, a positive integer honoured, everything else → 6. These
 * tests drive the real `beforeRequest` handler with a transcript at exactly
 * `roundsSinceTouch = 3`, where a setting of 3 reminds and 6 stays quiet.
 */

import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	Type,
	type AssistantMessage,
	type Message,
	type SystemMessage,
	type Tool,
	type UserMessage,
} from "@earendil-works/pi-ai";
import type { ConversationId, HookApi, ToolExecutionApi } from "@earendil-works/pi-durable";
import createTodo from "../src/index.js";
import { createFakeHost, type FakeHost } from "./fake-host.js";

const hosts: FakeHost[] = [];

afterEach(async () => {
	await Promise.all(hosts.splice(0).map((host) => host.cleanup()));
});

const CID = 1 as ConversationId;

function toolNamed(name: string): Tool {
	return { name, description: `${name} tool`, parameters: Type.Object({}) };
}

function offering(...names: string[]): SystemMessage {
	return {
		role: "system",
		content: "You are a helpful agent.",
		toolsAdded: names.map(toolNamed),
		timestamp: 0,
	};
}

function user(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

let roundSeq = 0;

function round(...toolNames: string[]): AssistantMessage {
	return fauxAssistantMessage(
		toolNames.map((name) => fauxToolCall(name, {}, { id: `call-${name}-${roundSeq++}` })),
		{ stopReason: "toolUse" },
	);
}

/**
 * A request at `roundsSinceTouch = 3` with `todo` offered: the last human
 * turn, then three work rounds that never touch the list.
 */
function requestAtRound3(): { messages: readonly Message[] } {
	return {
		messages: [offering("todo", "read"), user("do the work"), round("read"), round("read"), round("read")],
	};
}

/**
 * Drive the factory's own `beforeRequest` after seeding one open item
 * through the factory's own tool — no fixture reaches into internals; the
 * tool call is how a live conversation gets an open item.
 */
async function remindResult(
	settings: Record<string, unknown>,
): Promise<{ messages: readonly Message[] } | undefined> {
	const host = await createFakeHost({ settings });
	hosts.push(host);
	const result = createTodo(host);
	const tool = result.extension!.tools!.find((t) => t.name === "todo")!;
	await tool.execute(
		{ action: "create", subject: "Open" },
		{ conversationId: CID } as unknown as ToolExecutionApi,
		BACKGROUND_CONTEXT,
	);

	const hooks = result.extension!.hooks!;
	expect(hooks).toHaveLength(1);
	const beforeRequest = (
		hooks[0]!.handlers as {
			beforeRequest: (
				request: { messages: readonly Message[] },
				api: HookApi,
				context: unknown,
			) => unknown;
		}
	).beforeRequest;
	const api = { conversationId: CID } as unknown as HookApi;
	return (await beforeRequest(requestAtRound3(), api, BACKGROUND_CONTEXT)) as
		| { messages: readonly Message[] }
		| undefined;
}

describe("reminderRounds", () => {
	it("a setting of 3 fires the reminder at the third untouched round", async () => {
		const result = await remindResult({ reminderRounds: 3 });
		expect(result).toBeDefined();
		expect(result!.messages.length).toBe(requestAtRound3().messages.length + 1);
		const last = result!.messages[result!.messages.length - 1]!;
		expect(last.role).toBe("user");
	});

	it("the default (no setting) does not fire before round 6", async () => {
		expect(await remindResult({})).toBeUndefined();
	});

	it.each([
		{ value: "x", label: "a string" },
		{ value: 0, label: "zero" },
		{ value: -2, label: "a negative" },
		{ value: 1.5, label: "a non-integer" },
	])("a setting of $value ($label) falls back to 6", async ({ value }) => {
		expect(await remindResult({ reminderRounds: value })).toBeUndefined();
	});
});
