// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "./store";
import { useAppStore } from "./store";

const tab = (id: string, dirty = false): Tab => ({
  id,
  type: "text",
  path: `${id}.ts`,
  savedText: "",
  bufferText: dirty ? "changed" : "",
  diskVersion: "v1",
  language: "typescript",
  dirty,
  externalState: "current"
});

beforeEach(() => {
  useAppStore.setState({ tabs: [tab("a"), tab("b"), tab("c")], activeId: "b" });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("tab batch closing", () => {
  it("closes all tabs to the right", () => {
    expect(useAppStore.getState().closeTabsToRight("b")).toBe(true);
    expect(useAppStore.getState().tabs.map((item) => item.id)).toEqual(["a", "b"]);
    expect(useAppStore.getState().activeId).toBe("b");
  });

  it("closes all other tabs", () => {
    useAppStore.getState().closeOtherTabs("b");
    expect(useAppStore.getState().tabs.map((item) => item.id)).toEqual(["b"]);
  });

  it("keeps dirty tabs when confirmation is cancelled", () => {
    useAppStore.setState({ tabs: [tab("a", true), tab("b")], activeId: "b" });
    vi.mocked(window.confirm).mockReturnValue(false);
    expect(useAppStore.getState().closeAllTabs()).toBe(false);
    expect(useAppStore.getState().tabs).toHaveLength(2);
  });
});
