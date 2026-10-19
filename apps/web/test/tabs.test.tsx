/**
 * Tests for the app's tabs on Radix's primitive.
 *
 * The property: one pick is one change. The callers push the choice into the
 * address, so a change reported twice is two history entries for one click,
 * and Back has to be pressed twice to undo it.
 */

import { render, screen } from "./render";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { expect, test, vi } from "vitest";

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../src/components/ui/tabs";

function Controlled({ onChange }: { onChange: (value: string) => void }) {
  const [value, setValue] = useState("one");
  return (
    <Tabs
      value={value}
      onValueChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    >
      <TabsList>
        <TabsTrigger value="one">One</TabsTrigger>
        <TabsTrigger value="two">Two</TabsTrigger>
      </TabsList>
      <TabsContent value="one">First</TabsContent>
      <TabsContent value="two">Second</TabsContent>
    </Tabs>
  );
}

test("a click on a tab reports the change once", async () => {
  const onChange = vi.fn();
  render(<Controlled onChange={onChange} />);
  await userEvent.click(screen.getByRole("tab", { name: "Two" }));
  expect(onChange.mock.calls).toEqual([["two"]]);
  expect(
    screen.getByRole("tab", { name: "Two", selected: true }),
  ).toBeDefined();

  // Back and forth: the same value picked again later still goes through.
  await userEvent.click(screen.getByRole("tab", { name: "One" }));
  await userEvent.click(screen.getByRole("tab", { name: "Two" }));
  expect(onChange.mock.calls).toEqual([["two"], ["one"], ["two"]]);
});

test("a change the caller does not take can be asked for again", async () => {
  const onChange = vi.fn();
  render(
    <Tabs value="one" onValueChange={onChange}>
      <TabsList>
        <TabsTrigger value="one">One</TabsTrigger>
        <TabsTrigger value="two">Two</TabsTrigger>
      </TabsList>
    </Tabs>,
  );
  const two = screen.getByRole("tab", { name: "Two" });
  await userEvent.click(two);
  await userEvent.click(screen.getByRole("tab", { name: "One" }));
  await userEvent.click(two);
  expect(onChange.mock.calls).toEqual([["two"], ["two"]]);
});
