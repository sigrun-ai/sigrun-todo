/**
 * The Todos panel (Task 9): a `perConversation` panel over the
 * conversation's {@link TodoLog}.
 *
 * - `perConversation: true` and NO `instanceKey`: the channels attach the
 *   panel with `params: { conversationId }` of the open conversation, and
 *   the default canonical-JSON instance key is what the webui hashes —
 *   declaring one would break live updates.
 * - Every render/data checks the CALLER's access: the conversationId is
 *   client-supplied, so an unknown conversation (a `meta` throw) or a
 *   `none` verdict hides the panel outright.
 * - Deleted tasks are tombstones (out of `items` AND out of `total`);
 *   completed rows stay visible, `tone: "neutral"`, never `quiet`.
 * - The tree is a `page` (no sidebar — panel placement) with a markdown
 *   `done/total` line and a list `collection` bound to `/items`.
 */

import type { ConversationId, JsonObject } from "@earendil-works/pi-durable";
import type {
	SigrunHost,
	SurfaceContext,
	SurfaceDef,
	SurfaceDataResult,
	SurfaceRenderResult,
} from "@sigrun/sigrun/extension";
import type { Block, Card, Tree } from "@sigrun/shared/blocks";
import type { TodoLog } from "./log.js";
import type { Task } from "./types.js";

export interface TodoPanelDeps {
	readonly host: SigrunHost;
	readonly log: TodoLog;
}

/** One visible list row, as the `items` data field carries it. */
interface TodoRow {
	readonly id: string;
	readonly title: string;
	readonly subtitle?: string;
	readonly status: { label: string; spinner: boolean };
	readonly tone?: "neutral";
	readonly deps?: readonly string[];
}

/** The surface data: the counts line plus the visible rows. */
interface TodoPanelData {
	readonly done: number;
	readonly total: number;
	/** The markdown counts line, bound so `data()` refreshes it live. */
	readonly summary: string;
	items: TodoRow[];
}

/** The empty panel: no rows, whatever the access path that led here. */
const EMPTY_DATA: TodoPanelData = { done: 0, total: 0, summary: "**0/0** done", items: [] };

/**
 * The conversation id of a `perConversation` params object, or `undefined`:
 * a positive integer `conversationId`, nothing else. The value is
 * client-supplied; a brand-cast number must still be an id, so only a
 * positive integer is accepted. (The cast stamps pi-durable's branded
 * `ConversationId` — the runtime check above is the whole guard.)
 */
export function conversationIdOf(params: JsonObject): ConversationId | undefined {
	const id = params.conversationId;
	if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return undefined;
	// A positive integer IS a ConversationId; the brand carries no runtime payload.
	return id as ConversationId;
}

/**
 * The instance key a `changed` notification is routed by. This must equal
 * `canonicalJson({ conversationId })` — the default key for the params the
 * channels attach — which for this single numeric key is plain
 * `JSON.stringify` (pinned against `canonicalJson` by the panel test).
 */
export function panelKey(id: ConversationId): string {
	return JSON.stringify({ conversationId: id });
}

function rowOf(task: Task): TodoRow {
	const inProgress = task.status === "in_progress";
	return {
		id: String(task.id),
		title: task.subject,
		...(task.note === undefined ? {} : { subtitle: task.note }),
		status: {
			label: inProgress ? (task.activeForm ?? "in progress") : task.status,
			spinner: inProgress,
		},
		...(task.status === "completed" ? { tone: "neutral" as const } : {}),
		...(task.blockedBy === undefined || task.blockedBy.length === 0
			? {}
			: { deps: task.blockedBy.map(String) }),
	};
}

function dataOf(tasks: readonly Task[]): TodoPanelData {
	// Tombstones are not list rows and do not count toward the total.
	const visible = tasks.filter((task) => task.status !== "deleted");
	return {
		done: visible.filter((task) => task.status === "completed").length,
		total: visible.length,
		summary: `**${visible.filter((task) => task.status === "completed").length}/${visible.length}** done`,
		items: visible.map(rowOf),
	};
}

export function createTodoPanel(deps: TodoPanelDeps): SurfaceDef<"panel"> {
	const { host, log } = deps;

	/** The rows + counts for one conversation, or `undefined` for `none`. */
	async function resolve(ctx: SurfaceContext): Promise<{
		access: "none" | "read";
		data: TodoPanelData;
	}> {
		const id = conversationIdOf(ctx.params);
		if (id === undefined) return { access: "read", data: EMPTY_DATA };
		let meta;
		try {
			meta = await host.conversations.meta(id);
		} catch {
			// Unknown conversation: the id was client-supplied, so a throw is
			// the unknown-id signal — hide the panel, never leak the error.
			return { access: "none", data: EMPTY_DATA };
		}
		const access = await host.access.accessOf(ctx.principal, meta);
		if (access === "none") return { access: "none", data: EMPTY_DATA };
		const state = await log.get(id);
		// Tasks render in state (id) order; the spec pins the panel to it.
		return { access: "read", data: dataOf(state.tasks) };
	}

	/**
	 * The panel tree, built as a PLAIN object — the same shape
	 * `~/repos/sigrun-escalations` emits. Deliberately not the host's
	 * `tree()`/`page()`/`card()` builders: those are a RUNTIME import of
	 * `@sigrun/sigrun/blocks`, which an extension installed from the npm
	 * registry cannot resolve (the host package is not a dependency of an
	 * extension — it is the host). `v` is the block-set version the
	 * server validates against (`BLOCK_SET_VERSION`, currently 1).
	 */
	function treeFor(): Tree {
		const card: Card = {
			title: { $: "./title" },
			subtitle: { $: "./subtitle" },
			status: {
				label: { $: "./status.label" },
				spinner: { $: "./status.spinner" },
			},
			tone: { $: "./tone" },
			deps: { $: "./deps" },
		};
		const main: Block[] = [
			{ type: "markdown", text: { $: "/summary" } },
			{
				type: "collection",
				id: "todos-list",
				display: "list",
				items: { $: "/items" },
				item: card,
			},
		];
		return {
			v: 1,
			root: {
				type: "page",
				title: "Todos",
				main,
				empty: { icon: "list", title: "No tasks yet", hint: "The agent keeps this list." },
			},
		};
	}

	return {
		id: "todos",
		title: "Todos",
		icon: "list",
		placement: "panel",
		perConversation: true,
		// NO instanceKey: the default canonical-JSON key of the channel's
		// params is what the webui hashes for live updates.
		async render(ctx: SurfaceContext): Promise<SurfaceRenderResult> {
			const { access, data } = await resolve(ctx);
			return {
				tree: treeFor(),
				data: data as unknown as SurfaceRenderResult["data"],
				access,
			};
		},
		async data(ctx: SurfaceContext): Promise<SurfaceDataResult> {
			const { access, data } = await resolve(ctx);
			return { data: data as unknown as SurfaceDataResult["data"], access };
		},
	};
}
