/**
 * The todo extension's shared (operator) settings schema (settings
 * rework): `reminderRounds` is the whole surface. The declared checked
 * read applies the default and repairs malformed stored values to it —
 * the old inline parser's positive-integer-else-6 rule, now the schema's.
 */

import { Type, type Static } from "typebox";

/**
 * Widen a TypeBox schema to the host's structural JSON-Schema contract
 * (`SettingsJsonSchema = Readonly<Record<string, unknown>>`): TypeBox's
 * TObject carries no string index signature, but every schema it builds
 * IS a plain JSON object. The `Static` type stays on the original.
 */
function asJsonSchema<T>(schema: T): T & Readonly<Record<string, unknown>> {
	return schema as T & Readonly<Record<string, unknown>>;
}

export const TODO_SETTINGS_SCHEMA = asJsonSchema(Type.Object({
	reminderRounds: Type.Integer({
		title: "Reminder cadence",
		minimum: 1,
		default: 6,
		description: "Work rounds between mid-run reminders to account for open todo items.",
		"x-sigrun-apply": "live",
	}),
}));

export type TodoSettings = Static<typeof TODO_SETTINGS_SCHEMA>;
