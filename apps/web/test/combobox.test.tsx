import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { expect, test, vi } from "vitest";

import {
  Combobox,
  filterOptions,
  type ComboboxAction,
} from "../src/components/Combobox";
import { openCombobox } from "./combobox";
import { act, render, screen, within } from "./render";

const repositories = [
  { value: "ghr_1", label: "acme/app", keywords: ["frontend"] },
  { value: "ghr_2", label: "acme/api" },
  { value: "ghr_3", label: "globex/billing" },
];

function Picker({
  initial = "ghr_1",
  onValueChange = () => {},
  actions,
}: {
  initial?: string;
  onValueChange?: (value: string) => void;
  actions?: ComboboxAction[];
}) {
  const [value, setValue] = useState(initial);
  return (
    <Combobox
      label="Repository"
      searchPlaceholder="Search repositories…"
      emptyMessage="No repository matches."
      options={repositories}
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onValueChange(next);
      }}
      actions={actions}
    />
  );
}

const trigger = () => screen.getByRole("combobox", { name: "Repository" });
const search = () =>
  screen.getByRole("combobox", { name: "Search repository" });
const shown = (list: HTMLElement) =>
  within(list)
    .getAllByRole("option")
    .map((option) => option.textContent);

test("the trigger shows the chosen option, and opens on a focused search", async () => {
  render(<Picker />);
  expect(trigger().textContent).toBe("acme/app");

  const list = await openCombobox(trigger());
  expect(document.activeElement).toBe(search());
  expect(shown(list)).toEqual(["acme/app", "acme/api", "globex/billing"]);
  // The chosen one is marked, and is where the highlight starts.
  const chosen = within(list).getByRole("option", { name: "acme/app" });
  expect(chosen.getAttribute("aria-selected")).toBe("true");
  expect(search().getAttribute("aria-activedescendant")).toBe(chosen.id);
});

test("typing narrows the list by every word, across label and keywords", async () => {
  render(<Picker />);
  const list = await openCombobox(trigger());

  await userEvent.type(search(), "acme a");
  expect(shown(list)).toEqual(["acme/app", "acme/api"]);
  await userEvent.clear(search());
  await userEvent.type(search(), "front");
  expect(shown(list)).toEqual(["acme/app"]);
  await userEvent.clear(search());
  await userEvent.type(search(), "nothing");
  expect(within(list).queryAllByRole("option")).toHaveLength(0);
  expect(within(list).getByText("No repository matches.")).toBeTruthy();
});

test("the arrow keys walk the list and Enter takes the highlighted one", async () => {
  const onValueChange = vi.fn();
  render(<Picker onValueChange={onValueChange} />);
  await openCombobox(trigger());

  await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  expect(onValueChange).toHaveBeenCalledWith("ghr_3");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(trigger().textContent).toBe("globex/billing");
  // Closing hands focus back to the trigger.
  expect(document.activeElement).toBe(trigger());
});

test("ArrowUp from the first option wraps to the last", async () => {
  const onValueChange = vi.fn();
  render(<Picker onValueChange={onValueChange} />);
  await openCombobox(trigger());

  await userEvent.keyboard("{ArrowUp}{Enter}");
  expect(onValueChange).toHaveBeenCalledWith("ghr_3");
});

test("picking the chosen option closes without a change", async () => {
  const onValueChange = vi.fn();
  render(<Picker onValueChange={onValueChange} />);
  const list = await openCombobox(trigger());

  await userEvent.click(within(list).getByRole("option", { name: "acme/app" }));
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(onValueChange).not.toHaveBeenCalled();
});

test("typing on the closed trigger opens it already searching", async () => {
  render(<Picker />);
  trigger().focus();

  await userEvent.keyboard("g");
  const list = await screen.findByRole("listbox");
  expect((search() as HTMLInputElement).value).toBe("g");
  expect(shown(list)).toEqual(["globex/billing"]);
});

test("Enter picks rather than submitting the form around it", async () => {
  const onSubmit = vi.fn((event: SubmitEvent) => event.preventDefault());
  render(
    <form onSubmit={(event) => onSubmit(event.nativeEvent as SubmitEvent)}>
      <Picker />
    </form>,
  );
  await openCombobox(trigger());

  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(trigger().textContent).toBe("acme/api");
  expect(onSubmit).not.toHaveBeenCalled();
});

test("actions stay through any search, and the arrow keys reach them", async () => {
  const onSelect = vi.fn();
  render(<Picker actions={[{ key: "all", label: "Manage", onSelect }]} />);
  const list = await openCombobox(trigger());

  await userEvent.type(search(), "nothing");
  expect(within(list).getByRole("option", { name: "Manage" })).toBeTruthy();
  await userEvent.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("an action with a destination is a link a plain click handles", async () => {
  const onSelect = vi.fn();
  render(
    <Picker
      actions={[{ key: "all", label: "Manage", href: "/manage", onSelect }]}
    />,
  );
  const list = await openCombobox(trigger());

  const link = within(list).getByRole("option", { name: "Manage" });
  expect(link.getAttribute("href")).toBe("/manage");
  await act(async () => {
    link.click();
  });
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(window.location.pathname).not.toBe("/manage");
});

test("a disabled trigger does not open", async () => {
  render(
    <Combobox
      label="Repository"
      options={repositories}
      value="ghr_1"
      onValueChange={() => {}}
      disabled
    />,
  );
  await userEvent.click(trigger());
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("a value no option has shows the placeholder", () => {
  render(
    <Combobox
      label="Repository"
      options={repositories}
      value="ghr_gone"
      placeholder="A removed repository"
      onValueChange={() => {}}
    />,
  );
  expect(trigger().textContent).toBe("A removed repository");
});

test("the filter ignores case and accents, and keeps the original order", () => {
  const options = [
    { value: "CRC", label: "CRC — Costa Rican Colón" },
    { value: "PLN", label: "PLN — Polish Złoty", keywords: ["zloty"] },
    { value: "USD", label: "USD — US Dollar" },
  ];
  expect(filterOptions(options, "colon").map(({ value }) => value)).toEqual([
    "CRC",
  ]);
  expect(filterOptions(options, "ZLOTY").map(({ value }) => value)).toEqual([
    "PLN",
  ]);
  expect(filterOptions(options, "  ").map(({ value }) => value)).toEqual([
    "CRC",
    "PLN",
    "USD",
  ]);
});

test("one put up only to be picked from opens as it mounts, and says when it closes", async () => {
  const onOpenChange = vi.fn();
  render(
    <Combobox
      label="Repository"
      options={repositories}
      value="ghr_1"
      defaultOpen
      onOpenChange={onOpenChange}
      onValueChange={() => {}}
    />,
  );
  const list = await screen.findByRole("listbox");
  // As a click opens it: the search focused, the chosen one highlighted.
  expect(document.activeElement).toBe(search());
  expect(
    within(list).getByRole("option", { name: "acme/app" }).dataset.active,
  ).toBe("");
  expect(onOpenChange).toHaveBeenLastCalledWith(true);

  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(onOpenChange).toHaveBeenLastCalledWith(false);

  // A pick closes it too.
  await openCombobox(trigger());
  await userEvent.click(screen.getByRole("option", { name: "acme/api" }));
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
});

test("a list searched elsewhere hears the query and shows its options as given", async () => {
  const heard: string[] = [];
  const picked = vi.fn();
  render(
    <Combobox
      label="Issue"
      filter={false}
      onSearchChange={(query) => heard.push(query)}
      options={[
        { value: "a", label: "APP-1 Export" },
        { value: "b", label: "APP-2 Import", disabled: true },
      ]}
      value=""
      onValueChange={picked}
    />,
  );
  const list = await openCombobox(
    screen.getByRole("combobox", { name: "Issue" }),
  );
  await userEvent.type(
    screen.getByRole("combobox", { name: "Search issue" }),
    "zz",
  );
  // Nothing here matches "zz"; the options are the answer all the same.
  expect(heard.at(-1)).toBe("zz");
  expect(shown(list)).toEqual(["APP-1 Export", "APP-2 Import"]);

  // A disabled option is listed but not picked, and the list stays open.
  const disabled = within(list).getByRole("option", { name: "APP-2 Import" });
  expect(disabled.getAttribute("aria-disabled")).toBe("true");
  await userEvent.click(disabled);
  expect(picked).not.toHaveBeenCalled();
  expect(screen.getByRole("listbox")).toBeDefined();
  await userEvent.click(
    within(list).getByRole("option", { name: "APP-1 Export" }),
  );
  expect(picked).toHaveBeenCalledWith("a");
});
