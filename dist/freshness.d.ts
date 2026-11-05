/**
 * Freshness analysis: a pure decision table over the request's message array.
 * No I/O, no state — Task 8's hooks call it with `request.messages` and act on
 * the answer.
 *
 * Two knobs, two different jobs:
 *
 * - {@link shouldCheck} — the end-of-turn check. The agent is finishing a run
 *   it wrote nothing to the list in; asking once is the honest nudge.
 * - {@link shouldRemind} — the mid-run cadence, every `k` work rounds, so a
 *   long run does not drift away from the list silently.
 *
 * The rules are shaped around the spec's anti-goal: never nag a model into
 * fabricating progress. So the unit is a ROUND (an assistant message that
 * called a tool — prose is not work), a run ends at the last human turn (a new
 * human message is a new intention), and {@link checkText} always offers the
 * third answer: keep the item open and say why.
 */
import type { Message } from "@earendil-works/pi-ai";
import type { Task, TodoState } from "./types.js";
/** The check's first token. It doubles as the "this is not a human turn" signal. */
export declare const TODO_CHECK_MARKER = "[todo check]";
/**
 * What the current request's transcript says about freshness:
 *
 * - `offered` — the tool set this request leaves in force contains `todo`.
 *   A turn without the tool cannot be nagged: it has no way to answer.
 * - `roundsSinceTouch` — work rounds since the later of the run start and the
 *   last round that called `todo`. A `todo` call in the last round is `0`.
 * - `lastUserIsCheck` — the run is a continuation of our own check, so it must
 *   not trigger the next one.
 */
export interface RunView {
    offered: boolean;
    roundsSinceTouch: number;
    lastUserIsCheck: boolean;
}
/** Every item that still needs work, in id order. Deleted tombstones stay out. */
export declare function openItems(state: TodoState): Task[];
/**
 * Read the request's messages into a {@link RunView}.
 *
 * The run starts after the last `user` message; with no user message at all the
 * whole array is the run, which is what a multi-turn transcript with the input
 * outside the list looks like.
 */
export declare function analyze(messages: readonly Message[]): RunView;
/**
 * Whether to ask, at the end of a run, that each open item be resolved. Skipped
 * for the check's own continuation, or the check would answer itself forever.
 */
export declare function shouldCheck(view: RunView, state: TodoState): boolean;
/** Whether the mid-run cadence wants its every-`k`-rounds reminder. */
export declare function shouldRemind(view: RunView, state: TodoState, k: number): boolean;
/**
 * The end-of-run check, appended as an entry. It names its author because a
 * model that reads it as a human request would answer the human instead of the
 * list; and it spells out all three honest answers, because a check offering
 * only "completed" pushes a model to close what is not done.
 */
export declare function checkText(open: readonly Task[]): string;
/**
 * The mid-run reminder: the count and the items, short enough to leave room for
 * the work it interrupts. Reminders only fire with open items, so the list is
 * never empty here.
 */
export declare function reminderText(state: TodoState): string;
