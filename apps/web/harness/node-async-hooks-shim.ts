/**
 * DEV-HARNESS ONLY (POD-4537). Vite's dev server externalises Node builtins
 * for browser compatibility with a stub that THROWS on named access, while the
 * prototype harness bundle stubs `node:async_hooks` as absent — which is what
 * `tests/worklist/harness/src/work-meter.ts` expects (it falls back
 * to UNTRACKED when `AsyncLocalStorage` is not a function). This shim gives
 * the dev server the same absent shape, so the live demo page can mount the
 * arms without pulling a Node-only module into the browser.
 *
 * Nothing in the production graph imports `node:async_hooks`, so this alias is
 * a no-op for `vite build` and the bundle budget.
 */
export const AsyncLocalStorage = undefined
export default undefined
