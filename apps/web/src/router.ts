/**
 * Re-export shim (arch-v2 P3, issue #192): the URL router MODEL — route
 * parsing/formatting and the History-API wrapper with its injectable
 * RouterWindow seam — moved to @podium/client-core/router so web and mobile
 * share one navigation model. Existing `./router` imports keep working here.
 */
export * from '@podium/client-core/router'
