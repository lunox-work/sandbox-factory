/**
 * The picture helpers and the field, apart from any page: what is refused
 * before anything is sent, and how each kind of server answer reads.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import {
  TOO_LARGE,
  UNSUPPORTED,
  UPLOADS_OFF,
  precheck,
  removeAvatar,
  uploadAvatar,
} from "../src/avatars";
import { AvatarField } from "../src/components/AvatarField";

afterEach(() => {
  vi.unstubAllGlobals();
});

const png = (size = 16) =>
  new File([new Uint8Array(size)], "a.png", { type: "image/png" });

function answer(status: number, body: unknown) {
  const fetch = vi.fn(async () =>
    typeof body === "string"
      ? new Response(body, { status })
      : new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

test("precheck refuses what the server would, before it is sent", () => {
  expect(precheck(png())).toBeUndefined();
  expect(
    precheck(new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.png")),
  ).toBe(TOO_LARGE);
  expect(
    precheck(new File(["<svg/>"], "x.svg", { type: "image/svg+xml" })),
  ).toBe(UNSUPPORTED);
  // Some systems report no type at all; the server decides those.
  expect(precheck(new File([new Uint8Array(4)], "mystery"))).toBeUndefined();
});

test("a file refused by the precheck never reaches the network", async () => {
  const fetch = answer(200, { image: null });

  expect(
    await uploadAvatar(
      "/api/v1/me/avatar",
      new File(["x"], "x.svg", { type: "image/svg+xml" }),
    ),
  ).toEqual({ error: UNSUPPORTED });
  expect(fetch).not.toHaveBeenCalled();
});

test("an upload sends the file as multipart, with the session cookie", async () => {
  const fetch = answer(200, { image: "/api/avatars/user/u/x.webp" });

  expect(await uploadAvatar("/api/v1/me/avatar", png())).toEqual({
    image: "/api/avatars/user/u/x.webp",
  });
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/api/v1/me/avatar");
  expect(init.method).toBe("PUT");
  expect(init.credentials).toBe("include");
  expect((init.body as FormData).get("file")).toBeInstanceOf(File);
});

test("each kind of failure reads as a sentence", async () => {
  answer(404, "{}");
  expect(await removeAvatar("/api/v1/me/avatar")).toEqual({
    error: UPLOADS_OFF,
  });

  answer(403, { error: "Only an owner or an admin can change it." });
  expect(await removeAvatar("/api/v1/orgs/o/avatar")).toEqual({
    error: "Only an owner or an admin can change it.",
  });

  // A 200 of the wrong shape, and a body that is not JSON at all.
  answer(200, { something: "else" });
  expect(await removeAvatar("/api/v1/me/avatar")).toEqual({
    error: "Could not remove the picture.",
  });
  answer(500, "<html>");
  expect(await uploadAvatar("/api/v1/me/avatar", png())).toEqual({
    error: "Could not save that picture.",
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("offline");
    }),
  );
  expect(await uploadAvatar("/api/v1/me/avatar", png())).toEqual({
    error: "Could not save that picture.",
  });
});

test("without edit the field is just the face", () => {
  render(<AvatarField id="user_1" shape="circle" readOnlyReason="Not here." />);

  expect(screen.queryByRole("button")).toBeNull();
  expect(document.querySelector('[title="Not here."]')).not.toBeNull();
});

test("a refusal is shown under the picture and cleared by the next attempt", async () => {
  const onUpload = vi
    .fn<(file: File) => Promise<string | void>>()
    .mockResolvedValueOnce("Try again.")
    .mockResolvedValueOnce(undefined);
  render(
    <AvatarField
      id="user_1"
      shape="circle"
      edit={{ onUpload, onRemove: vi.fn() }}
    />,
  );
  const input = screen.getByLabelText("Upload picture");

  fireEvent.change(input, { target: { files: [png()] } });
  expect((await screen.findByRole("alert")).textContent).toBe("Try again.");

  fireEvent.change(input, { target: { files: [png()] } });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(onUpload).toHaveBeenCalledTimes(2);
});

test("while the page is busy the picture cannot be changed", () => {
  render(
    <AvatarField
      id="user_1"
      shape="square"
      edit={{ busy: true, onUpload: vi.fn(), onRemove: vi.fn() }}
    />,
  );

  expect(
    (
      screen.getByRole("button", {
        name: "Change picture",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test("picking nothing sends nothing", () => {
  const onUpload = vi.fn();
  render(
    <AvatarField
      id="user_1"
      shape="circle"
      edit={{ onUpload, onRemove: vi.fn() }}
    />,
  );

  fireEvent.change(screen.getByLabelText("Upload picture"), {
    target: { files: [] },
  });

  expect(onUpload).not.toHaveBeenCalled();
});
