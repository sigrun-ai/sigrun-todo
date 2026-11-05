/**
 * The static prompt section: the discipline, not the list. The current list
 * must never appear here — it changes per update, and prompt bytes that
 * change per update break every cache the provider keeps. Freshness of the
 * list is the hooks' job (check + reminder), not the prompt's.
 */
export declare const TODO_SECTION_TEXT = "Todo list: keep the `todo` list current as you work. Update an item as it completes or its status changes; delete an item a change of direction makes obsolete rather than leaving it open. The list belongs to the work, so maintain it as the work happens \u2014 not as a cleanup pass at the end.";
export declare const todoSection: import("@earendil-works/pi-durable").PromptSection<import("@earendil-works/pi-durable").ToolRegistration>;
