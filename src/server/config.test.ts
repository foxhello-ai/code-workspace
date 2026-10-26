import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("production password configuration", () => {
  let directory: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  async function productionConfig() {
    directory = await mkdtemp(path.join(tmpdir(), "workspace-config-"));
    vi.spyOn(process, "cwd").mockReturnValue(directory);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_PASSWORD", undefined);
    vi.resetModules();
    return directory;
  }

  it("rejects startup when no production password is configured", async () => {
    await productionConfig();
    const { config } = await import("./config.js");
    const { AuthService } = await import("./services/auth-service.js");
    expect(config.appPassword).toBe("");
    expect(() => new AuthService()).toThrow("APP_PASSWORD must be configured");
  });

  it("reads an explicitly configured password from the local env file", async () => {
    const directory = await productionConfig();
    await writeFile(path.join(directory, ".env"), "APP_PASSWORD=local-test-only\n");
    const { config } = await import("./config.js");
    expect(config.appPassword).toBe("local-test-only");
  });

  it("prefers the environment over the local env file", async () => {
    const directory = await productionConfig();
    await writeFile(path.join(directory, ".env"), "APP_PASSWORD=file-test-only\n");
    vi.stubEnv("APP_PASSWORD", "environment-test-only");
    const { config } = await import("./config.js");
    expect(config.appPassword).toBe("environment-test-only");
  });
});
