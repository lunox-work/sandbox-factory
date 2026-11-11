/**
 * The `/device` page, where a person approves a command-line client's
 * sign-in. Better Auth's device endpoints are faked at the auth client.
 */

import { afterEach, expect, test, vi } from "vitest";

import { cleanup, fireEvent, render, screen } from "./render";

const lookUp = vi.fn();
const approve = vi.fn();
const deny = vi.fn();

vi.mock("../src/auth", () => ({
  authClient: {
    device: Object.assign((input: unknown) => lookUp(input), {
      approve: (input: unknown) => approve(input),
      deny: (input: unknown) => deny(input),
    }),
  },
}));

const { DeviceApprovalPage } =
  await import("../src/features/developers/DeviceApproval");
const { deviceCodeForPath } = await import("../src/routes");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const pending = {
  data: { user_code: "ABCD2345", status: "pending", client_id: "carveout" },
  error: null,
};

test("the approval address is /device, with or without a code", () => {
  expect(deviceCodeForPath("/device", "?user_code=ABCD-2345")).toBe(
    "ABCD-2345",
  );
  expect(deviceCodeForPath("/device/", "")).toBe("");
  expect(deviceCodeForPath("/devices", "")).toBeUndefined();
  expect(deviceCodeForPath("/bounties", "?user_code=X")).toBeUndefined();
});

test("a code is looked up, its client and scopes shown, and approved", async () => {
  lookUp.mockResolvedValue(pending);
  approve.mockResolvedValue({ data: { success: true }, error: null });
  render(<DeviceApprovalPage initialCode="abcd-2345" />);
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  // Typed loosely, sent as issued.
  expect(await screen.findByText("carveout")).toBeTruthy();
  expect(lookUp).toHaveBeenCalledWith({ query: { user_code: "ABCD2345" } });
  expect(screen.getByText("sandboxes:write")).toBeTruthy();
  expect(screen.queryByText("webhooks:write")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "Approved. Return to your terminal to finish.",
  );
  expect(approve).toHaveBeenCalledWith({ userCode: "ABCD2345" });
});

test("a sign-in can be denied", async () => {
  lookUp.mockResolvedValue(pending);
  deny.mockResolvedValue({ data: { success: true }, error: null });
  render(<DeviceApprovalPage initialCode="ABCD2345" />);
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "Denied. Nothing was signed in.",
  );
  expect(approve).not.toHaveBeenCalled();
});

test("an expired, unknown or used code says so", async () => {
  render(<DeviceApprovalPage initialCode="" />);
  const field = screen.getByLabelText("The code your terminal shows");
  expect(
    (screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(field, { target: { value: "WXYZ7890" } });

  lookUp.mockResolvedValueOnce({
    data: null,
    error: { status: 400, error: "expired_token" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByText(/has expired/)).toBeTruthy();

  lookUp.mockResolvedValueOnce({
    data: null,
    error: { status: 400, error: "invalid_request" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByText(/not one we issued/)).toBeTruthy();

  lookUp.mockResolvedValueOnce({
    data: { user_code: "WXYZ7890", status: "approved" },
    error: null,
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByText(/already approved or denied/)).toBeTruthy();
});

test("a refused approval keeps the choice open with the reason", async () => {
  lookUp.mockResolvedValue(pending);
  approve.mockResolvedValue({
    data: null,
    error: { status: 500, message: "Server error" },
  });
  render(<DeviceApprovalPage initialCode="ABCD2345" />);
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  expect(await screen.findByText("Server error")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
});
