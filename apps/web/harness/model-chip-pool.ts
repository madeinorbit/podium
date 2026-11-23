/**
 * The pool the model chip reads, stood down for the harness (POD-6523): each
 * session's latest `session.configure` record, set by the page.
 */
const records = new Map<string, Record<string, unknown>>()

export function setConfigureChange(sessionId: string, record: Record<string, unknown>): void {
  records.set(sessionId, record)
}

const pool = {
  sessionObject: (id: string) => ({ configureChange: records.get(id) }),
  tables: { effect: new Map<string, unknown>() },
  model: () => undefined,
}

export function useWorklistPool(): typeof pool {
  return pool
}
