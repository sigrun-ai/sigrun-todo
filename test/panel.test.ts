/**
 * The Todos panel (Task 9): a `perConversation` panel over the conversation's
 * {@link TodoLog}, with the access verdict from the host's own conversation
 * contract. The pinned shapes:
 *
 * - The def declares `perConversation: true`, a `data()`, and NO `instanceKey`
 *   — the default canonical-JSON key is what the webui hashes.
 * - `panelKey` must equal `canonicalJson({ conversationId })` (pinned here
 *   against the shared leaf's real implementation), because
 *   `host.surfaces.changed("todos", key)` is routed by that string.
 * - Deleted tasks are tombstones: out of `items`, out of `total`. Completed
 *   rows stay visible, `tone: "neutral"`, never `quiet`.
 * - Access: an unknown conversation (`meta` throws) or a `none` verdict hides
 *   the panel (`access: "none"`); the no-conversation shape is the empty
 *   state at `read`.
 */

import { describe, expect, it } from "vitest";
import { canonicalJson } from "@sigrun/shared/blocks";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { SurfaceContext } from "@sigrun/sigrun/extension";
import { TodoLog, type EntryReader } from "../src/log.js";
import {
	conversationIdOf,
	createTodoPanel,
	panelKey,
} from "../src/panel.js";
import type { Task } from "../src/types.js";
import { createFakeHost, type FakeHost } from "./fake-host.js";

const CID = 7 as ConversationId;

/** An empty transcript: panel tests seed the log directly. */
const emptyRead: EntryReader = async function* () {};

const principal = {
	user: "alice",
	admin: false,
	service: false,
	method: "host" as const,
};

function contextFor(params: Record<string, unknown>): SurfaceContext {
	return {
		principal,
		params,
		key: canonicalJson(params as never),
		signal: new AbortController().signal,
	} as unknown as SurfaceContext;
}

async function setup(opts?: { access?: "none" | "read" | "write"; unknown?: boolean }) {
	const host: FakeHost = await createFakeHost({
		...(opts?.access === undefined ? {} : { access: opts.access }),
		unknownConversations: opts?.unknown === true ? [CID] : [],
	});
	const log = new TodoLog(emptyRead);
	return { host, log, panel: createTodoPanel({ host, log }) };
}

/** Seed one task through the log's own mutation path. */
async function seed(log: TodoLog, task: Task): Promise<void> {
	await log.mutate(CID, (state) => ({
		state: {
			tasks: [...state.tasks, task],
			nextId: Math.max(state.nextId, task.id + 1),
		},
		op: { kind: "list" },
	}));
}

describe("conversationIdOf", () => {
	it("returns the id for a positive integer conversationId", () => {
		expect(conversationIdOf({ conversationId: 7 })).toBe(7);
	});

	it("returns undefined for absent, non-number, string, negative, and non-integer", () => {
		expect(conversationIdOf({})).toBeUndefined();
		expect(conversationIdOf({ conversationId: "7" })).toBeUndefined();
		expect(conversationIdOf({ conversationId: -1 })).toBeUndefined();
		expect(conversationIdOf({ conversationId: 0 })).toBeUndefined();
		expect(conversationIdOf({ conversationId: 1.5 })).toBeUndefined();
	});
});

describe("panelKey", () => {
	it("equals the canonical JSON form of the single-key params object", () => {
		expect(panelKey(CID)).toBe(canonicalJson({ conversationId: 7 }));
		expect(panelKey(CID)).toBe('{"conversationId":7}');
	});
});

describe("the panel definition", () => {
	it("declares id, title, placement, perConversation, data — and no instanceKey", async () => {
		const { panel } = await setup();
		expect(panel.id).toBe("todos");
		expect(panel.title).toBe("Todos");
		expect(panel.icon).toBe("list");
		expect(panel.placement).toBe("panel");
		expect(panel.perConversation).toBe(true);
		expect(panel.data).toBeTypeOf("function");
		expect(panel.instanceKey).toBeUndefined();
	});
});

describe("render and data", () => {
	it("no conversation renders the empty state with read access", async () => {
		const { panel } = await setup();
		const rendered = await panel.render(contextFor({}));
		expect(rendered.access).toBe("read");
		expect(rendered.data).toEqual({ done: 0, total: 0, summary: "**0/0** done", items: [] });
		expect(rendered.tree.root).toMatchObject({ type: "page", title: "Todos" });

		const data = await panel.data!(contextFor({}));
		expect(data).toEqual({ access: "read", data: { done: 0, total: 0, summary: "**0/0** done", items: [] } });
	});

	it("a principal without access gets none", async () => {
		const { panel } = await setup({ access: "none" });
		const rendered = await panel.render(contextFor({ conversationId: 7 }));
		expect(rendered.access).toBe("none");
		expect(await panel.data!(contextFor({ conversationId: 7 }))).toMatchObject({
			access: "none",
		});
	});

	it("an unknown conversation (meta throws) gets none", async () => {
		const { panel } = await setup({ unknown: true });
		const rendered = await panel.render(contextFor({ conversationId: 7 }));
		expect(rendered.access).toBe("none");
	});

	it("items exclude deleted tasks and keep completed ones, neutral and not quiet", async () => {
		const { log, panel } = await setup();
		await seed(log, {
			id: 1,
			subject: "Done task",
			status: "completed",
			note: "shipped",
		});
		await seed(log, {
			id: 2,
			subject: "Live task",
			status: "in_progress",
			activeForm: "Wiring the panel",
			blockedBy: [1],
		});
		await seed(log, { id: 3, subject: "Dead task", status: "deleted" });

		const rendered = await panel.render(contextFor({ conversationId: 7 }));
		expect(rendered.access).toBe("read");
		expect(rendered.data.total).toBe(2);
		expect(rendered.data.done).toBe(1);

		const items = rendered.data.items as Record<string, unknown>[];
		expect(items.map((item) => item.title)).toEqual(["Live task", "Done task"]);

		const live = items[0]!;
		expect(live.status).toMatchObject({ label: "Wiring the panel", spinner: true });
		expect(live.deps).toEqual(["1"]);
		const done = items[1]!;
		expect(done.tone).toBe("neutral");
		expect(done.quiet).not.toBe(true);
		expect(done.subtitle).toBe("shipped");
	});

	it("an in_progress task without activeForm falls back to the label", async () => {
		const { log, panel } = await setup();
		await seed(log, { id: 1, subject: "Bare", status: "in_progress" });
		const rendered = await panel.render(contextFor({ conversationId: 7 }));
		const items = rendered.data.items as Record<string, unknown>[];
		expect(items[0]!.status).toMatchObject({ label: "in progress", spinner: true });
	});

	it("the tree is a page with the done/total markdown and a list collection", async () => {
		const { log, panel } = await setup();
		await seed(log, { id: 1, subject: "Only", status: "pending" });
		const rendered = await panel.render(contextFor({ conversationId: 7 }));

		const root = rendered.tree.root as unknown as {
			type: string;
			main: { type: string }[];
		};
		expect(root.type).toBe("page");
		const types = root.main.map((block) => block.type);
		expect(types).toEqual(["markdown", "collection"]);
		const collectionBlock = root.main[1] as unknown as {
			display: string;
			items: unknown;
			item: { title: unknown };
		};
		expect(collectionBlockShape(collectionBlock)).toBe(true);
	});

	it("a conversation with no visible items renders the empty state", async () => {
		const { log, panel } = await setup();
		await seed(log, { id: 1, subject: "Deleted", status: "deleted" });
		const rendered = await panel.render(contextFor({ conversationId: 7 }));
		const root = rendered.tree.root as unknown as { empty?: unknown };
		expect(root.empty).toBeDefined();
	});
});

/** The collection's exact wiring, kept out of the main assertion for noise. */
function collectionBlockShape(block: {
	display: string;
	items: unknown;
	item: { title: unknown };
}): boolean {
	return (
		block.display === "list" &&
		JSON.stringify(block.items) === JSON.stringify({ $: "/items" }) &&
		JSON.stringify(block.item.title) === JSON.stringify({ $: "./title" })
	);
}
