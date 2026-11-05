/**
 * The Todos panel (Task 9): a `perConversation` panel over the
 * conversation's {@link TodoLog}.
 *
 * - `perConversation: true` and NO `instanceKey`: the channels attach the
 *   panel with `params: { conversationId }` of the open conversation, and
 *   the default canonical-JSON instance key is what the webui hashes —
 *   declaring one would break live updates.
 * - Every render/data checks the CALLER's access: the conversationId is
 *   client-supplied, so an unknown conversation (a `meta` throw) or a
 *   `none` verdict hides the panel outright.
 * - Deleted tasks are tombstones (out of `items` AND out of `total`);
 *   completed rows stay visible, `tone: "neutral"`, never `quiet`.
 * - The tree is a `page` (no sidebar — panel placement) with a markdown
 *   `done/total` line and a list `collection` bound to `/items`.
 */
import type { ConversationId, JsonObject } from "@earendil-works/pi-durable";
import type { SigrunHost, SurfaceDef } from "@sigrun/sigrun/extension";
import type { TodoLog } from "./log.js";
export interface TodoPanelDeps {
    readonly host: SigrunHost;
    readonly log: TodoLog;
}
/**
 * The conversation id of a `perConversation` params object, or `undefined`:
 * a positive integer `conversationId`, nothing else. The value is
 * client-supplied; a brand-cast number must still be an id, so only a
 * positive integer is accepted. (The cast stamps pi-durable's branded
 * `ConversationId` — the runtime check above is the whole guard.)
 */
export declare function conversationIdOf(params: JsonObject): ConversationId | undefined;
/**
 * The instance key a `changed` notification is routed by. This must equal
 * `canonicalJson({ conversationId })` — the default key for the params the
 * channels attach — which for this single numeric key is plain
 * `JSON.stringify` (pinned against `canonicalJson` by the panel test).
 */
export declare function panelKey(id: ConversationId): string;
export declare function createTodoPanel(deps: TodoPanelDeps): SurfaceDef<"panel">;
