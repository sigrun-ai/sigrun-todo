/**
 * Shared test harness: opens a REAL pi-durable Harness (registry + faux
 * provider) with a MINIMAL extension installing a `todo` tool built from
 * Task 4's `applyTodo` — every state-changing call returns the post-change
 * snapshot as its result `details`, exactly the transcript shape `replay`
 * reads. Task 6 replaces this with the real tool; here it exists only to
 * produce real `pi.tool-result` entries over a real run.
 *
 * Pattern: sigrun-ext-tool-search's test/harness.ts, minus its MCP wiring
 * (no `@sigrun/ext-mcp` / `@sigrun/shared` dependency here).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	type ConversationId,
	type Cursor,
	type EntryQuery,
	type ModelRef,
	type Page,
	type EntryRecord,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { SigrunHost } from "@sigrun/sigrun/extension";
import { applyTodo, TodoParamsSchema, type TodoParams } from "../src/state.js";
import type { JsonValue } from "@earendil-works/chord";
import type { TodoSnapshot } from "../src/types.js";
import { TodoLog, hostEntryReader, type EntryReader } from "../src/log.js";

/** The minimal extension: a `todo` tool over a `TodoLog`, nothing else. */
function createTestExtension(log: TodoLog) {
	return defineExtension({
		name: "todo",
		tools: [
			defineTool({
				name: "todo",
				description: "Manage the task list (test tool: state changes only).",
				parameters: TodoParamsSchema,
				execute: async (args: TodoParams, api) => {
					const { state, op } = await log.mutate(api.conversationId, (current) =>
						applyTodo(current, args),
					);
					const details = { ...state, action: args.action } satisfies TodoSnapshot;
					// `TodoSnapshot` is an interface (no index signature), so it is not
					// structurally a `JsonValue`; the fields are all JSON, so the cast
					// is only to satisfy the tool-result typing.
					const json = details as unknown as JsonValue;
					if (op.kind === "error") {
						return {
							output: [{ type: "text" as const, text: op.message }],
							isError: true,
							details: json,
						};
					}
					return { output: [{ type: "text" as const, text: "ok" }], details: json };
				},
			}),
		],
	});
}

export interface OpenedHarness {
	readonly harness: Harness;
	readonly defaultModel: ModelRef;
	readonly registry: ReturnType<typeof createRegistry>;
	/** The {@link EntryReader} over this harness's fork-aware transcripts. */
	readonly read: EntryReader;
	/** The cache the installed `todo` tool mutates. */
	readonly log: TodoLog;
}

/**
 * Open a real pi-durable harness with the minimal todo extension installed.
 * `responses` script the faux provider, two messages per tool round.
 */
export async function openTodoHarness(
	dir: string,
	responses: Parameters<
		ReturnType<typeof fauxProvider>["setResponses"]
	>[0] = [fauxAssistantMessage("no tools needed")],
): Promise<OpenedHarness> {
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const defaultModel: ModelRef = { provider: "faux", modelId: "m" };

	// The host-shaped read: the harness's own fork-aware entries scan,
	// narrowed to `Pick<SigrunHost, "conversations">` so the same
	// `hostEntryReader` serves tests and production.
	const host: Pick<SigrunHost, "conversations"> = {
		conversations: {
			entries: async (
				id: ConversationId,
				query: Omit<EntryQuery, "conversationId">,
				limit: number,
				cursor?: Cursor,
			): Promise<Page<EntryRecord, Cursor>> => {
				const conversation = await harness.conversation(id, BACKGROUND_CONTEXT);
				if (conversation === undefined) throw new Error(`unknown conversation ${id}`);
				return conversation.entries(query, limit, cursor, BACKGROUND_CONTEXT);
			},
		},
	} as Pick<SigrunHost, "conversations">;
	const read = hostEntryReader(host);
	const log = new TodoLog(read);

	const registry = createRegistry();
	registry.install(createTestExtension(log));

	const harness = await Harness.open(
		await openNodeSqliteStorage(join(dir, "sigrun.db")),
		{ models, registry },
		BACKGROUND_CONTEXT,
	);
	harness.resume();

	return { harness, defaultModel, registry, read, log };
}

/** Fresh temp dir; the test body receives it and must clean up. */
export async function tempDir(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

export async function cleanupDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}

/** Close an opened harness; safe in test finally blocks. */
export async function closeOpened(opened: OpenedHarness): Promise<void> {
	await opened.harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
}
