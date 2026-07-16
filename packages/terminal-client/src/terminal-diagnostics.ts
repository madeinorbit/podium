export type TerminalDiagnosticData = Record<string, unknown>

export interface TerminalDiagnosticEntry {
  at: string
  elapsedMs: number
  sessionId: string
  mountId: string
  event: string
  data: TerminalDiagnosticData
}

export interface TerminalDiagnosticsApi {
  /** Oldest-to-newest bounded lifecycle events. Omit sessionId for every mount. */
  snapshot(sessionId?: string): TerminalDiagnosticEntry[]
  clear(): void
  /** Console tracing is otherwise opt-in via ?terminalDebug=1 or localStorage. */
  setConsoleEnabled(enabled: boolean): void
  /** Live-tap every recorded entry (see {@link onTerminalDiagnostic}). */
  onTrace(listener: TerminalDiagnosticListener): () => void
}

/** Listener for {@link onTerminalDiagnostic}. Entries are shared, not cloned —
 *  treat them as read-only. */
export type TerminalDiagnosticListener = (entry: TerminalDiagnosticEntry) => void

const listeners = new Set<TerminalDiagnosticListener>()

/**
 * Subscribe to every diagnostics entry as it is recorded (a live tap on the
 * same bounded ring `snapshot()` reads). Used by the switch-latency collector
 * [POD-701] to correlate terminal lifecycle events into client switch traces
 * without re-instrumenting session-mount. Listeners must never throw (guarded
 * anyway) and must not mutate the entry.
 */
export function onTerminalDiagnostic(listener: TerminalDiagnosticListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const MAX_ENTRIES = 500
const entries: TerminalDiagnosticEntry[] = []
let nextMount = 0
let consoleOverride: boolean | undefined

function consoleEnabled(): boolean {
  if (consoleOverride !== undefined) return consoleOverride
  try {
    if (typeof location !== 'undefined') {
      const value = new URLSearchParams(location.search).get('terminalDebug')
      if (value === '1' || value === 'true') return true
    }
    return globalThis.localStorage?.getItem('podium.terminalDebug') === '1'
  } catch {
    return false
  }
}

function copyEntry(entry: TerminalDiagnosticEntry): TerminalDiagnosticEntry {
  return { ...entry, data: structuredClone(entry.data) }
}

export function terminalDiagnosticsSnapshot(sessionId?: string): TerminalDiagnosticEntry[] {
  return entries.filter((entry) => !sessionId || entry.sessionId === sessionId).map(copyEntry)
}

export function clearTerminalDiagnostics(): void {
  entries.length = 0
}

export function setTerminalDiagnosticsConsole(enabled: boolean): void {
  consoleOverride = enabled
}

export interface TerminalDiagnosticRecorder {
  mountId: string
  record(event: string, data?: TerminalDiagnosticData): void
}

/**
 * Create a privacy-safe terminal lifecycle recorder. It intentionally captures no
 * terminal text or keystrokes: only mount/visibility/fit/server-grid/renderer facts.
 * The bounded history remains available after an intermittent failure through
 * `globalThis.__podiumTerminalDiagnostics.snapshot()`.
 */
export function createTerminalDiagnosticRecorder(sessionId: string): TerminalDiagnosticRecorder {
  const mountId = `${Date.now().toString(36)}-${(nextMount++).toString(36)}`
  return {
    mountId,
    record(event, data = {}) {
      const entry: TerminalDiagnosticEntry = {
        at: new Date().toISOString(),
        elapsedMs:
          typeof globalThis.performance?.now === 'function'
            ? Math.round(globalThis.performance.now() * 10) / 10
            : Date.now(),
        sessionId,
        mountId,
        event,
        data,
      }
      entries.push(entry)
      if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
      for (const listener of listeners) {
        try {
          listener(entry)
        } catch {
          // a diagnostics tap must never break the terminal lifecycle
        }
      }
      if (event.startsWith('anomaly:')) console.warn('[podium terminal]', copyEntry(entry))
      else if (consoleEnabled()) console.debug('[podium terminal]', copyEntry(entry))
    },
  }
}

const diagnosticsApi: TerminalDiagnosticsApi = {
  snapshot: terminalDiagnosticsSnapshot,
  clear: clearTerminalDiagnostics,
  setConsoleEnabled: setTerminalDiagnosticsConsole,
  onTrace: onTerminalDiagnostic,
}

Object.defineProperty(globalThis, '__podiumTerminalDiagnostics', {
  value: diagnosticsApi,
  configurable: true,
})

declare global {
  // eslint-disable-next-line no-var -- global debugging API intentionally uses a var declaration.
  var __podiumTerminalDiagnostics: TerminalDiagnosticsApi | undefined
}
