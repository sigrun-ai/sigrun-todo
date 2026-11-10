/**
 * The todo extension's shared (operator) settings schema (settings
 * rework): `reminderRounds` is the whole surface. The declared checked
 * read applies the default and repairs malformed stored values to it —
 * the old inline parser's positive-integer-else-6 rule, now the schema's.
 */
import { Type, type Static } from "typebox";
export declare const TODO_SETTINGS_SCHEMA: Type.TObject<{
    reminderRounds: Type.TInteger;
}> & Readonly<Record<string, unknown>>;
export type TodoSettings = Static<typeof TODO_SETTINGS_SCHEMA>;
