/**
 * Transcript replay + per-conversation cache for `@sigrun/todo`.
 *
 * The transcript is the source of truth: every state-changing `todo` call
 * returns the full post-change snapshot in its tool-result `details`, so the
 * newest such snapshot in the fork-aware history IS the list. {@link replay}
 * reads that snapshot; {@link TodoLog} caches it per conversation so a tool
 * round does not re-scan the history between its own calls.
 *
 * The cache deliberately runs ahead of the transcript between a `todo` call
 * and the round settling: an aborted call's change is uncommitted, and
 * {@link TodoLog.settle} (called when the round ends) forgets the dirty
 * entry so the next {@link TodoLog.get} re-reads the transcript without it.
 */

import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import type { SigrunHost } from "@sigrun/sigrun/extension";
import { changesState, type Op } from "./state.js";
import { EMPTY_STATE, type TodoState } from "./types.js";

/**
 * A fork-aware, newest-first read of one conversation's transcript. The host
 * shape is {@link hostEntryReader}; tests drive arrays directly.
 */
export type EntryReader = (conversationId: ConversationId) => AsyncIterable<EntryRecord>;

/** Page size for the host scan. */
const PAGE_SIZE = 100;

/**
 * The {@link EntryReader} over a sigrun host's fork-aware transcript read,
 * paging `host.conversations.entries` newest-first until exhausted.
 */
export function hostEntryReader(host: Pick<SigrunHost, "conversations">): EntryReader {
	return async function* (conversationId: ConversationId): AsyncIterable<EntryRecord> {
		let cursor: Parameters<SigrunHost["conversations"]["entries"]>[3];
		for (;;) {
			const page = await host.conversations.entries(
				conversationId,
				{ order: "descending" },
				PAGE_SIZE,
				cursor,
			);
			for (const entry of page.items) yield entry;
			if (page.next === undefined) return;
			cursor = page.next;
		}
	};
}

/**
 * The snapshot carried in one tool-result entry's `details`, or `undefined`
 * when the entry is not a usable todo snapshot (wrong kind, wrong tool,
 * error result, malformed details).
 */
function snapshotOf(entry: EntryRecord): TodoState | undefined {
	if (entry.kind !== "pi.tool-result") return undefined;
	const message = entry.model?.[0] as
		| { role?: string; toolName?: string; isError?: boolean; details?: unknown }
		| undefined;
	if (message?.role !== "toolResult" || message.toolName !== "todo" || message.isError !== false) {
		return undefined;
	}
	const details = message.details as Partial<TodoState> | undefined;
	if (
		details === undefined ||
		typeof details !== "object" ||
		!Array.isArray(details.tasks) ||
		typeof details.nextId !== "number"
	) {
		return undefined;
	}
	return { tasks: details.tasks, nextId: details.nextId };
}

/**
 * The todo list of one conversation: the newest committed `todo` snapshot in
 * its fork-aware history. Walks newest→oldest; a `pi.reset` entry ends the
 * walk (history before the reset is not this list's history); `pi.compaction`
 * and everything else is walked past. No snapshot → {@link EMPTY_STATE}.
 */
export async function replay(read: EntryReader, conversationId: ConversationId): Promise<TodoState> {
	for await (const entry of read(conversationId)) {
		if (entry.kind === "pi.reset") return EMPTY_STATE;
		const snapshot = snapshotOf(entry);
		if (snapshot !== undefined) return snapshot;
	}
	return EMPTY_STATE;
}

/**
 * The per-conversation todo cache in front of the transcript.
 *
 * `get` seeds the cache from the transcript once per conversation;
 * concurrent callers share ONE seeding promise (the transcript is scanned
 * once no matter how many of a round's tool calls race). `mutate` awaits
 * that seed, then reads-applies-writes synchronously — the NO-`await`
 * window between the read and the write is what serializes parallel calls:
 * no two mutations can observe the same state. A mutation whose op changes
 * state ({@link changesState}) marks the entry dirty.
 *
 * `settle` ends a round: a dirty entry is dropped (the transcript either
 * holds its snapshot by then or the call was aborted, in which case the
 * uncommitted change must disappear) and reports `true`; a clean entry is
 * kept and reports `false`. `forget` drops the entry unconditionally.
 */
export class TodoLog {
	readonly #read: EntryReader;
	readonly #cache = new Map<ConversationId, { state: TodoState; dirty: boolean }>();
	readonly #seeding = new Map<ConversationId, Promise<TodoState>>();

	constructor(read: EntryReader) {
		this.#read = read;
	}

	/** The conversation's current state, seeding from the transcript once. */
	async get(id: ConversationId): Promise<TodoState> {
		const cached = this.#cache.get(id);
		if (cached !== undefined) return cached.state;
		return await this.#seed(id);
	}

	/**
	 * Apply `f` to the conversation's current state. Serialized with every
	 * other `mutate` of this conversation: after the seed resolves, the
	 * read-apply-write below contains no `await`, so it is atomic.
	 */
	async mutate(
		id: ConversationId,
		f: (state: TodoState) => { state: TodoState; op: Op },
	): Promise<{ state: TodoState; op: Op }> {
		await this.#seed(id);
		// No await from here to the write — this IS the serializer.
		const current = this.#cache.get(id) ?? { state: EMPTY_STATE, dirty: false };
		const { state, op } = f(current.state);
		this.#cache.set(id, { state, dirty: current.dirty || changesState(op) });
		return { state, op };
	}

	/**
	 * End the conversation's round: a dirty entry is dropped (return `true`)
	 * so the next `get` re-reads the transcript — the committed snapshot, or
	 * the state without an aborted call's uncommitted change. Clean → `false`.
	 */
	settle(id: ConversationId): boolean {
		const cached = this.#cache.get(id);
		if (cached?.dirty !== true) return false;
		this.#cache.delete(id);
		return true;
	}

	/** Drop the conversation's cache entry; the next `get` re-seeds. */
	forget(id: ConversationId): void {
		this.#cache.delete(id);
	}

	/** Seed the cache from the transcript once per id, sharing one promise. */
	#seed(id: ConversationId): Promise<TodoState> {
		const cached = this.#cache.get(id);
		if (cached !== undefined) return Promise.resolve(cached.state);
		let seeding = this.#seeding.get(id);
		if (seeding === undefined) {
			seeding = replay(this.#read, id).then(
				(state) => {
					this.#cache.set(id, { state, dirty: false });
					this.#seeding.delete(id);
					return state;
				},
				(error) => {
					// A rejected seed must NOT be cached: it stays retried by the
					// next `get`, not pinned for the process lifetime.
					this.#seeding.delete(id);
					throw error;
				},
			);
			this.#seeding.set(id, seeding);
		}
		return seeding;
	}
}
