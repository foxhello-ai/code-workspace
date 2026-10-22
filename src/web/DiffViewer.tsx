import { useEffect, useRef } from "react";
import { DiffEditor, type DiffEditorProps } from "@monaco-editor/react";
import type { editor } from "monaco-editor";

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
