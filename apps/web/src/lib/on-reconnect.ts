/**
 * "THE SOCKET WENT AWAY AND CAME BACK" — as an event (POD-2721).
 *
 * A server cannot swap the website it serves without going away and coming
 * back, so a genuine reconnect is the exact — and only — instant worth asking
 * "am I still the app you are serving?". That makes the check free: no polling,
 * no timer, one `/version` read per outage.
 *
 * DOWN AND BACK, not merely `ok`. The hub's health callback replays the current
 * health the moment you subscribe and re-emits whenever the round-trip time
 * moves, so firing on every `ok` would be a poll wearing a callback's clothes —
 * and firing on the replayed one would re-ask at boot, where the boot check has
 * already asked. Only a transition through `down` counts.
 *
 * `degraded` is deliberately not a reset: a slow socket that recovers never
 * left, and nothing about it can have replaced the website.
 */
export function onReconnect(
  subscribe: (listener: (health: { status: 'ok' | 'degraded' | 'down' }) => void) => () => void,
  reconnected: () => void,
): () => void {
  let wasDown = false
  return subscribe((health) => {
    if (health.status === 'down') {
      wasDown = true
      return
    }
    if (health.status !== 'ok' || !wasDown) return
    wasDown = false
    reconnected()
  })
}
