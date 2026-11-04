/**
 * The generation hooks (Task 8): the freshness policy driven by REAL runs
 * through a real pi-durable Harness — the end-of-turn check must be a durable
 * `pi.user` entry that continues the run, the mid-run reminder must ride one
 * request and never become an entry, and `afterTools` must re-seed the log
 * (and cue the panel) exactly when a round committed a list change.
 *
 * The two discrimination tests (`second yield...`, `no continuation when todo
 * is not offered`) pin the mechanisms the plan's Review Focus named: the
 * check must not answer itself even after a REAL further work round, and a
 * turn without the tool offered must never be checked.
 */

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxToolCall,
	type FauxResponseFactory,
	type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import type { Message } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationId,
	type EntryRecord,
} from "@earendil-works/pi-durable";
import { createTodoHooks, type TodoHooksDeps } from "../src/hooks.js";
import { TODO_CHECK_MARKER } from "../src/freshness.js";
import { applyTodo } from "../src/state.js";
import { TodoLog, type EntryReader } from "../src/log.js";
import {
	cleanupDir,
	closeOpened,
	noopTool,
	openTodoHarness,
	tempDir,
	type OpenedHarness,
} from "./harness.js";

/** `create` two open tasks; the log is seeded with both open. */
const CREATE_TWO = fauxToolCall("todo", {
	action: "create",
	tasks: [{ subject: "Design" }, { subject: "Implement" }],
});

const NOOP_ROUND = fauxToolCall("noop", {});

/** One work round: a `noop` call — the round marker without touching the list. */
function workRound(id: string): FauxResponseStep {
	return fauxAssistantMessage(NOOP_ROUND, { stopReason: "toolUse", responseId: id });
}

const HOOKS_EXTENSION = { name: "todo-hooks" } as const;

/** The `todo` ToolRegistration as installed in this harness's registry. */
function todoRegistration(opened: OpenedHarness) {
	const found = opened.registry
		.snapshot()
		.tools()
		.find(({ tool }) => tool.name === "todo")?.tool;
	if (found === undefined) throw new Error("the todo tool is not registered");
	return found;
}

/** Install the hooks (Task 8) as their own extension over the harness's log. */
async function installHooks(
	opened: OpenedHarness,
	overrides?: Partial<TodoHooksDeps>,
): Promise<{ changed: ConversationId[] }> {
	const { defineExtension } = await import("@earendil-works/pi-durable");
	const changed: ConversationId[] = [];
	const deps: TodoHooksDeps = {
		log: opened.log,
		reminderRounds: async () => 6,
		onChanged: (id) => changed.push(id),
		...overrides,
	};
	opened.registry.install(
		defineExtension({ name: HOOKS_EXTENSION.name, hooks: [createTodoHooks(deps)] }),
	);
	return { changed };
}

/** Run one input to a settled run; the hook's continuation is part of it. */
async function submitAndSettle(root: Conversation, content: string): Promise<void> {
	const submission = await root.submit({ type: "input", content }, BACKGROUND_CONTEXT);
	expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
	await root.waitForIdle(BACKGROUND_CONTEXT);
}

/** Ascending committed transcript; `opened.read` is newest-first, so reverse. */
async function transcriptOf(opened: OpenedHarness, id: ConversationId): Promise<EntryRecord[]> {
	const entries: EntryRecord[] = [];
	for await (const entry of opened.read(id)) entries.push(entry);
	return entries.reverse();
}

function userText(entry: EntryRecord): string | undefined {
	const message = entry.model?.[0] as
		| { role?: string; content?: string | Array<{ type: string; text?: string }> }
		| undefined;
	if (message?.role !== "user" || message.content === undefined) return undefined;
	if (typeof message.content === "string") return message.content;
	return message.content.find((part) => part.type === "text")?.text;
}

/** Every committed `pi.user` entry whose text starts with the check marker. */
function checkEntries(entries: readonly EntryRecord[]): EntryRecord[] {
	return entries.filter((entry) => {
		const message = entry.model?.[0] as { role?: string } | undefined;
		return message?.role === "user" && userText(entry)?.startsWith(TODO_CHECK_MARKER) === true;
	});
}

describe("todo generation hooks", () => {
	it("end-of-turn check fires after work left items open", async () => {
		const dir = await tempDir("sigrun-todo-hooks-");
		try {
			const opened = await openTodoHarness(
				dir,
				[
					fauxAssistantMessage(CREATE_TWO, { stopReason: "toolUse" }),
					workRound("w1"),
					fauxAssistantMessage("all done"),
					// The check's continuation: answer it and the run settles.
					fauxAssistantMessage("still working on both"),
				],
				{ tools: [noopTool] },
			);
			await installHooks(opened);
			try {
				const root = await opened.harness.root(BACKGROUND_CONTEXT, {
					agent: { model: opened.defaultModel },
				});
				await submitAndSettle(root, "create the tasks and work");

				const checks = checkEntries(await transcriptOf(opened, root.id));
				expect(checks).toHaveLength(1);
				const text = userText(checks[0] as EntryRecord);
				expect(text).toContain("#1 Design (pending)");
				expect(text).toContain("#2 Implement (pending)");
				// The faux answered the continuation: the run needed one more request.
				expect(opened.faux.state.callCount).toBe(4);
			} finally {
				await closeOpened(opened);
			}
		} finally {
			await cleanupDir(dir);
		}
	});

	it("second yield in the same run does not fire, even after more work", async () => {
		const dir = await tempDir("sigrun-todo-hooks-");
		try {
			const opened = await openTodoHarness(
				dir,
				[
					fauxAssistantMessage(CREATE_TWO, { stopReason: "toolUse" }),
					workRound("w1"),
					fauxAssistantMessage("all done"),
					// After the check fires, the agent does a REAL work round (noop)
					// before answering — roundsSinceTouch is 1 at the second yield.
					workRound("w2"),
					fauxAssistantMessage("kept both open, still working"),
				],
				{ tools: [noopTool] },
			);
			await installHooks(opened);
			try {
				const root = await opened.harness.root(BACKGROUND_CONTEXT, {
					agent: { model: opened.defaultModel },
				});
				const submission = await root.submit(
					{ type: "input", content: "create the tasks and work" },
					BACKGROUND_CONTEXT,
				);
				expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
				// The run is not settled yet — the continuation generation is
				// still mid-run — but the check entry is committed. Assert now,
				// before the continuation settles the submission set.
				const checks = checkEntries(await transcriptOf(opened, root.id));
				// Exactly one check: the continuation's own yield does not
				// re-trigger even though a real work round happened after it —
				// the check message is the run's last user message.
				expect(checks).toHaveLength(1);
				await root.waitForIdle(BACKGROUND_CONTEXT);
				// The check's continuation does not re-fire after more work:
				// nothing past the noop round was requested.
				expect(opened.faux.state.callCount).toBe(5);
				expect(opened.faux.getPendingResponseCount()).toBe(0);
			} finally {
				await closeOpened(opened);
			}
		} finally {
			await cleanupDir(dir);
		}
	});

	it("afterTools re-seeds after a todo round", async () => {
		const dir = await tempDir("sigrun-todo-hooks-");
		try {
			const opened = await openTodoHarness(
				dir,
				[
					fauxAssistantMessage(CREATE_TWO, { stopReason: "toolUse" }),
					workRound("w1"),
					fauxAssistantMessage("done"),
					fauxAssistantMessage("ack"),
				],
				{ tools: [noopTool] },
			);
			const { changed } = await installHooks(opened);
			try {
				const root = await opened.harness.root(BACKGROUND_CONTEXT, {
					agent: { model: opened.defaultModel },
				});
				await submitAndSettle(root, "create the tasks and work");

				// The todo round's committed change is the only onChanged cue:
				// the noop round left the log clean.
				expect(changed).toEqual([root.id]);
			} finally {
				await closeOpened(opened);
			}
		} finally {
			await cleanupDir(dir);
		}
	});

	it("no check after a todo call as the last round", async () => {
		const dir = await tempDir("sigrun-todo-hooks-");
		try {
			const opened = await openTodoHarness(
				dir,
				[
					fauxAssistantMessage(CREATE_TWO, { stopReason: "toolUse" }),
					workRound("w1"),
					fauxAssistantMessage(
						fauxToolCall("todo", { action: "update", id: 1, status: "in_progress" }),
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("started #1"),
				],
				{ tools: [noopTool] },
			);
			await installHooks(opened);
			try {
				const root = await opened.harness.root(BACKGROUND_CONTEXT, {
					agent: { model: opened.defaultModel },
				});
				const submission = await root.submit(
					{ type: "input", content: "create, work, then update the list" },
					BACKGROUND_CONTEXT,
				);
				expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");

				// The final round touched the list: roundsSinceTouch is 0, and an
				// item is still open — a defective check would fire here. Read
				// before the continuation settles the run unanswered.
				expect(checkEntries(await transcriptOf(opened, root.id))).toHaveLength(0);
				await root.waitForIdle(BACKGROUND_CONTEXT);
			} finally {
				await closeOpened(opened);
			}
		} finally {
			await cleanupDir(dir);
		}
	});

	it("no continuation when todo is not offered", async () => {
		const dir = await tempDir("sigrun-todo-hooks-");
		try {
			const opened = await openTodoHarness(
				dir,
				[
					fauxAssistantMessage(CREATE_TWO, { stopReason: "toolUse" }),
					workRound("w1"),
					fauxAssistantMessage("done"),
					fauxAssistantMessage("ack"),
				],
				{ tools: [noopTool] },
			);
			await installHooks(opened);
			try {
				const root = await opened.harness.root(BACKGROUND_CONTEXT, {
					// `tools` selects the enabled tool set by REGISTRATION
					// object: `todo` is registered but never enabled, so the
					// request's tool set — what `analyze` reads — lacks it.
					agent: { model: opened.defaultModel, tools: { remove: [todoRegistration(opened)] } },
				});
				const submission = await root.submit(
					{ type: "input", content: "work without the list" },
					BACKGROUND_CONTEXT,
				);
				expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");

				// Items are open and a work round happened, yet a turn with no
				// way to answer must never be checked.
				expect(checkEntries(await transcriptOf(opened, root.id))).toHaveLength(0);
				// The gating must be real: the request's tool set named
				// only `noop` — `todo` was registered but never offered.
				const systems = (await transcriptOf(opened, root.id)).filter(
					(e) => (e.model?.[0] as { role?: string } | undefined)?.role === "system",
				);
				expect(systems.length).toBeGreaterThan(0);
				const toolsAdded = (systems[0]?.model?.[0] as { toolsAdded?: Array<{ name: string }> })
					.toolsAdded;
				expect(toolsAdded?.map((t) => t.name)).toEqual(["noop"]);
				await root.waitForIdle(BACKGROUND_CONTEXT);
			} finally {
				await closeOpened(opened);
			}
		} finally {
			await cleanupDir(dir);
		}
	});

	it("mid-run reminder rides the request only", async () => {
		const dir = await tempDir("sigrun-todo-hooks-");
		try {
			const requests: Message[][] = [];
			const capture: FauxResponseFactory = (context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage("noted");
			};
			const opened = await openTodoHarness(
				dir,
				[
					fauxAssistantMessage(CREATE_TWO, { stopReason: "toolUse" }),
					workRound("w1"),
					workRound("w2"),
					workRound("w3"),
					workRound("w4"),
					workRound("w5"),
					workRound("w6"),
					capture,
					fauxAssistantMessage("no check needed"),
				],
				{ tools: [noopTool] },
			);
			await installHooks(opened);
			try {
				const root = await opened.harness.root(BACKGROUND_CONTEXT, {
					agent: { model: opened.defaultModel },
				});
				const submission = await root.submit(
					{ type: "input", content: "create the tasks and do six rounds" },
					BACKGROUND_CONTEXT,
				);
				expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");

				// The request after six untouched work rounds carries the reminder
				// as its last message. (The yield check also fires here; the final
				// scripted response answers it and the run settles.)
				expect(requests).toHaveLength(1);
				const last = requests[0]?.at(-1) as
					| { role?: string; content?: unknown }
					| undefined;
				expect(last?.role).toBe("user");
				const reminderBody = JSON.stringify(last?.content);
				expect(reminderBody).toContain("Reminder from the `todo` extension");
				expect(reminderBody).toContain("2 open items are");

				// It rode the request only: no committed entry contains it.
				// (Read before the yield check's continuation settles the run.)
				for (const entry of await transcriptOf(opened, root.id)) {
					expect(JSON.stringify(entry.model ?? [])).not.toContain(
						"Reminder from the `todo` extension",
					);
				}
				await root.waitForIdle(BACKGROUND_CONTEXT);
			} finally {
				await closeOpened(opened);
			}
		} finally {
			await cleanupDir(dir);
		}
	});

	it("afterTools re-seeds after a todo round (fake log)", async () => {
		// The fake-log half of the contract: `settle` returning true is what
		// fires `onChanged`, exactly once per round that reports it.
		const dir = await tempDir("sigrun-todo-hooks-");
		try {
			const opened = await openTodoHarness(
				dir,
				[workRound("w1"), fauxAssistantMessage("done")],
				{ tools: [noopTool] },
			);
			const emptyRead: EntryReader = async function* () {};
			const fakeLog = new TodoLog(emptyRead);
			let settleCalls = 0;
			fakeLog.settle = () => {
				settleCalls += 1;
				return true;
			};
			const { changed } = await installHooks(opened, { log: fakeLog });
			try {
				const root = await opened.harness.root(BACKGROUND_CONTEXT, {
					agent: { model: opened.defaultModel },
				});
				await submitAndSettle(root, "one round, one dirty settle");

				expect(settleCalls).toBe(1);
				expect(changed).toEqual([root.id]);
			} finally {
				await closeOpened(opened);
			}
		} finally {
			await cleanupDir(dir);
		}
	});

	it("the mid-run cadence honors the configured k", async () => {
		// k = 1: every untouched work round is a reminder round, so the
		// post-round request ends with the reminder.
		const dir = await tempDir("sigrun-todo-hooks-");
		try {
			const requests: Message[][] = [];
			const capture: FauxResponseFactory = (context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage("noted");
			};
			const opened = await openTodoHarness(
				dir,
				[
					fauxAssistantMessage(CREATE_TWO, { stopReason: "toolUse" }),
					workRound("w1"),
					capture,
					fauxAssistantMessage("no check needed"),
				],
				{ tools: [noopTool] },
			);
			await installHooks(opened, { reminderRounds: async () => 1 });
			try {
				const root = await opened.harness.root(BACKGROUND_CONTEXT, {
					agent: { model: opened.defaultModel },
				});
				const submission = await root.submit(
					{ type: "input", content: "create the tasks and do one round" },
					BACKGROUND_CONTEXT,
				);
				expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");

				expect(requests).toHaveLength(1);
				const last = requests[0]?.at(-1) as { role?: string; content?: unknown } | undefined;
				expect(last?.role).toBe("user");
				expect(JSON.stringify(last?.content)).toContain("Reminder from the `todo` extension");
				await root.waitForIdle(BACKGROUND_CONTEXT);
			} finally {
				await closeOpened(opened);
			}
		} finally {
			await cleanupDir(dir);
		}
	});
});

describe("createTodoHooks in isolation", () => {
	it("afterTools calls onChanged only when settle reports a dirty round", async () => {
		const emptyRead: EntryReader = async function* () {};
		const log = new TodoLog(emptyRead);
		// Dirty round: a state-changing op went through mutate.
		await log.mutate(1 as ConversationId, (state) =>
			applyTodo(state, { action: "create", subject: "Wire the panel" }),
		);
		const changed: ConversationId[] = [];
		const registration = createTodoHooks({
			log,
			reminderRounds: async () => 6,
			onChanged: (id) => changed.push(id),
		});
		const handlers = registration.handlers as {
			afterTools: (
				assistant: unknown,
				results: unknown[],
				api: { conversationId: ConversationId },
			) => void;
		};

		handlers.afterTools(undefined, [], { conversationId: 1 as ConversationId });
		handlers.afterTools(undefined, [], { conversationId: 2 as ConversationId });

		expect(changed).toEqual([1 as ConversationId]);
		expect(registration.task).toBe("pi.generation");
	});
});
