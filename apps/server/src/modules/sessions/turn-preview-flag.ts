/**
 * THE SWITCH FOR THE PREVIEW PLANE (POD-2293).
 *
 * ---------------------------------------------------------------------------
 * AN ENV VAR, NOT AN EXPERIMENTAL FLAG, AND THE REASON IS THE AUDIENCE
 * ---------------------------------------------------------------------------
 *
 * `FEATURES` in `@podium/protocol` is a per-USER registry: it resolves against
 * a person's Experimental settings, and every flag in it defaults off with no
 * way to express "default on". This plane is not per-user — one session's fine
 * watch is shared by everyone looking at it, and one viewer with the flag on
 * would turn the token stream on for a viewer with it off. Worse, the whole
 * feature only exists for sessions already behind `PODIUM_RUNTIME_CONTRACT`,
 * whose operator is by definition someone who sets env vars.
 *
 * So it is a machine switch, shaped exactly like the one the contract path
 * itself uses (`apps/daemon/src/runtime/flag.ts`), and slice 5 of the spec is a
 * change to {@link TURN_PREVIEW_DEFAULT} after the soak — one line, in one
 * place, with the off switch still available.
 *
 * READ ONCE AT COMPOSITION. Re-reading per session would let the plane change
 * under a live viewer, which is a worse state than either setting.
 */

export const TURN_PREVIEW_ENV = 'PODIUM_CHAT_STREAMING'

/**
 * ON. The soak slice 5 waited for is done: the plane was driven end to end on a
 * real instance against a real codex agent (POD-2701), and the reply was
 * observed growing in steps in the chat pane rather than landing whole.
 *
 * WHAT TURNING THIS ON ACTUALLY WIDENS is narrower than it looks. The plane only
 * exists for sessions already on the contract path, and `PODIUM_RUNTIME_CONTRACT`
 * is itself off by default — so this flips streaming on for operators who have
 * already opted into the parallel runtime, and changes nothing at all for anyone
 * else. The off switch keeps working, which is the state an operator most needs
 * it in once the default has moved.
 */
export const TURN_PREVIEW_DEFAULT = true

/**
 * Truthy for `1`/`true`, falsy for `0`/`false`, default otherwise.
 *
 * Both directions are explicit because a flag that only reads "on" cannot be
 * turned OFF once the default flips — which is the state slice 5 leaves this in,
 * and the state in which an operator most needs the switch to work.
 */
export function turnPreviewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[TURN_PREVIEW_ENV]
  if (raw === '1' || raw === 'true') return true
  if (raw === '0' || raw === 'false') return false
  return TURN_PREVIEW_DEFAULT
}
