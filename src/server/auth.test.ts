import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { config } from "./config.js";

describe("global password authentication", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  afterEach(async () => app?.close());

  it("protects APIs and accepts the configured password", async () => {
    app = await buildApp();
    const denied = await app.inject({ method: "GET", url: "/api/workspace" });
    expect(denied.statusCode).toBe(401);
    const wrong = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "wrong" } });
    expect(wrong.statusCode).toBe(401);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: config.appPassword } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const authenticated = await app.inject({ method: "GET", url: "/api/workspace", headers: { cookie } });
    expect(authenticated.statusCode).toBe(404);
  });
});
