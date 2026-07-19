import { create } from "zustand";
import type { FileContent, WorkspaceInfo } from "../shared/contracts";

export interface TextTab {
  id: string;
  type: "text";
  path: string;
  savedText: string;
  bufferText: string;
  diskVersion: string;
  language: string;
  dirty: boolean;
  externalState: "current" | "changed" | "deleted";
  diskText?: string;
  diskNewVersion?: string;
}

export interface DiffTab { id: string; type: "diff"; title: string; oldText: string; newText: string; language: string; stale: boolean }
export type Tab = TextTab | DiffTab;

interface AppState {
  workspace: WorkspaceInfo | null;
  tabs: Tab[];
  activeId: string | null;
  setWorkspace(workspace: WorkspaceInfo | null): void;
  openFile(file: FileContent): void;
  openDiff(tab: Omit<DiffTab, "id" | "stale"> & { id?: string }): void;
  closeTab(id: string): boolean;
  closeOtherTabs(id: string): boolean;
  closeTabsToRight(id: string): boolean;
  closeAllTabs(): boolean;
  activate(id: string): void;
  edit(id: string, text: string): void;
  saved(id: string, file: FileContent): void;
  external(path: string, file: FileContent | null): void;
  markDiffsStale(): void;
  clear(): void;
}

export const useAppStore = create<AppState>((set, get) => ({
  workspace: null, tabs: [], activeId: null,
  setWorkspace: (workspace) => set({ workspace }),
  openFile: (file) => set((state) => {
    const existing = state.tabs.find((tab) => tab.type === "text" && tab.path === file.path);
    if (existing) return { activeId: existing.id };
    const id = `file:${file.path}`;
    const text = file.content ?? "";
    return { tabs: [...state.tabs, { id, type: "text", path: file.path, savedText: text, bufferText: text, diskVersion: file.version, language: file.language ?? "plaintext", dirty: false, externalState: "current" }], activeId: id };
  }),
  openDiff: (tab) => set((state) => {
    const id = tab.id ?? `diff:${tab.title}`;
    const next: DiffTab = { ...tab, id, type: "diff", stale: false };
    const index = state.tabs.findIndex((item) => item.id === id);
    const tabs = index < 0 ? [...state.tabs, next] : state.tabs.map((item) => item.id === id ? next : item);
    return { tabs, activeId: id };
  }),
  closeTab: (id) => {
    const tab = get().tabs.find((item) => item.id === id);
    if (tab?.type === "text" && tab.dirty && !window.confirm(`“${tab.path}”尚未保存，确定关闭吗？`)) return false;
    set((state) => { const tabs = state.tabs.filter((item) => item.id !== id); return { tabs, activeId: state.activeId === id ? tabs.at(-1)?.id ?? null : state.activeId }; });
    return true;
  },
  closeOtherTabs: (id) => {
    const closing = get().tabs.filter((tab) => tab.id !== id);
    const dirty = closing.filter((tab) => tab.type === "text" && tab.dirty);
    if (dirty.length && !window.confirm(`其他标签中有 ${dirty.length} 个文件尚未保存，确定关闭吗？`)) return false;
    set((state) => ({ tabs: state.tabs.filter((tab) => tab.id === id), activeId: id }));
    return true;
  },
  closeTabsToRight: (id) => {
    const index = get().tabs.findIndex((tab) => tab.id === id);
    if (index < 0 || index === get().tabs.length - 1) return true;
    const closing = get().tabs.slice(index + 1);
    const dirty = closing.filter((tab) => tab.type === "text" && tab.dirty);
    if (dirty.length && !window.confirm(`右侧标签中有 ${dirty.length} 个文件尚未保存，确定关闭吗？`)) return false;
    set((state) => ({ tabs: state.tabs.slice(0, index + 1), activeId: id }));
    return true;
  },
  closeAllTabs: () => {
    const dirty = get().tabs.filter((tab) => tab.type === "text" && tab.dirty);
    if (dirty.length && !window.confirm(`有 ${dirty.length} 个文件尚未保存，确定关闭全部标签吗？`)) return false;
    set({ tabs: [], activeId: null });
    return true;
  },
  activate: (activeId) => set({ activeId }),
  edit: (id, bufferText) => set((state) => ({ tabs: state.tabs.map((tab) => tab.id === id && tab.type === "text" ? { ...tab, bufferText, dirty: bufferText !== tab.savedText } : tab) })),
  saved: (id, file) => set((state) => ({ tabs: state.tabs.map((tab) => tab.id === id && tab.type === "text" ? { ...tab, savedText: file.content ?? tab.bufferText, bufferText: file.content ?? tab.bufferText, diskVersion: file.version, dirty: false, externalState: "current", diskText: undefined, diskNewVersion: undefined } : tab) })),
  external: (path, file) => set((state) => ({ tabs: state.tabs.map((tab) => {
    if (tab.type !== "text" || tab.path !== path) return tab;
    if (!file) return { ...tab, externalState: "deleted" };
    if (file.version === tab.diskVersion) return tab;
    if (tab.dirty) return { ...tab, externalState: "changed", diskText: file.content ?? "", diskNewVersion: file.version };
    const text = file.content ?? "";
    return { ...tab, savedText: text, bufferText: text, diskVersion: file.version, externalState: "current" };
  }) })),
  markDiffsStale: () => set((state) => ({ tabs: state.tabs.map((tab) => tab.type === "diff" ? { ...tab, stale: true } : tab) })),
  clear: () => set({ workspace: null, tabs: [], activeId: null })
}));
