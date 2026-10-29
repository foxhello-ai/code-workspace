import { lazy } from "react";
import type { DiffEditorProps } from "@monaco-editor/react";
import { LoadingBoundary } from "./LoadingBoundary";

const Editor = lazy(() => import("./EditorRuntime").then(module => ({ default: module.DiffViewer })));
export function DiffViewer(props: DiffEditorProps) {
  return <LoadingBoundary label="正在加载差异编辑器…"><Editor {...props}/></LoadingBoundary>;
}
