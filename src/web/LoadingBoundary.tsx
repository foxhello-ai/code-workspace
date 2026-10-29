import { Component, Suspense, type ReactNode } from "react";

export function LoadingMessage({ label }: { label: string }) {
  return <div className="module-loading" role="status" aria-live="polite"><span className="boot-spinner" aria-hidden="true"/>{label}</div>;
}

export class LoadingBoundary extends Component<{ label: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="module-loading module-error" role="alert"><p>模块加载失败，请检查网络后重新加载页面。</p><button onClick={() => location.reload()}>重新加载页面</button></div>;
    return <Suspense fallback={<LoadingMessage label={this.props.label}/>}>{this.props.children}</Suspense>;
  }
}
