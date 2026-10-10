/**
 * The bounty list's category filter and a bounty's category line wear the
 * colour each category has in "What task do teams outsource?": they say
 * which category they are with `data-category`, which the stylesheet turns
 * into its accent.
 */

import { openCombobox } from "./combobox";
import { render, screen, within } from "./render";
import { CATEGORIES, UNCATEGORIZED } from "sandbox-factory";
import { expect, test, vi } from "vitest";

import {
  CategoryFilter,
  CategoryLine,
  CategoryNote,
} from "../src/features/bounties/Categories";

test("every option names its category, All and Unassigned included, with an icon in its colour", async () => {
  render(
    <CategoryFilter counts={undefined} selected={null} onSelect={vi.fn()} />,
  );
  const list = await openCombobox(
    within(screen.getByTestId("category-filter")).getByRole("combobox", {
      name: "Category",
    }),
  );
  const options = within(list).getAllByRole("option");
  expect(
    options.map((option) =>
      option.querySelector("[data-category]")?.getAttribute("data-category"),
    ),
  ).toEqual(["all", ...CATEGORIES.map(({ id }) => id), UNCATEGORIZED]);
  for (const option of options)
    expect(option.querySelector("[data-category] svg")).not.toBeNull();
});

test("the chosen category is shown on the trigger, with what it is for", () => {
  render(
    <>
      <CategoryFilter
        counts={undefined}
        selected="paper-cuts"
        onSelect={vi.fn()}
      />
      <CategoryNote counts={undefined} selected="paper-cuts" />
    </>,
  );
  const trigger = screen.getByRole("combobox", { name: "Category" });
  expect(trigger.textContent).toContain("Paper cuts");
  expect(
    trigger.querySelector("[data-category]")?.getAttribute("data-category"),
  ).toBe("paper-cuts");
  expect(screen.getByTestId("category-why").getAttribute("data-category")).toBe(
    "paper-cuts",
  );
});

test("a bounty's category line is in its category's colour", () => {
  render(
    <CategoryLine
      categories={[
        { id: "paper-cuts", label: "Paper cuts", reason: "Small and old" },
      ]}
    />,
  );
  const label = screen.getByText("Paper cuts");
  expect(label.getAttribute("data-category")).toBe("paper-cuts");
  expect(label.classList.contains("category-label")).toBe(true);
});
