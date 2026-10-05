/**
 * Driving the app's `Combobox` the way a person does: open it from its
 * trigger, then pick an option from the list it shows.
 *
 * The options exist only while the list is open, so a test waiting for one
 * to load waits here, with the list open, rather than on the closed field.
 */

import { userEvent } from "@testing-library/user-event";

import { screen, within } from "./render";

/** Opens the list from its trigger, and returns it. */
export async function openCombobox(trigger: HTMLElement): Promise<HTMLElement> {
  await userEvent.click(trigger);
  return screen.findByRole("listbox");
}

/** Opens the list from its trigger and picks the option of that name. */
export async function chooseOption(
  trigger: HTMLElement,
  name: string | RegExp,
): Promise<void> {
  const list = await openCombobox(trigger);
  await userEvent.click(await within(list).findByRole("option", { name }));
}
