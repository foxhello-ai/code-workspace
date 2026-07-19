import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

const COOKIE_NAME = "code_workspace_auth";

export class AuthService {
  private failures = new Map<string, { count: number; blockedUntil: number }>();
  private token = createHash("sha256").update(`code-workspace:${config.appPassword}`).digest("hex");

  constructor() {
    if (!config.appPassword) throw new Error("APP_PASSWORD must be configured");
  }

  private equal(left: string, right: string) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  isAuthenticated(cookieHeader?: string) {
    const cookies = Object.fromEntries((cookieHeader ?? "").split(";").map((item) => item.trim().split(/=(.*)/s).slice(0, 2)).filter(([key]) => key));
    return typeof cookies[COOKIE_NAME] === "string" && this.equal(cookies[COOKIE_NAME], this.token);
  }

  login(password: string, clientId: string) {
    const failure = this.failures.get(clientId);
    if (failure?.blockedUntil && failure.blockedUntil > Date.now()) return { ok: false, blocked: true, retryAfter: Math.ceil((failure.blockedUntil - Date.now()) / 1000) };
    if (!this.equal(password, config.appPassword)) {
      const count = (failure?.count ?? 0) + 1;
      const blockedUntil = count >= 5 ? Date.now() + 60_000 : 0;
      this.failures.set(clientId, { count: blockedUntil ? 0 : count, blockedUntil });
      return { ok: false, blocked: Boolean(blockedUntil), retryAfter: blockedUntil ? 60 : 0 };
    }
    this.failures.delete(clientId);
    return { ok: true, blocked: false, retryAfter: 0 };
  }

  cookie(secure: boolean) { return `${COOKIE_NAME}=${this.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure ? "; Secure" : ""}`; }
  clearCookie(secure: boolean) { return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`; }
}
