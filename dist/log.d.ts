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
import { type Op } from "./state.js";
import { type TodoState } from "./types.js";
/**
 * A fork-aware, newest-first read of one conversation's transcript. The host
 * shape is {@link hostEntryReader}; tests drive arrays directly.
 */
export type EntryReader = (conversationId: ConversationId) => AsyncIterable<EntryRecord>;
/**
 * The {@link EntryReader} over a sigrun host's fork-aware transcript read,
 * paging `host.conversations.entries` newest-first until exhausted.
 */
export declare function hostEntryReader(host: Pick<SigrunHost, "conversations">): EntryReader;
/**
 * The todo list of one conversation: the newest committed `todo` snapshot in
 * its fork-aware history. Walks newest→oldest; a `pi.reset` entry ends the
 * walk (history before the reset is not this list's history); `pi.compaction`
 * and everything else is walked past. No snapshot → {@link EMPTY_STATE}.
 */
export declare function replay(read: EntryReader, conversationId: ConversationId): Promise<TodoState>;
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
export declare class TodoLog {
    #private;
    constructor(read: EntryReader);
    /** The conversation's current state, seeding from the transcript once. */
    get(id: ConversationId): Promise<TodoState>;
    /**
     * Apply `f` to the conversation's current state. Serialized with every
     * other `mutate` of this conversation: after the seed resolves, the
     * read-apply-write below contains no `await`, so it is atomic.
     */
    mutate(id: ConversationId, f: (state: TodoState) => {
        state: TodoState;
        op: Op;
    }): Promise<{
        state: TodoState;
        op: Op;
    }>;
    /**
     * End the conversation's round: a dirty entry is dropped (return `true`)
     * so the next `get` re-reads the transcript — the committed snapshot, or
     * the state without an aborted call's uncommitted change. Clean → `false`.
     */
    settle(id: ConversationId): boolean;
    /** Drop the conversation's cache entry; the next `get` re-seeds. */
    forget(id: ConversationId): void;
}
