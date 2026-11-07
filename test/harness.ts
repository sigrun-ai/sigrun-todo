/**
 * Shared test harness: opens a REAL pi-durable Harness (registry + faux
 * provider) with the extension's real `todo` tool over a {@link TodoLog} —
 * every call goes through the production result envelope, and every
 * state-changing call leaves the post-change snapshot in the transcript,
 * exactly the shape `replay` reads.
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
import { Type } from "typebox";
import {
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	type ConversationId,
	type Cursor,
	type EntryQuery,
	type HookRegistration,
	type ModelRef,
	type Page,
	type EntryRecord,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { SigrunHost } from "@sigrun/sigrun/extension";
import { TodoLog, hostEntryReader, type EntryReader } from "../src/log.js";
import { createTodoTool } from "../src/tool.js";

/** A trivial work tool: marks a round as work without touching the list. */
export const noopTool: ToolRegistration = defineTool({
	name: "noop",
	description: "Do nothing; a unit of work for scripted rounds.",
	parameters: Type.Object({}),
	async execute() {
		return { output: [{ type: "text", text: "done" }] };
	},
});

/** The extension under test: the real `todo` tool over a harness-owned log. */
function createTestExtension(
	log: TodoLog,
	options?: {
		hooks?: HookRegistration[];
		tools?: ToolRegistration[];
	},
) {
	return defineExtension({
		name: "todo",
		tools: [
			createTodoTool({
				log,
				// No panel in these tests: `onChanged` is the panel's cue, so
				// persistence is proven by replaying the transcript instead.
				onChanged: () => undefined,
			}),
			...(options?.tools ?? []),
		],
		hooks: options?.hooks,
	});
}

export interface OpenedHarness {
	readonly harness: Harness;
	readonly defaultModel: ModelRef;
	readonly registry: ReturnType<typeof createRegistry>;
	/** The faux provider: `appendResponses` re-scripts mid-test. */
	readonly faux: ReturnType<typeof fauxProvider>;
	/** The {@link EntryReader} over this harness's fork-aware transcripts. */
	readonly read: EntryReader;
	/** The cache the installed `todo` tool mutates (the round's live state). */
	readonly log: TodoLog;
}

/**
 * Open a real pi-durable harness with the real `todo` tool installed.
 * `responses` script the faux provider, two messages per tool round.
 */
export async function openTodoHarness(
	dir: string,
	responses: Parameters<
		ReturnType<typeof fauxProvider>["setResponses"]
	>[0] = [fauxAssistantMessage("no tools needed")],
	options?: {
		hooks?: HookRegistration[];
		tools?: ToolRegistration[];
	},
): Promise<OpenedHarness> {
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const defaultModel: ModelRef = { provider: "faux", modelId: "m" };

	const registry = createRegistry();
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(dir, "sigrun.db")),
		{ models, registry },
		BACKGROUND_CONTEXT,
	);
	harness.resume();

	// The host-shaped read: the harness's own fork-aware entries scan,
	// narrowed to `Pick<SigrunHost, "conversations">` so the same
	// `hostEntryReader` serves tests and production.
	const host = {
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
	registry.install(createTestExtension(log, options));

	return { harness, defaultModel, registry, faux, read, log };
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
