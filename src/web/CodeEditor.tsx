import { lazy } from "react";
import type { EditorProps } from "@monaco-editor/react";
import { LoadingBoundary } from "./LoadingBoundary";

const Editor = lazy(() => import("./EditorRuntime").then(module => ({ default: module.CodeEditor })));
export default function CodeEditor(props: EditorProps) {
  return <LoadingBoundary label="正在加载代码编辑器…"><Editor {...props}/></LoadingBoundary>;
}
