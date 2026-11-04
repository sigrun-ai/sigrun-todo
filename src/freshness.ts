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

import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { Task, TodoState } from "./types.js";

/** The check's first token. It doubles as the "this is not a human turn" signal. */
export const TODO_CHECK_MARKER = "[todo check]";

/** The tool whose calls mark a round as a "touch" of the list. */
const TODO_TOOL = "todo";

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
export function openItems(state: TodoState): Task[] {
	return state.tasks
		.filter((task) => task.status === "pending" || task.status === "in_progress")
		.sort((left, right) => left.id - right.id);
}

/** Index of the last `user` message, or `-1` when the run has no human turn. */
function lastUserIndex(messages: readonly Message[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "user") return index;
	}
	return -1;
}

/** The first text part of a human turn; `undefined` for an image-only turn. */
function firstText(content: UserMessage["content"]): string | undefined {
	if (typeof content === "string") return content;
	for (const part of content) {
		if (part.type === "text") return part.text;
	}
	return undefined;
}

/** A round is work: an assistant message that called at least one tool. */
function isRound(message: Message): message is AssistantMessage {
	return message.role === "assistant" && message.content.some((block) => block.type === "toolCall");
}

/** Whether this round called `todo` — a read counts: it is the agent touching the list. */
function touchesList(message: AssistantMessage): boolean {
	return message.content.some((block) => block.type === "toolCall" && block.name === TODO_TOOL);
}

/** Whether the request's current tool set includes `todo`. */
function isOffered(messages: readonly Message[]): boolean {
	return getCurrentTools(messages).some((tool) => tool.name === TODO_TOOL);
}

/**
 * Read the request's messages into a {@link RunView}.
 *
 * The run starts after the last `user` message; with no user message at all the
 * whole array is the run, which is what a multi-turn transcript with the input
 * outside the list looks like.
 */
export function analyze(messages: readonly Message[]): RunView {
	const userIndex = lastUserIndex(messages);
	const userMessage = userIndex === -1 ? undefined : messages[userIndex];
	const lastUserIsCheck =
		userMessage?.role === "user" &&
		(firstText(userMessage.content)?.startsWith(TODO_CHECK_MARKER) ?? false);

	let rounds = 0;
	let lastTouch = -1;
	for (const message of messages.slice(userIndex + 1)) {
		if (!isRound(message)) continue;
		if (touchesList(message)) lastTouch = rounds;
		rounds += 1;
	}

	return {
		offered: isOffered(messages),
		roundsSinceTouch: rounds - (lastTouch + 1),
		lastUserIsCheck,
	};
}

/**
 * Whether to ask, at the end of a run, that each open item be resolved. Skipped
 * for the check's own continuation, or the check would answer itself forever.
 */
export function shouldCheck(view: RunView, state: TodoState): boolean {
	return (
		view.offered &&
		openItems(state).length > 0 &&
		!view.lastUserIsCheck &&
		view.roundsSinceTouch > 0
	);
}

/** Whether the mid-run cadence wants its every-`k`-rounds reminder. */
export function shouldRemind(view: RunView, state: TodoState, k: number): boolean {
	return (
		view.offered &&
		openItems(state).length > 0 &&
		view.roundsSinceTouch > 0 &&
		view.roundsSinceTouch % k === 0
	);
}

/** `#2 Write tests (in_progress)` — the raw status token, not prose. */
function itemLine(task: Task): string {
	return `#${task.id} ${task.subject} (${task.status})`;
}

/**
 * The end-of-run check, appended as an entry. It names its author because a
 * model that reads it as a human request would answer the human instead of the
 * list; and it spells out all three honest answers, because a check offering
 * only "completed" pushes a model to close what is not done.
 */
export function checkText(open: readonly Task[]): string {
	const items = open.map((task) => `- ${itemLine(task)}`).join("\n");
	return [
		`${TODO_CHECK_MARKER} This is an automated check from the \`todo\` extension, not a message from the user.`,
		"",
		"These items are still open:",
		items,
		"",
		"Make one `todo` call per item: mark it completed, delete it with a note if it no longer applies, or update it with a note saying why it stays open.",
	].join("\n");
}

/**
 * The mid-run reminder: the count and the items, short enough to leave room for
 * the work it interrupts. Reminders only fire with open items, so the list is
 * never empty here.
 */
export function reminderText(state: TodoState): string {
	const open = openItems(state);
	const count = open.length === 1 ? "1 open item is" : `${open.length} open items are`;
	const paragraph = `Reminder from the \`todo\` extension: ${count} still on the list. Keep it current as you work.`;
	return [paragraph, "", ...open.map((task) => `- ${itemLine(task)}`)].join("\n");
}
