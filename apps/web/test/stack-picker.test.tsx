import { render, screen, within } from "./render";
import { userEvent } from "@testing-library/user-event";
import { STACK_LIMITS } from "sandbox-factory";
import { useState } from "react";
import { expect, test } from "vitest";

import { StackPicker } from "../src/components/StackPicker";

function Picker({
  inherited = [],
  initial = [],
}: {
  inherited?: string[];
  initial?: string[];
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="stack">Tech stack</label>
      <StackPicker
        id="stack"
        inherited={inherited}
        inheritedFrom="acme/app"
        value={value}
        onChange={setValue}
      />
      <output data-testid="value">{value.join(",")}</output>
    </>
  );
}

test("the list is grouped by kind, and the arrow keys move through it", async () => {
  render(<Picker />);
  const field = screen.getByRole("combobox", { name: "Tech stack" });
  expect(field.getAttribute("placeholder")).toBe("Select tech stack");
  await userEvent.click(field);
  const list = screen.getByRole("listbox");
  expect(
    within(list)
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-label")),
  ).toEqual([
    "Languages",
    "Frameworks",
    "Data & messaging",
    "Services",
    "Tools",
  ]);

  await userEvent.type(field, "sql");
  // Every catalog name holding it, then the fragment itself, last.
  const options = within(list).getAllByRole("option");
  expect(options.map((option) => option.textContent)).toEqual([
    "PostgreSQL",
    "MySQL",
    "Microsoft SQL Server",
    "SQLite",
    "SQLAlchemy",
    "Add “sql”",
  ]);
  // Each catalog entry led by its logo; the fragment, by none.
  expect(options.map((option) => option.querySelector("img") !== null)).toEqual(
    [true, true, true, true, true, false],
  );
  expect(options[0]?.getAttribute("aria-selected")).toBe("true");
  await userEvent.keyboard("{ArrowDown}");
  expect(field.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
  await userEvent.keyboard("{ArrowUp}{ArrowUp}");
  // Wraps to the last.
  expect(field.getAttribute("aria-activedescendant")).toBe(
    options[options.length - 1]?.id,
  );
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(screen.getByTestId("value").textContent).toBe("PostgreSQL");
  // Picking closes the list, leaving the field focused; a click reopens it.
  expect(field.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(field);
  await userEvent.click(field);
  expect(field.getAttribute("aria-expanded")).toBe("true");
  await userEvent.keyboard("{Escape}");

  // Escape closes the list and leaves the field.
  await userEvent.type(field, "re");
  expect(field.getAttribute("aria-expanded")).toBe("true");
  await userEvent.keyboard("{Escape}");
  expect(field.getAttribute("aria-expanded")).toBe("false");
});

test("a stack at its limit takes nothing more", () => {
  render(
    <Picker
      inherited={["TypeScript"]}
      initial={Array.from(
        { length: STACK_LIMITS.items - 1 },
        (_, index) => `Tool ${index}`,
      )}
    />,
  );
  const field = screen.getByRole("combobox", { name: "Tech stack" });
  expect((field as HTMLInputElement).disabled).toBe(true);
  expect(field.getAttribute("placeholder")).toBe(
    `At most ${STACK_LIMITS.items}`,
  );
});

test("what is chosen is listed under the field, each row ending in its remove button or lock", async () => {
  render(<Picker inherited={["TypeScript"]} initial={["Redis"]} />);
  const field = screen.getByRole("combobox", { name: "Tech stack" });
  const chosen = screen.getByRole("list", { name: "Chosen technologies" });
  // Under the field, not inside it: the field holds only what is typed.
  expect(
    field.compareDocumentPosition(chosen) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(field.parentElement?.contains(chosen)).toBe(false);

  const [inherited, added] = within(chosen).getAllByRole("listitem");
  expect(inherited?.textContent).toBe("TypeScript, detected in acme/app");
  expect(within(inherited!).queryByRole("button")).toBeNull();
  const remove = within(added!).getByRole("button", { name: "Remove Redis" });
  expect(added?.lastElementChild).toBe(remove);

  await userEvent.click(remove);
  expect(screen.getByTestId("value").textContent).toBe("");
  expect(within(chosen).getAllByRole("listitem")).toHaveLength(1);
  // Back in the field, to add another, but with the list left closed:
  // removing is not picking.
  expect(document.activeElement).toBe(field);
  expect(field.getAttribute("aria-expanded")).toBe("false");
});
