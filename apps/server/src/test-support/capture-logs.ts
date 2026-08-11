import { addSink, type LogRecord } from '@podium/logger'

/**
 * Watch what a unit LOGS, for tests that used to watch what it printed.
 *
 * `vi.spyOn(console, 'warn')` stopped being able to see server diagnostics when
 * POD-1901 routed them through `@podium/logger`: the records still exist and
 * still carry the same facts, they just no longer pass through the console. This
 * is the replacement, and it observes the real channel rather than a stand-in —
 * a registered sink is exactly what the file and stdout sinks are in production.
 *
 * Prefer {@link CapturedLogs.records} over {@link CapturedLogs.text}. The move to
 * structured logging turned interpolated values into FIELDS, so asserting on a
 * record's `sessionId` pins the thing the code promises, where a substring match
 * on a rendered line also pins the wording around it.
 */
export interface CapturedLogs {
  /** Every record emitted since capture began, in order. */
  readonly records: LogRecord[]
  /** Records at one level — the usual stand-in for a `console.warn` spy. */
  at(level: LogRecord['level']): LogRecord[]
  /**
   * Every record flattened to `msg key=value …`, for the assertions that really
   * are about the human-readable text (a remedy named in a warning, a secret
   * NOT named in one).
   */
  text(): string
  /** Unregister. Call in a `finally` or `afterEach`, as a spy would be restored. */
  restore(): void
}

/**
 * Register a capture sink and return the handle. No `minLevel`, so it follows
 * the namespace's configured level exactly as the production sinks do — a
 * capture pinned at `trace` would see records a real deployment would not, and
 * a test asserting on one of those would be green about nothing.
 */
export function captureLogs(): CapturedLogs {
  const records: LogRecord[] = []
  const dispose = addSink({ name: 'test-capture', write: (record) => records.push(record) })
  return {
    records,
    at: (level) => records.filter((r) => r.level === level),
    text: () =>
      records
        .map((r) =>
          Object.entries(r)
            .filter(([key]) => key !== 'ts' && key !== 'level' && key !== 'ns')
            .map(([key, value]) => (key === 'msg' ? String(value) : `${key}=${safeRender(value)}`))
            .join(' '),
        )
        .join('\n'),
    restore: dispose,
  }
}

function safeRender(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return '[unserializable]'
  }
}
