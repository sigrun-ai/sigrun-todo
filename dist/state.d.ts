import { type Static, Type } from "@earendil-works/pi-ai";
import type { Task, TaskStatus, TodoState } from "./types.js";
/**
 * Reducer outcome. Closed tagged union: a new action must extend this union AND
 * `changesState` (compiler-enforced exhaustive), so every action decides whether
 * it persists a snapshot.
 *
 * `error` carries its message in-band so callers can branch on
 * `op.kind === "error"` without a side-channel boolean.
 */
export type Op = {
    kind: "create";
    taskIds: number[];
} | {
    kind: "update";
    id: number;
    fromStatus: TaskStatus;
    toStatus: TaskStatus;
    changed: boolean;
} | {
    kind: "delete";
    id: number;
    subject: string;
} | {
    kind: "list";
    statusFilter?: TaskStatus;
} | {
    kind: "get";
    task: Task;
} | {
    kind: "clear";
    count: number;
} | {
    kind: "error";
    message: string;
};
/**
 * True when `op` changed the task state — the calls whose post-change snapshot
 * must be persisted for replay. Reads, failures and a no-effect `update` leave
 * state untouched.
 */
export declare function changesState(op: Op): boolean;
/**
 * The tool's parameter schema. Every `description` doubles as LLM-facing prompt
 * copy, so the wording is part of the tool's behaviour.
 */
export declare const TodoParamsSchema: Type.TObject<{
    action: Type.TUnsafe<"clear" | "create" | "delete" | "get" | "list" | "update">;
    subject: Type.TOptional<Type.TString>;
    description: Type.TOptional<Type.TString>;
    activeForm: Type.TOptional<Type.TString>;
    status: Type.TOptional<Type.TUnsafe<"completed" | "deleted" | "in_progress" | "pending">>;
    blockedBy: Type.TOptional<Type.TArray<Type.TNumber>>;
    addBlockedBy: Type.TOptional<Type.TArray<Type.TNumber>>;
    removeBlockedBy: Type.TOptional<Type.TArray<Type.TNumber>>;
    id: Type.TOptional<Type.TNumber>;
    note: Type.TOptional<Type.TString>;
    tasks: Type.TOptional<Type.TArray<Type.TObject<{
        subject: Type.TString;
        description: Type.TOptional<Type.TString>;
        activeForm: Type.TOptional<Type.TString>;
        blockedBy: Type.TOptional<Type.TArray<Type.TNumber>>;
    }>>>;
}>;
export type TodoParams = Static<typeof TodoParamsSchema>;
/**
 * Pure reducer: (state, params) → (state, op). Formatting belongs to the tool's
 * response envelope and persistence to the log; validation stays in-reducer so
 * every invariant is enforced before any state is written.
 */
export declare function applyTodo(state: TodoState, params: TodoParams): {
    state: TodoState;
    op: Op;
};
