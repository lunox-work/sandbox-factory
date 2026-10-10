/**
 * The bounty list's category filter and a bounty's category mark wear the
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
  CategoryMark,
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

test("a bounty's categories are marked by the first's icon on a tile in its colour, and all named for a reader", () => {
  render(
    <CategoryMark
      categories={[
        { id: "paper-cuts", label: "Paper cuts", reason: "Small and old" },
        { id: "left-behind", label: "Left behind", reason: "Open a year" },
      ]}
    />,
  );
  const mark = screen.getByTestId("category-mark");
  expect(mark.getAttribute("data-category")).toBe("paper-cuts");
  expect(mark.classList.contains("category-badge")).toBe(true);
  expect(mark.querySelector("svg")).not.toBeNull();
  expect(mark.textContent).toBe(
    "Paper cuts: Small and old. Left behind: Open a year",
  );
  expect(mark.title).toBe(
    "Paper cuts: Small and old\nLeft behind: Open a year",
  );
});
