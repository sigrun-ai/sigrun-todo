/**
 * Canonical todo state for `@sigrun/todo`. The shape is pinned: every
 * state-changing `todo` result carries it as `details`, and replay reads the
 * latest snapshot off the transcript, so field names and field order are a
 * cross-version compatibility surface.
 */
export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";
export interface Task {
    id: number;
    subject: string;
    description?: string;
    activeForm?: string;
    status: TaskStatus;
    blockedBy?: number[];
    note?: string;
}
export interface TodoState {
    tasks: Task[];
    nextId: number;
}
export declare const EMPTY_STATE: TodoState;
export type TodoAction = "create" | "update" | "list" | "get" | "delete" | "clear";
/** The `details` of every state-changing result: the full post-change state. */
export interface TodoSnapshot extends TodoState {
    action: TodoAction;
}
