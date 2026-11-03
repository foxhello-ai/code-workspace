const RELOAD_KEY = "code-workspace.chunk-reload.v1";
let canReload = () => true;

export function setChunkReloadGuard(guard: () => boolean) {
  canReload = guard;
  return () => { if (canReload === guard) canReload = () => true; };
}

export function isChunkLoadError(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === "object" && error !== null && "message" in error ? String(error.message) : "";
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading (?:CSS )?chunk .+ failed|Unable to preload CSS/i.test(message);
}

export function attemptChunkRecovery(error: unknown, environment: { storage: Pick<Storage, "getItem" | "setItem">; reload(): void; canReload(): boolean }) {
  if (!isChunkLoadError(error) || !environment.canReload()) return false;
  try {
    if (environment.storage.getItem(RELOAD_KEY)) return false;
    // Persist before navigation. A new document must not reset this retry budget.
    environment.storage.setItem(RELOAD_KEY, "1");
  } catch { return false; } // Without storage we cannot guarantee a bounded retry.
  environment.reload();
  return true;
}

export function recoverChunkLoad(error: unknown) {
  try { return attemptChunkRecovery(error, { storage: window.sessionStorage, reload: () => window.location.reload(), canReload }); }
  catch { return false; }
}

export function installChunkRecovery(recover = recoverChunkLoad) {
  const handler = (event: Event) => {
    if (recover((event as Event & { payload?: unknown }).payload)) event.preventDefault();
  };
  window.addEventListener("vite:preloadError", handler);
  return () => window.removeEventListener("vite:preloadError", handler);
}
