/**
 * `topicWatch` — the server's demand for one daemon-produced topic key
 * (ADR 7 Amendment 2 D21/D22). A routing fact only: what starting a key means
 * belongs to the producer registered for its kind in `topics/watch-registry.ts`.
 */

import type { ControlHandlers } from './context'

export const topicHandlers: Pick<ControlHandlers, 'topicWatch'> = {
  topicWatch: (ctx, msg) => {
    ctx.topicWatches.apply(msg.key, msg.on, msg.input)
  },
}
