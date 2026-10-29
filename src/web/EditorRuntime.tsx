import { useEffect, useRef } from "react";
import Editor, { DiffEditor, loader, type DiffEditorProps, type EditorProps } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import type { editor } from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

(self as typeof self & { MonacoEnvironment: { getWorker(_: string, label: string): Worker } }).MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  }
};
loader.config({ monaco });

export function CodeEditor(props: EditorProps) { return <Editor {...props}/>; }

// Dispose the widget before its models. The React Monaco wrapper otherwise disposes
// models first, which throws when a Diff is unmounted by worktree navigation.
export function DiffViewer(props: DiffEditorProps) {
  const models = useRef<editor.IDiffEditorModel | null>(null);
  useEffect(() => () => {
    const current = models.current;
    queueMicrotask(() => {
      if (current?.original && !current.original.isDisposed()) current.original.dispose();
      if (current?.modified && !current.modified.isDisposed()) current.modified.dispose();
    });
  }, []);
  return <DiffEditor {...props} keepCurrentOriginalModel keepCurrentModifiedModel onMount={(widget, monaco) => { models.current = widget.getModel(); props.onMount?.(widget, monaco); }}/>;
}
