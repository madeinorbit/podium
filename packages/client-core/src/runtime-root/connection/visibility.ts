/**
 * WHERE "IS THIS CLIENT ON SCREEN?" COMES FROM (POD-2055 F4).
 *
 * It is not a local UI detail. The answer goes to the server on every presence
 * frame, and the smart router reads it to decide whether this person needs a
 * push notification — a client that says it is watching gets none
 * (`apps/server/src/modules/notify/service.ts`). So a wrong answer is not a
 * cosmetic bug: it is a phone that silently swallows its own notifications,
 * which is exactly what native mobile did, because the browser helper it went
 * through (`tabIsVisible`) answers `true` wherever there is no `document`.
 *
 * The engine therefore asks a SOURCE rather than the DOM. Web supplies the
 * document; React Native supplies AppState; a test supplies whatever it is
 * testing.
 */

/** A platform's answer to "is this client on screen?", and its changes. */
export interface VisibilitySource {
  isVisible(): boolean
  /** Called on every transition. Returns an unsubscribe. */
  subscribe(onChange: () => void): () => void
}

/**
 * The browser's answer — `document.visibilityState`, exactly as before.
 *
 * Where there is no `document` at all it reports `true` and never changes,
 * which preserves the old helper's behaviour for the server-rendered and
 * headless cases. Native must NOT rely on that fallback: it is the bug, and it
 * is why a native root supplies its own source.
 */
export function domVisibility(): VisibilitySource {
  return {
    isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
    subscribe: (onChange) => {
      if (typeof document === 'undefined') return () => {}
      document.addEventListener('visibilitychange', onChange)
      return () => document.removeEventListener('visibilitychange', onChange)
    },
  }
}
