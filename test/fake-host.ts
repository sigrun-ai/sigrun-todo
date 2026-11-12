import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { SettingsDeclaration, SigrunHost } from "@sigrun/sigrun/extension";
import { checkStoredSettings } from "@sigrun/sigrun/settings-schema";
import type { SessionMeta } from "@sigrun/shared/session-meta";

export interface FakeCall {
	readonly method: string;
	readonly args: readonly unknown[];
}

export interface FakeHostOptions {
	/** The value `stores.settings.get()` returns (the todo settings object). */
	readonly settings?: Record<string, unknown>;
	/** The access verdict `access.accessOf` returns; default `"read"`. */
	readonly access?: "none" | "read" | "write";
	/** Conversation ids whose meta lookup THROWS (the unknown-id path). */
	readonly unknownConversations?: readonly number[];
}

export interface FakeHost extends SigrunHost {
	readonly calls: readonly FakeCall[];
	setMeta(conversationId: ConversationId, meta: SessionMeta): void;
	cleanup(): Promise<void>;
}

/**
 * An in-memory host for the todo extension's unit tests. Store paths point
 * at a real temp directory; the host members the extension uses are
 * functional (`conversations.meta`, `conversations.entries`,
 * `access.accessOf`, `surfaces.changed`, `stores.settings`) and every other
 * member throws explicitly rather than hiding an accidental dependency.
 */
export async function createFakeHost(opts: FakeHostOptions = {}): Promise<FakeHost> {
	const root = await mkdtemp(join(tmpdir(), "sigrun-todo-fake-host-"));
	const calls: FakeCall[] = [];
	const record = (method: string, ...args: readonly unknown[]): void => {
		calls.push({ method, args });
	};
	const notUsed = (): (() => never) => {
		return () => {
			throw new Error("not used in todo tests");
		};
	};

	const metas = new Map<ConversationId, SessionMeta>();
	const unknown = new Set(opts.unknownConversations ?? []);

	const emptyMeta = (): SessionMeta => ({
		pinned: false,
		tagged: [],
		archived: false,
		draft: { text: "", attachments: [] },
		source: "test",
	});

	const conversations: SigrunHost["conversations"] = {
		meta: async (id) => {
			record("conversations.meta", id);
			if (unknown.has(id)) throw new Error(`unknown conversation ${id}`);
			return metas.get(id) ?? emptyMeta();
		},
		entries: async (id, query, limit, cursor) => {
			record("conversations.entries", id, query, limit, cursor);
			// Recording stub: replay tests drive their own EntryReader arrays.
			return { items: [] };
		},
		create: notUsed(),
		submit: notUsed(),
		entry: notUsed(),
		watch: notUsed(),
		list: notUsed(),
		abort: notUsed(),
		configure: notUsed(),
		compact: notUsed(),
		fork: notUsed(),
		patchMeta: notUsed(),
		upload: notUsed(),
		readFile: notUsed(),
	};

	const host: SigrunHost = {
		embeddings: { embed: notUsed(), list: notUsed() },
		settings: {
			declare: <S, U>(declaration: SettingsDeclaration) => ({
				get: async () => checkStoredSettings(declaration.schema, opts.settings ?? {}).value as S,
				user: notUsed() as (user: string) => { get(): Promise<U> },
			}),
		},
		stores: {
			user: (user) => ({
				secrets: { get: notUsed(), set: notUsed(), delete: notUsed() },
				settings: { get: notUsed(), set: notUsed() },
				paths: {
					data: join(root, "data", "users", user),
					state: join(root, "state", "users", user),
					cache: join(root, "cache", "users", user),
				},
			}),
			secrets: { get: notUsed(), set: notUsed(), delete: notUsed() },
			settings: {
				get: async () => {
					record("stores.settings.get");
					return opts.settings ?? {};
				},
				set: notUsed(),
			},
			paths: {
				data: join(root, "data"),
				state: join(root, "state"),
				cache: join(root, "cache"),
			},
		},
		tools: { setUserTools: notUsed() },
		services: { connect: notUsed() },
		seedInteraction: notUsed(),
		answerInteraction: notUsed(),
		declineInteraction: notUsed(),
		settleInteraction: notUsed(),
		peekInteraction: notUsed(),
		snapshotInteraction: notUsed(),
		setAmbient: notUsed(),
		clearAmbient: notUsed(),
		conversations,
		jobs: {
			get: notUsed(),
			activeRun: notUsed(),
			isJobRun: notUsed(),
		},
		notify: notUsed(),
		notices: { post: notUsed(), clear: notUsed(), list: notUsed() },
		users: { list: notUsed(), get: notUsed() },
		accounts: {
			lookup: notUsed(),
			link: notUsed(),
			unlink: notUsed(),
			listForUser: notUsed(),
		},
		access: {
			accessOf: async (principal, resource) => {
				record("access.accessOf", principal, resource);
				return opts.access ?? "read";
			},
		},
		identity: { actingUser: notUsed() },
		surfaces: {
			changed: (id, key, update) => {
				record("surfaces.changed", id, key, update);
			},
		},
		models: { list: notUsed(), isLocal: notUsed(), complete: notUsed() },
		decisions: { evaluate: notUsed(), list: notUsed() },
		publishedHooks: { get: notUsed(), call: notUsed() },
		commands: { list: notUsed(), run: notUsed() },
		curation: new Proxy({} as SigrunHost["curation"], {
			get: () => {
				throw new Error("not used in todo tests");
			},
		}),
	};

	return {
		...host,
		calls,
		setMeta: (id, meta) => {
			metas.set(id, meta);
		},
		cleanup: async () => {
			await rm(root, { recursive: true, force: true });
		},
	};
}
