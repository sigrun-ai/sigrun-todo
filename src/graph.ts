import type { Task } from "./types.js";

/**
 * Detect whether merging `newBlockedBy` into `taskId`'s `blockedBy` set would
 * introduce a cycle in the dependency graph (ported from rpiv-todo, MIT).
 *
 * Pure of module state: takes the existing task list and the proposed additions
 * explicitly so the reducer can ask "would this update cycle?" without writing.
 */
export function detectCycle(tasks: readonly Task[], taskId: number, newBlockedBy: readonly number[]): boolean {
	const edges = new Map<number, number[]>();
	for (const task of tasks) {
		if (task.id === taskId) {
			const merged = new Set([...(task.blockedBy ?? []), ...newBlockedBy]);
			edges.set(task.id, [...merged]);
		} else {
			edges.set(task.id, task.blockedBy ? [...task.blockedBy] : []);
		}
	}

	const visiting = new Set<number>();
	const visited = new Set<number>();
	const hasCycleFrom = (node: number): boolean => {
		if (visiting.has(node)) return true;
		if (visited.has(node)) return false;
		visiting.add(node);
		for (const blocked of edges.get(node) ?? []) {
			if (hasCycleFrom(blocked)) return true;
		}
		visiting.delete(node);
		visited.add(node);
		return false;
	};

	for (const node of edges.keys()) {
		if (hasCycleFrom(node)) return true;
	}
	return false;
}
