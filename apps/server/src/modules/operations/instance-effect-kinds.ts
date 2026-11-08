/**
 * THE EFFECT KINDS THAT ACT ON THE WHOLE INSTANCE (ADR 12 D5 E3, POD-6358).
 *
 * A software update and a server move change the instance for everyone, so
 * every administrator reads their records, whoever started them; a member
 * reads none (feed visibility, `feed-visibility.ts`). A leaf module, so the
 * visibility policy can name the kinds without importing the code that runs
 * them.
 */

export const UPDATE_EFFECT_KIND = 'server.update'
export const SERVER_MOVE_EFFECT_KIND = 'server.move'

export const INSTANCE_EFFECT_KINDS: ReadonlySet<string> = new Set([
  UPDATE_EFFECT_KIND,
  SERVER_MOVE_EFFECT_KIND,
])
