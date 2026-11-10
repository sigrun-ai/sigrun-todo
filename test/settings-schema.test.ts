/**
 * The todo extension's declared settings (settings rework): one shared
 * (operator) key, `reminderRounds`. The schema is the single source of the
 * old inline parser's contract — a positive integer is honoured, anything
 * else falls back to the default of 6 — and the factory reads through the
 * declared handle instead of `host.stores.settings.get()`.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { assertDrawable, checkStoredSettings } from "@sigrun/sigrun/settings-schema";
import type { SettingsDeclaration, SigrunHost } from "@sigrun/sigrun/extension";

import createTodo from "../src/index.js";
import { TODO_SETTINGS_SCHEMA, type TodoSettings } from "../src/settings-schema.js";

interface DeclaredHost {
	declaration: SettingsDeclaration | undefined;
	declared: { get(): Promise<TodoSettings> } | undefined;
	settingsFile: string;
}

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function declaredHost(): Promise<DeclaredHost> {
	const root = await mkdtemp(join(tmpdir(), "todo-settings-"));
	dirs.push(root);
	const settingsFile = join(root, "sigrun-todo.json");
	await mkdir(root, { recursive: true });
	const state = {
		declaration: undefined,
		declared: undefined,
		settingsFile,
	} as DeclaredHost;
	const read = async (): Promise<Record<string, unknown>> => {
		try {
			return JSON.parse(await readFile(settingsFile, "utf8"));
		} catch {
			return {};
		}
	};
	const host = {
		settings: {
			declare: <S, U>(declaration: SettingsDeclaration) => {
				state.declaration = declaration;
				const declared = {
					get: async () => checkStoredSettings(declaration.schema, await read()).value as S,
				};
				state.declared = declared as unknown as DeclaredHost["declared"];
				return declared as unknown as ReturnType<SigrunHost["settings"]["declare"]> & {
					get(): Promise<S>;
					user(user: string): { get(): Promise<U> };
				};
			},
		},
		stores: {
			settings: { get: read },
		},
	} as unknown as SigrunHost;
	createTodo(host);
	return state;
}

describe("todo settings schema", () => {
	test("schema is drawable", () => {
		assertDrawable(TODO_SETTINGS_SCHEMA);
	});

	test("defaults match the old parser", async () => {
		// The old inline parser: a positive integer is honoured, everything
		// else (absent, string, zero, negative, non-integer) is 6.
		expect(checkStoredSettings(TODO_SETTINGS_SCHEMA, {}).value).toEqual({ reminderRounds: 6 });
		const host = await declaredHost();
		expect(await host.declared!.get()).toEqual({ reminderRounds: 6 });
	});

	test("an old settings file still loads", async () => {
		const host = await declaredHost();
		await writeFile(host.settingsFile, JSON.stringify({ reminderRounds: 3 }));
		expect(await host.declared!.get()).toEqual({ reminderRounds: 3 });
	});

	test("a malformed stored value falls back to the default (the old leniency)", async () => {
		const host = await declaredHost();
		for (const value of ["x", 0, -2, 1.5]) {
			await writeFile(host.settingsFile, JSON.stringify({ reminderRounds: value }));
			expect(await host.declared!.get()).toEqual({ reminderRounds: 6 });
		}
	});

	test("the factory declares the shared schema and no user schema", async () => {
		const host = await declaredHost();
		expect(host.declaration).toEqual({ schema: TODO_SETTINGS_SCHEMA });
	});
});
