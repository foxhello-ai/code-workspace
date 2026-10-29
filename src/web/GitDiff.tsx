import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Columns2, FileCode2, List } from "lucide-react";
import type { DiffDocument, DiffFile } from "../shared/contracts";
import { api, apiSessionId } from "./api";
import { DiffViewer } from "./DiffViewer";

export interface DiffSelection {
  scope: "working" | "staged" | "all" | "commit";
  path?: string;
  hash?: string;
}

export function GitDiff({ repositoryId, selection, active = true }: { repositoryId: string; selection: DiffSelection; active?: boolean }) {
  const [sideBySide, setSideBySide] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string>();
  const query = useQuery({
    queryKey: ["git", "inline-diff", repositoryId, selection.scope, selection.hash, selection.path],
    queryFn: () => selection.scope === "commit"
      ? api.commitDiff(selection.hash!, selection.path, repositoryId)
      : api.diff(selection.scope, selection.path, repositoryId),
    enabled: active,
    retry: false
  });
  const document = query.data;
  const file = document?.files.find(f => f.path === selectedPath) ?? document?.files[0];
  return <section className="git-diff" aria-label="文件差异" aria-busy={query.isFetching}>
    <header className="git-diff-header">
      <FileCode2 size={16}/><strong title={file?.path}>{file?.path.split("/").at(-1) ?? "文件差异"}</strong>
      {file?.additions !== undefined && <span className="diff-additions">+{file.additions}</span>}
      {file?.deletions !== undefined && <span className="diff-deletions">−{file.deletions}</span>}
      <div className="workbench-segment" aria-label="差异展示方式">
        <button aria-pressed={!sideBySide} onClick={() => setSideBySide(false)}><List size={13}/>统一</button>
        <button aria-pressed={sideBySide} onClick={() => setSideBySide(true)}><Columns2 size={13}/>并排</button>
      </div>
    </header>
    {query.isError ? <p className="panel-empty error" role="alert">{query.error instanceof Error ? query.error.message : "差异读取失败"}</p>
      : !document ? <p className="panel-empty">正在读取差异…</p>
      : !file ? <p className="panel-empty">没有可显示的差异，文件可能已由外部程序修改。</p>
      : <>
        <div className="git-diff-context">
          {document.files.length > 1 ? <select aria-label="差异文件" value={file.path} onChange={e => setSelectedPath(e.target.value)}>{document.files.map(f => <option key={f.path} value={f.path}>{f.path}</option>)}</select> : <span title={file.path}>{file.oldPath ? `${file.oldPath} → ` : ""}{file.path}</span>}
          <span>{document.base} → {document.target}</span>
        </div>
        {document.truncated && <p className="boundary-note">部分文件超过预览限制，未加载其内容。</p>}
        {file.truncated ? <p className="panel-empty">文件超过预览大小限制，未加载内容。</p>
          : file.binary ? <BinaryDiff file={file} document={document} repositoryId={repositoryId}/>
          : <div className="git-diff-editor"><DiffViewer key={`${repositoryId}:${document.id}:${file.path}`} height="100%" theme="vs-dark" language={languageFor(file.path)} original={file.oldText ?? ""} modified={file.newText ?? ""} options={{ readOnly: true, originalEditable: false, automaticLayout: true, renderSideBySide: sideBySide, useInlineViewWhenSpaceIsLimited: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false }}/></div>}
      </>}
  </section>;
}

function BinaryDiff({ file, document, repositoryId }: { file: DiffFile; document: DiffDocument; repositoryId: string }) {
  if (!/\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(file.path)) return <p className="panel-empty">二进制文件暂不支持内容预览。</p>;
  const url = (source: string, path: string, hash?: string) => `/api/git/image?${new URLSearchParams({ sessionId: apiSessionId(), source, path, repositoryId, ...(hash ? { hash } : {}) })}`;
  const oldSource = document.scope === "working" ? "index" : document.scope === "commit" ? "commit" : "head";
  const newSource = document.scope === "staged" ? "index" : document.scope === "commit" ? "commit" : "worktree";
  return <div className="image-diff">{[
    { label: document.base, missing: file.status === "added", src: url(oldSource, file.oldPath ?? file.path, document.scope === "commit" ? document.base : undefined) },
    { label: document.target, missing: file.status === "deleted", src: url(newSource, file.path, document.scope === "commit" ? document.target : undefined) }
  ].map(side => <section key={side.label}><header>{side.label}</header><div>{side.missing ? <span>此版本中不存在图片</span> : <img src={side.src} alt={`${side.label} · ${file.path}`}/>}</div></section>)}</div>;
}

function languageFor(path: string) {
  return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json", md: "markdown", css: "css", html: "html", py: "python", yml: "yaml", yaml: "yaml" } as Record<string, string>)[path.split(".").at(-1) ?? ""] ?? "plaintext";
}
