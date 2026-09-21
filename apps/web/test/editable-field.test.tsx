/**
 * Tests for the click-to-edit field.
 *
 * What matters is the transition: a value reads as text, asks to be edited,
 * and returns to text whichever way the edit ends. The failure this guards
 * against is a field that looks editable when it is not, or one that strands
 * a draft after a cancel.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { EditableField } from "../src/components/EditableField";

function show(props: Partial<Parameters<typeof EditableField>[0]> = {}) {
  const onSave = vi.fn();
  render(
    <EditableField
      label="Name"
      value="charlie ang"
      onSave={onSave}
      {...props}
    />,
  );
  return { onSave };
}

test("the value reads as text, with no input in sight", () => {
  show();

  expect(screen.getByText("charlie ang")).toBeDefined();
  expect(screen.queryByLabelText("Name")).toBeNull();
});

test("the label names the value in both states", async () => {
  // Asked for so a value is never a bare string somebody has to infer.
  show();

  expect(screen.getByText("Name")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Edit name" }));
  expect(await screen.findByLabelText("Name")).toBeDefined();
  expect(screen.getByText("Name")).toBeDefined();
});

test("clicking the value opens an input seeded with it", async () => {
  show();

  fireEvent.click(screen.getByRole("button", { name: "Edit name" }));

  const field = (await screen.findByLabelText("Name")) as HTMLInputElement;
  expect(field.value).toBe("charlie ang");
});

test("saving reports the trimmed value and closes", async () => {
  const { onSave } = show();

  fireEvent.click(screen.getByRole("button", { name: "Edit name" }));
  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: "  Charlie Ang  " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));

  expect(onSave).toHaveBeenCalledWith("Charlie Ang");
  await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
});

test("cancelling saves nothing and keeps the stored value", async () => {
  const { onSave } = show();

  fireEvent.click(screen.getByRole("button", { name: "Edit name" }));
  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: "Something else" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel editing name" }));

  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByText("charlie ang")).toBeDefined();
});

test("a cancelled draft does not come back on the next edit", async () => {
  // The draft is re-seeded on the way in; leaving it behind would show the
  // abandoned text as though it had been saved.
  show();

  fireEvent.click(screen.getByRole("button", { name: "Edit name" }));
  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: "Abandoned" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel editing name" }));
  fireEvent.click(await screen.findByRole("button", { name: "Edit name" }));

  expect(
    ((await screen.findByLabelText("Name")) as HTMLInputElement).value,
  ).toBe("charlie ang");
});

test("Escape leaves without saving", async () => {
  const { onSave } = show();

  fireEvent.click(screen.getByRole("button", { name: "Edit name" }));
  const field = await screen.findByLabelText("Name");
  fireEvent.change(field, { target: { value: "Something else" } });
  fireEvent.keyDown(field, { key: "Escape" });

  expect(onSave).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
});

test("a value that fails its own rules cannot be saved", async () => {
  show({ validate: (draft) => draft.length > 3 });

  fireEvent.click(screen.getByRole("button", { name: "Edit name" }));
  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: "no" },
  });

  expect(
    (screen.getByRole("button", { name: "Save name" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("a validation reason is shown beside the invalid draft", async () => {
  show({ validate: () => "Use letters, numbers, or hyphens." });

  fireEvent.click(screen.getByRole("button", { name: "Edit name" }));
  const field = await screen.findByLabelText("Name");
  fireEvent.change(field, { target: { value: "not valid!" } });

  expect(screen.getByRole("alert").textContent).toBe(
    "Use letters, numbers, or hyphens.",
  );
  expect(field.getAttribute("aria-invalid")).toBe("true");
});

test("a blank value cannot be saved by default", async () => {
  show();

  fireEvent.click(screen.getByRole("button", { name: "Edit name" }));
  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: "   " },
  });

  expect(
    (screen.getByRole("button", { name: "Save name" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("a viewer who may not edit is offered no way in", () => {
  // Not a disabled input: a control that cannot do anything still reads as
  // one that should.
  show({ canEdit: false, readOnlyReason: "Only an owner can rename this." });

  expect(screen.getByText("charlie ang")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Edit name" })).toBeNull();
  // The reason is said out loud rather than hidden in a tooltip.
  expect(screen.getByText("Only an owner can rename this.")).toBeDefined();
});

test("a prefix is shown but never sent", async () => {
  const { onSave } = show({ label: "Username", value: "dana", prefix: "@" });

  expect(screen.getByText("@dana")).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "Edit username" }));
  const field = (await screen.findByLabelText("Username")) as HTMLInputElement;
  // The input holds the value alone, so the `@` cannot be saved into it.
  expect(field.value).toBe("dana");

  // Changed, because an unchanged value is not sent at all.
  fireEvent.change(field, { target: { value: "dana-rivers" } });
  fireEvent.click(screen.getByRole("button", { name: "Save username" }));
  expect(onSave).toHaveBeenCalledWith("dana-rivers");
});

test("an unchanged value is not saved", async () => {
  // Reopening a field and closing it again is not an edit; a round trip and
  // a tick for it would both be inventions.
  const { onSave } = show();

  fireEvent.click(screen.getByRole("button", { name: "Edit name" }));
  await screen.findByLabelText("Name");
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));

  expect(onSave).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
});

test("a refusal holds the field open with the text that caused it", async () => {
  // The whole point of reporting here: "that handle is taken" is only
  // actionable beside the handle that was typed.
  const onSave = vi.fn().mockResolvedValue("That username is taken.");
  render(<EditableField label="Username" value="dana" onSave={onSave} />);

  fireEvent.click(screen.getByRole("button", { name: "Edit username" }));
  fireEvent.change(await screen.findByLabelText("Username"), {
    target: { value: "taken-one" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save username" }));

  expect(await screen.findByText("That username is taken.")).toBeDefined();
  // Still open, still holding the rejected text, so it can be fixed.
  const field = (await screen.findByLabelText("Username")) as HTMLInputElement;
  expect(field.value).toBe("taken-one");
});

test("a pending save disables both answers and restores focus on success", async () => {
  let finish: () => void = () => {};
  const onSave = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(<EditableField label="Name" value="Dana" onSave={onSave} />);

  fireEvent.click(screen.getByRole("button", { name: "Edit name" }));
  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: "Dana Rivers" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));

  expect(
    (screen.getByRole("button", { name: "Save name" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole("button", {
        name: "Cancel editing name",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);

  finish();
  await waitFor(() => {
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Edit name" }),
    );
  });
});

test("typing again clears the refusal", async () => {
  // It described what was there a moment ago; leaving it up makes the fix
  // look rejected too.
  const onSave = vi.fn().mockResolvedValue("That username is taken.");
  render(<EditableField label="Username" value="dana" onSave={onSave} />);

  fireEvent.click(screen.getByRole("button", { name: "Edit username" }));
  const field = await screen.findByLabelText("Username");
  fireEvent.change(field, { target: { value: "taken-one" } });
  fireEvent.click(screen.getByRole("button", { name: "Save username" }));
  await screen.findByText("That username is taken.");

  fireEvent.change(field, { target: { value: "free-one" } });

  expect(screen.queryByText("That username is taken.")).toBeNull();
});

test("a save is announced for a reader who cannot see the tick", async () => {
  const { onSave } = show();

  fireEvent.click(screen.getByRole("button", { name: "Edit name" }));
  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: "Charlie Ang" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));

  expect(onSave).toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Name saved"),
  );
});

test("an empty value says so rather than showing nothing", () => {
  // A blank line would read as a rendering fault rather than as a value
  // nobody has set.
  show({ value: "", placeholder: "Your name" });

  expect(screen.getByText("Your name")).toBeDefined();
});

test("the confirmation clears itself", async () => {
  /*
   * It confirms something the reader just did and then gets out of the way.
   * A permanent "saved" beside a value says nothing a minute later, and
   * starts reading as part of the value itself.
   */
  vi.useFakeTimers();
  try {
    const onSave = vi.fn();
    render(<EditableField label="Name" value="dana" onSave={onSave} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit name" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Dana Rivers" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    // Announced right after the save...
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("status").textContent).toBe("Name saved");

    // ...and gone a moment later.
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    expect(screen.queryByRole("status")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

// ---- the value looks pressable before you press it ------------------------
//
// These three fields are prose at rest, which is the point. The hover fill is
// what says the line is pressable — it was once cancelled by
// `hover:bg-transparent`, leaving the padding holding a fill that never
// arrived. The pencil rides on top of that: absent until the pointer or the
// keyboard reaches the line.

test("the value at rest lights up under the cursor", () => {
  render(<EditableField label="Name" value="Ada" onSave={vi.fn()} />);

  const button = screen.getByRole("button", { name: /edit name/i });
  expect(button.className).toContain("hover:bg-accent");
  expect(button.className).not.toContain("hover:bg-transparent");
});

test("the pencil stays out of sight until the line is hovered or focused", () => {
  const { container } = render(
    <EditableField label="Name" value="Ada" onSave={vi.fn()} />,
  );

  const pencil = container.querySelector("svg");
  expect(pencil).not.toBeNull();
  const className = pencil?.getAttribute("class") ?? "";
  // Hidden at rest, and brought back by either route in — not hover alone,
  // which would strand the keyboard.
  expect(className).toContain("opacity-0");
  expect(className).toContain("group-hover/edit:opacity-100");
  expect(className).toContain("group-focus-visible/edit:opacity-100");
});

// A phone never hovers, so the two reveals above are both unreachable there.
// Without this the fields are indistinguishable from static text on the
// surface where that matters most — which is the bug the `opacity-40` era was
// solving, kept fixed here without dimming the pencil for everyone else.
test("the pencil is always visible where there is no pointer to hover", () => {
  const { container } = render(
    <EditableField label="Name" value="Ada" onSave={vi.fn()} />,
  );

  const pencil = container.querySelector("svg");
  expect(pencil?.getAttribute("class") ?? "").toContain("coarse:opacity-100");
});
