/**
 * The event kind of a session's runtime event log, in a module of its own.
 *
 * `sync/record-sources.ts` reads it while its declarations are built, and the store's
 * repositories import change capture (`sync/capture-pg.ts`), which imports those
 * declarations. Defined in `store/events.ts`, the constant would be read before that
 * module had run whenever `store/events.ts` loads first: a cycle that renders the
 * runtime events' row filter with `kind = 'undefined'`. `store/events.ts` re-exports it.
 */
export const RUNTIME_EVENT_LOG_KIND = 'session.runtime'
