import { Type } from "typebox";
import { detectCycle } from "./graph.js";
/**
 * Flat `{type:"string",enum:[...]}` — the provider-compatible string-enum wire
 * shape pi-ai's StringEnum emitted (Google's API rejects anyOf/const unions).
 * Vendored for pi-durable 1.5.0, where pi-ai no longer re-exports schema
 * helpers and extensions never runtime-import host packages.
 */
function stringEnum(values, options) {
    return Type.Unsafe({
        ...(options?.description ? { description: options.description } : {}),
        ...(options?.default !== undefined ? { default: options.default } : {}),
        type: "string",
        enum: [...values],
    });
}
/**
 * True when `op` changed the task state — the calls whose post-change snapshot
 * must be persisted for replay. Reads, failures and a no-effect `update` leave
 * state untouched.
 */
export function changesState(op) {
    switch (op.kind) {
        case "create":
        case "delete":
        case "clear":
            return true;
        case "update":
            return op.changed;
        case "list":
        case "get":
        case "error":
            return false;
    }
}
/**
 * Allowed forward transitions per source status. `completed` is one-way to
 * `deleted` (never back to `in_progress`); `deleted` is terminal. Idempotent
 * same→same is allowed separately, so this table only enumerates transitions.
 */
const VALID_TRANSITIONS = {
    pending: new Set(["in_progress", "completed", "deleted"]),
    in_progress: new Set(["pending", "completed", "deleted"]),
    completed: new Set(["deleted"]),
    deleted: new Set(),
};
function isTransitionValid(from, to) {
    return from === to || VALID_TRANSITIONS[from].has(to);
}
const CreateTaskItemSchema = Type.Object({
    subject: Type.String({ description: "Task subject line" }),
    description: Type.Optional(Type.String({ description: "Long-form task description" })),
    activeForm: Type.Optional(Type.String({
        description: "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')",
    })),
    blockedBy: Type.Optional(Type.Array(Type.Number(), {
        description: "Existing task ids this item waits on. Cannot name another item in this same batch; create the prerequisite first, then the dependent with blockedBy.",
    })),
});
/**
 * The tool's parameter schema. Every `description` doubles as LLM-facing prompt
 * copy, so the wording is part of the tool's behaviour.
 */
export const TodoParamsSchema = Type.Object({
    action: stringEnum(["create", "update", "list", "get", "delete", "clear"]),
    subject: Type.Optional(Type.String({ description: "Task subject line (required for create unless tasks[] is set)" })),
    description: Type.Optional(Type.String({ description: "Long-form task description" })),
    activeForm: Type.Optional(Type.String({
        description: "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')",
    })),
    status: Type.Optional(stringEnum(["pending", "in_progress", "completed", "deleted"], {
        description: "Set this task's status (update): one of pending, in_progress, completed, deleted. When action is list, filters returned tasks by this status.",
    })),
    blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Initial blockedBy ids (create only)" })),
    addBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Task ids to add to blockedBy (update only, additive merge)" })),
    removeBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Task ids to remove from blockedBy (update only)" })),
    id: Type.Optional(Type.Number({ description: "Task id (required for update, get, delete)" })),
    note: Type.Optional(Type.String({
        description: "Short note stored on the task (update, delete): why it was dropped, or why it stays open",
    })),
    tasks: Type.Optional(Type.Array(CreateTaskItemSchema, {
        description: "Batch create: independent tasks in one call, one-of with subject. The whole list is validated then committed together. Items cannot blockedBy each other; create the prerequisite first, then the dependent with blockedBy.",
    })),
});
/** Per-item create fields: on a batch they belong to each `tasks[]` item. */
const BATCH_ITEM_FIELDS = ["description", "activeForm", "blockedBy"];
function errorResult(state, message) {
    return { state, op: { kind: "error", message } };
}
function buildCreatedTask(id, spec, subject) {
    const task = { id, subject, status: "pending" };
    if (spec.description)
        task.description = spec.description;
    if (spec.activeForm)
        task.activeForm = spec.activeForm;
    if (spec.blockedBy?.length)
        task.blockedBy = [...spec.blockedBy];
    return task;
}
function validateCreateBlockedBy(state, blockedBy, siblingIds) {
    if (!blockedBy?.length)
        return undefined;
    for (const dep of blockedBy) {
        if (siblingIds.has(dep)) {
            return `blockedBy: #${dep} is another item in this batch; create the prerequisite first, then the dependent with blockedBy`;
        }
        const depTask = state.tasks.find((task) => task.id === dep);
        if (!depTask)
            return `blockedBy: #${dep} not found`;
        if (depTask.status === "deleted")
            return `blockedBy: #${dep} is deleted`;
    }
    return undefined;
}
function sameNumberList(a, b) {
    const x = a ?? [];
    const y = b ?? [];
    return x.length === y.length && x.every((value, index) => value === y[index]);
}
/**
 * Did this `update` change anything? A no-effect update — `status` set to its
 * current value, or a field re-sent unchanged — reports false so the caller can
 * say "no change" instead of "updated", which otherwise drives a model to
 * re-issue the same call in a loop.
 *
 * blockedBy is order-sensitive (the reducer preserves insertion order).
 */
function taskChanged(before, after) {
    return (before.subject !== after.subject ||
        before.status !== after.status ||
        before.description !== after.description ||
        before.activeForm !== after.activeForm ||
        before.note !== after.note ||
        !sameNumberList(before.blockedBy, after.blockedBy));
}
/**
 * Pure reducer: (state, params) → (state, op). Formatting belongs to the tool's
 * response envelope and persistence to the log; validation stays in-reducer so
 * every invariant is enforced before any state is written.
 */
export function applyTodo(state, params) {
    switch (params.action) {
        case "create": {
            const batch = params.tasks;
            if (Array.isArray(batch) && params.subject !== undefined) {
                return errorResult(state, "create requires subject or tasks[], not both");
            }
            if (Array.isArray(batch)) {
                const topLevel = BATCH_ITEM_FIELDS.filter((field) => params[field] !== undefined);
                if (topLevel.length) {
                    return errorResult(state, `create with tasks[] takes ${topLevel.join(", ")} on each item, not at the top level`);
                }
                if (batch.length === 0)
                    return errorResult(state, "tasks[] must be non-empty");
                for (const [index, item] of batch.entries()) {
                    if (!item.subject.trim())
                        return errorResult(state, `tasks[${index}]: subject required for create`);
                }
                const siblingIds = new Set(batch.map((_, index) => state.nextId + index));
                for (const item of batch) {
                    const blockedError = validateCreateBlockedBy(state, item.blockedBy, siblingIds);
                    if (blockedError)
                        return errorResult(state, blockedError);
                }
                const created = batch.map((item, index) => buildCreatedTask(state.nextId + index, item, item.subject));
                return {
                    state: { tasks: [...state.tasks, ...created], nextId: state.nextId + created.length },
                    op: { kind: "create", taskIds: created.map((task) => task.id) },
                };
            }
            if (!params.subject?.trim())
                return errorResult(state, "subject required for create");
            const blockedError = validateCreateBlockedBy(state, params.blockedBy, new Set());
            if (blockedError)
                return errorResult(state, blockedError);
            const newTask = buildCreatedTask(state.nextId, params, params.subject);
            return {
                state: { tasks: [...state.tasks, newTask], nextId: state.nextId + 1 },
                op: { kind: "create", taskIds: [newTask.id] },
            };
        }
        case "update": {
            if (params.id === undefined)
                return errorResult(state, "id required for update");
            const index = state.tasks.findIndex((task) => task.id === params.id);
            if (index === -1)
                return errorResult(state, `#${params.id} not found`);
            const current = state.tasks[index];
            const hasMutation = params.subject !== undefined ||
                params.description !== undefined ||
                params.activeForm !== undefined ||
                params.status !== undefined ||
                params.note !== undefined ||
                (params.addBlockedBy && params.addBlockedBy.length > 0) ||
                (params.removeBlockedBy && params.removeBlockedBy.length > 0);
            if (!hasMutation) {
                return errorResult(state, "update requires at least one mutable field: subject, description, activeForm, status, note, addBlockedBy, or removeBlockedBy");
            }
            let newStatus = current.status;
            if (params.status !== undefined) {
                if (!isTransitionValid(current.status, params.status)) {
                    return errorResult(state, `illegal transition ${current.status} → ${params.status}`);
                }
                newStatus = params.status;
            }
            let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
            if (params.removeBlockedBy?.length) {
                const toRemove = new Set(params.removeBlockedBy);
                newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
            }
            if (params.addBlockedBy?.length) {
                for (const dep of params.addBlockedBy) {
                    if (dep === current.id)
                        return errorResult(state, `cannot block #${current.id} on itself`);
                    const depTask = state.tasks.find((task) => task.id === dep);
                    if (!depTask)
                        return errorResult(state, `addBlockedBy: #${dep} not found`);
                    if (depTask.status === "deleted")
                        return errorResult(state, `addBlockedBy: #${dep} is deleted`);
                    if (!newBlockedBy.includes(dep))
                        newBlockedBy.push(dep);
                }
                if (detectCycle(state.tasks, current.id, newBlockedBy)) {
                    return errorResult(state, "addBlockedBy would create a cycle in the blockedBy graph");
                }
            }
            const updated = { ...current, status: newStatus };
            if (params.subject !== undefined)
                updated.subject = params.subject;
            if (params.description !== undefined)
                updated.description = params.description;
            if (params.activeForm !== undefined)
                updated.activeForm = params.activeForm;
            if (params.note !== undefined)
                updated.note = params.note;
            if (newBlockedBy.length)
                updated.blockedBy = newBlockedBy;
            else
                delete updated.blockedBy;
            const tasks = [...state.tasks];
            tasks[index] = updated;
            return {
                state: { tasks, nextId: state.nextId },
                op: {
                    kind: "update",
                    id: updated.id,
                    fromStatus: current.status,
                    toStatus: newStatus,
                    changed: taskChanged(current, updated),
                },
            };
        }
        case "list": {
            return {
                state,
                op: { kind: "list", ...(params.status !== undefined ? { statusFilter: params.status } : {}) },
            };
        }
        case "get": {
            if (params.id === undefined)
                return errorResult(state, "id required for get");
            const task = state.tasks.find((candidate) => candidate.id === params.id);
            if (!task)
                return errorResult(state, `#${params.id} not found`);
            return { state, op: { kind: "get", task } };
        }
        case "delete": {
            if (params.id === undefined)
                return errorResult(state, "id required for delete");
            const index = state.tasks.findIndex((task) => task.id === params.id);
            if (index === -1)
                return errorResult(state, `#${params.id} not found`);
            const current = state.tasks[index];
            if (current.status === "deleted")
                return errorResult(state, `#${current.id} is already deleted`);
            const updated = { ...current, status: "deleted" };
            if (params.note !== undefined)
                updated.note = params.note;
            const tasks = [...state.tasks];
            tasks[index] = updated;
            return {
                state: { tasks, nextId: state.nextId },
                op: { kind: "delete", id: updated.id, subject: updated.subject },
            };
        }
        case "clear": {
            // `nextId` is deliberately kept (rpiv-todo resets it to 1): ids must
            // never be reused, because every snapshot kept in the transcript would
            // then point two tasks at the same id.
            return {
                state: { tasks: [], nextId: state.nextId },
                op: { kind: "clear", count: state.tasks.length },
            };
        }
    }
}
