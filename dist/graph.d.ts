import type { Task } from "./types.js";
/**
 * Detect whether merging `newBlockedBy` into `taskId`'s `blockedBy` set would
 * introduce a cycle in the dependency graph (ported from rpiv-todo, MIT).
 *
 * Pure of module state: takes the existing task list and the proposed additions
 * explicitly so the reducer can ask "would this update cycle?" without writing.
 */
export declare function detectCycle(tasks: readonly Task[], taskId: number, newBlockedBy: readonly number[]): boolean;
