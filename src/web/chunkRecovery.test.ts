// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { attemptChunkRecovery, installChunkRecovery } from "./chunkRecovery";

const failure = () => new TypeError("Failed to fetch dynamically imported module: https://example.test/assets/WorkspaceRoot-12345678.js");
afterEach(() => { sessionStorage.clear(); });

it("refreshes only once even when the new document or React boundary encounters the same error", () => {
  const reload = vi.fn();
  const environment = { storage: sessionStorage, reload, canReload: () => true };
  expect(attemptChunkRecovery(failure(), environment)).toBe(true);
  expect(attemptChunkRecovery(failure(), { ...environment })).toBe(false);
  expect(reload).toHaveBeenCalledOnce();
});

it("does not automatically refresh when there are unsaved edits, and does not consume the recovery budget", () => {
  const reload = vi.fn();
  expect(attemptChunkRecovery(failure(), { storage: sessionStorage, reload, canReload: () => false })).toBe(false);
  expect(reload).not.toHaveBeenCalled();
  expect(attemptChunkRecovery(failure(), { storage: sessionStorage, reload, canReload: () => true })).toBe(true);
});

it("does not refresh for unrelated application errors or when session storage is unavailable", () => {
  const reload = vi.fn();
  const environment = { storage: sessionStorage, reload, canReload: () => true };
  expect(attemptChunkRecovery(new Error("API request failed"), environment)).toBe(false);
  expect(attemptChunkRecovery(failure(), { ...environment, storage: { getItem() { throw new Error("blocked"); }, setItem() {} } })).toBe(false);
  expect(reload).not.toHaveBeenCalled();
});

it("cancels Vite's preload error only when a bounded recovery was actually initiated", () => {
  const recover = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
  const uninstall = installChunkRecovery(recover);
  try {
    const first = Object.assign(new Event("vite:preloadError", { cancelable: true }), { payload: failure() });
    window.dispatchEvent(first);
    expect(recover).toHaveBeenCalledWith(first.payload);
    expect(first.defaultPrevented).toBe(true);
    const repeated = Object.assign(new Event("vite:preloadError", { cancelable: true }), { payload: failure() });
    window.dispatchEvent(repeated);
    expect(repeated.defaultPrevented).toBe(false);
  } finally { uninstall(); }
});
