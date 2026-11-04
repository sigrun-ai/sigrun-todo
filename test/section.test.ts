/**
 * The prompt section (Task 8): static discipline text, gated on the `todo`
 * tool being offered — a turn without the tool gets no section, and the
 * current list must never appear in it.
 */

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PromptInput, ToolRegistration } from "@earendil-works/pi-durable";
import { todoSection, TODO_SECTION_TEXT } from "../src/section.js";

function inputWithTools(toolNames: string[]): PromptInput {
	return {
		agent: {
			tools: toolNames.map((name) => ({ name }) as ToolRegistration),
		},
	} as unknown as PromptInput;
}

describe("todoSection", () => {
	it("renders the static discipline text when `todo` is offered", async () => {
		const rendered = await todoSection.render(
			inputWithTools(["bash", "todo"]),
			BACKGROUND_CONTEXT,
		);

		expect(rendered).toBe(TODO_SECTION_TEXT);
		// The section is the discipline, never the list: no task-shaped text.
		expect(rendered).not.toMatch(/#\d/);
		expect(rendered).toContain("`todo`");
	});

	it("renders undefined when `todo` is not offered", async () => {
		const rendered = await todoSection.render(inputWithTools(["bash"]), BACKGROUND_CONTEXT);

		expect(rendered).toBeUndefined();
	});

	it("is keyed `todo` and tagged like every section", () => {
		expect(todoSection.key).toBe("todo");
		expect(todoSection.tag).not.toBe(false);
	});
});
