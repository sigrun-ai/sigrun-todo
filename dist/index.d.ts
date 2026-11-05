/**
 * The todo extension factory (Task 9): one {@link TodoLog} in front of the
 * transcript, shared by the tool, the hooks, and the panel, with one
 * `onChanged` notifying the panel's canonical instance key.
 *
 * The factory declares ONE parameter so the loader passes the host in
 * (`factory.length > 0` gates the host argument); a defaulted first
 * parameter would swallow it instead.
 */
import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";
/**
 * The todo extension: an agent-kept task list with a per-conversation panel.
 * The required host parameter keeps the factory at arity one for the loader.
 */
export default function createTodo(host: SigrunHost): SigrunExtensionResult;
