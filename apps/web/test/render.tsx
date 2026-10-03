export * from "@testing-library/react";
import {
  render as originalRender,
  renderHook as originalRenderHook,
  type RenderOptions,
  type RenderHookOptions,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { ServerDataProvider } from "../src/data/query";

export function render(ui: ReactNode, options?: RenderOptions) {
  const Wrapper = options?.wrapper;
  return originalRender(ui, {
    ...options,
    wrapper: ({ children }) => (
      <ServerDataProvider userId="test-user">
        {Wrapper ? <Wrapper>{children}</Wrapper> : children}
      </ServerDataProvider>
    ),
  });
}
export function renderHook<Result, Props>(
  callback: (props: Props) => Result,
  options?: RenderHookOptions<Props>,
) {
  const Wrapper = options?.wrapper;
  return originalRenderHook(callback, {
    ...options,
    wrapper: ({ children }) => (
      <ServerDataProvider userId="test-user">
        {Wrapper ? <Wrapper>{children}</Wrapper> : children}
      </ServerDataProvider>
    ),
  });
}
