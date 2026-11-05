/**
 * The extension factory (Task 9): one `TodoLog`, one `todo` tool, one
 * `todo` section, one hook bundle, one `todos` panel, the `runSettled`
 * settle-and-notify handler. The `reminderRounds` settings contract
 * (positive integer honoured, everything else → 6) is pinned by
 * reminder.test.ts, which drives the real `beforeRequest` handler.
 */

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, ToolExecutionApi } from "@earendil-works/pi-durable";
import createTodo from "../src/index.js";
import { createFakeHost } from "./fake-host.js";

const CID = 7 as ConversationId;

describe("createTodo", () => {
	it("declares the todo extension: one tool, one section, one hook bundle", async () => {
		const host = await createFakeHost();
		const result = createTodo(host);

		expect(result.extension!.name).toBe("todo");
		expect(result.extension!.tools!.map((tool) => tool.name)).toEqual(["todo"]);
		expect(result.extension!.sections!.map((section) => section.key)).toEqual(["todo"]);
		expect(result.extension!.hooks).toHaveLength(1);
		expect(result.runSettled).toBeTypeOf("function");
	});

	it("declares one perConversation `todos` panel", async () => {
		const host = await createFakeHost();
		const result = createTodo(host);

		const panels = result.surfaces?.panels ?? [];
		expect(panels).toHaveLength(1);
		expect(panels[0]!.id).toBe("todos");
		expect(panels[0]!.placement).toBe("panel");
		expect(panels[0]!.perConversation).toBe(true);
	});

	it("a todo tool change notifies the panel with the canonical instance key", async () => {
		const host = await createFakeHost();
		const result = createTodo(host);
		const tool = result.extension!.tools!.find((tool) => tool.name === "todo")!;

		await tool.execute(
			{ action: "create", subject: "Ship it" },
			{ conversationId: CID } as unknown as ToolExecutionApi,
			BACKGROUND_CONTEXT,
		);

		const changed = host.calls.filter((call) => call.method === "surfaces.changed");
		expect(changed).toHaveLength(1);
		expect(changed[0]!.args[0]).toBe("todos");
		expect(changed[0]!.args[1]).toBe('{"conversationId":7}');
	});

	it("runSettled notifies the panel once for a changed round (the aborted-round path)", async () => {
		const host = await createFakeHost();
		const result = createTodo(host);
		const tool = result.extension!.tools!.find((tool) => tool.name === "todo")!;

		// The tool call itself notified once; settle drops the dirty entry,
		// so `runSettled` must notify exactly once more.
		await tool.execute(
			{ action: "create", subject: "Ship it" },
			{ conversationId: CID } as unknown as ToolExecutionApi,
			BACKGROUND_CONTEXT,
		);
		await result.runSettled!(
			{
				conversationId: CID,
				inputs: [],
				inputTexts: [],
				outcome: { status: "unanswered", reason: "aborted" },
			},
			undefined as never,
			undefined as never,
		);

		const changed = host.calls.filter((call) => call.method === "surfaces.changed");
		expect(changed).toHaveLength(2);
		expect(changed[1]!.args[0]).toBe("todos");
		expect(changed[1]!.args[1]).toBe('{"conversationId":7}');
	});

	it("runSettled is quiet for a conversation whose list never changed", async () => {
		const host = await createFakeHost();
		const result = createTodo(host);
		await result.runSettled!(
			{
				conversationId: CID,
				inputs: [],
				inputTexts: [],
				outcome: { status: "unanswered", reason: "aborted" },
			},
			undefined as never,
			undefined as never,
		);
		expect(host.calls.filter((call) => call.method === "surfaces.changed")).toHaveLength(0);
	});
});
