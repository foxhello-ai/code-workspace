// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, apiSessionId } from "./api";

const browserCrypto = globalThis.crypto;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("browser API session IDs", () => {
  it("reuses the stored session across requests", async () => {
    const randomUUID = vi.fn(() => "d4569388-fafc-4155-82c4-e421aa8f2990");
    vi.stubGlobal("crypto", { randomUUID });
    const first = apiSessionId();
    expect(apiSessionId()).toBe(first);
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("can request auth status over LAN HTTP without crypto.randomUUID", async () => {
    vi.stubGlobal("crypto", { getRandomValues: browserCrypto.getRandomValues.bind(browserCrypto) });
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { authenticated: false } })
    });
    vi.stubGlobal("fetch", fetch);

    await expect(api.authStatus()).resolves.toEqual({ authenticated: false });
    const session = apiSessionId();
    expect(session).toMatch(uuidPattern);
    expect(fetch.mock.calls[0][1].headers.get("x-code-workspace-session")).toBe(session);
    expect(apiSessionId()).toBe(session);
  });

  it("generates distinct sessions without randomUUID when storage is cleared", () => {
    vi.stubGlobal("crypto", { getRandomValues: browserCrypto.getRandomValues.bind(browserCrypto) });
    const first = apiSessionId();
    sessionStorage.clear();
    const second = apiSessionId();
    expect(first).toMatch(uuidPattern);
    expect(second).toMatch(uuidPattern);
    expect(second).not.toBe(first);
  });
});
