import { lazy, useEffect, useState } from "react";
import { LockKeyhole } from "lucide-react";
import { api } from "./api";
import { LoadingBoundary, LoadingMessage } from "./LoadingBoundary";

const WorkspaceRoot = lazy(() => import("./WorkspaceRoot"));
const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败";

export function AuthGate() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    api.authStatus().then(result => { if (active) setAuthenticated(result.authenticated); }).catch(reason => { if (active) setError(errorText(reason)); });
    const requireAuth = () => { setError(""); setAuthenticated(false); };
    window.addEventListener("code-workspace:auth-required", requireAuth);
    return () => { active = false; window.removeEventListener("code-workspace:auth-required", requireAuth); };
  }, [attempt]);
  if (authenticated === null) return <div className="boot-screen"><h1>Code Workspace</h1>{error ? <div role="alert"><p>{error}</p><button onClick={() => { setError(""); setAttempt(n => n + 1); }}>重试连接</button></div> : <LoadingMessage label="正在验证登录状态…"/>}</div>;
  if (!authenticated) return <LoginPage onLogin={() => setAuthenticated(true)}/>;
  return <LoadingBoundary label="正在加载工作区…"><WorkspaceRoot onLogout={() => setAuthenticated(false)}/></LoadingBoundary>;
}

function LoginPage({ onLogin }: { onLogin(): void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function login(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true); setError("");
    try { await api.login(password); onLogin(); }
    catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }
  return <div className="login-page"><form className="login-card" onSubmit={login}><div className="login-logo"><LockKeyhole/></div><h1>登录 Code Workspace</h1><p>请输入全局访问密码。</p><label htmlFor="login-password">密码</label><input id="login-password" autoFocus type="password" autoComplete="current-password" value={password} disabled={busy} onChange={event => setPassword(event.target.value)}/><button className="login-submit" disabled={busy || !password}>{busy ? "正在登录…" : "登录"}</button>{error && <div className="login-error" role="alert">{error}</div>}</form></div>;
}
