// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuthGate } from "./AuthGate";
import { api } from "./api";
const workspaceModule = vi.hoisted(() => vi.fn());
vi.mock("./WorkspaceRoot", () => { workspaceModule(); return { default: ({ onLogout }: { onLogout(): void }) => <button onClick={onLogout}>模拟退出工作区</button> }; });
beforeEach(() => {
  vi.spyOn(api, "authStatus").mockResolvedValue({ authenticated: false });
  vi.spyOn(api, "login").mockResolvedValue({ authenticated: true });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("loads the workspace module only after successful authentication", async () => {
  render(<AuthGate/>);
  const input = await screen.findByLabelText("密码");
  expect(workspaceModule).not.toHaveBeenCalled();
  vi.mocked(api.login).mockRejectedValueOnce(new Error("密码错误"));
  fireEvent.change(input, { target: { value: "wrong" } });
  fireEvent.submit(input.closest("form")!);
  await screen.findByRole("alert");
  expect(workspaceModule).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "valid" } });
  fireEvent.submit(input.closest("form")!);
  await screen.findByRole("button", { name: "模拟退出工作区" });
  expect(workspaceModule).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "模拟退出工作区" }));
  await screen.findByLabelText("密码");
});

it("retries a failed authentication check and enters an already authenticated workspace", async () => {
  vi.mocked(api.authStatus).mockRejectedValueOnce(new Error("connection unavailable")).mockResolvedValue({ authenticated: true });
  render(<AuthGate/>);
  await screen.findByText("connection unavailable");
  fireEvent.click(screen.getByRole("button", { name: "重试连接" }));
  await screen.findByRole("button", { name: "模拟退出工作区" });
  expect(api.authStatus).toHaveBeenCalledTimes(2);
  window.dispatchEvent(new Event("code-workspace:auth-required"));
  await waitFor(() => expect(screen.getByLabelText("密码")).toBeTruthy());
});
