import { omitGone } from './lookup'
import { asIssueId, type IssueId, type IssueStage } from '@podium/model/browser'
import { parseAnyRef } from '@podium/protocol'
import type { MobxPool } from './pool'
import { createPoolProjection } from './pool-projection'
import { LOADING, type Loaded } from './worklist/rollup'

export interface TerminalReferences {
  setActive(active: boolean): void
  beginPaint(): void
  endPaint(): void
  isKnownPrefix(prefix: string): boolean
  resolveStage(token: string): IssueStage | null
  issueId(token: string): IssueId | undefined
  subscribe(paint: () => void): () => void
  dispose(): void
}
function issueToken(token: string): string | undefined {
  const parsed = parseAnyRef(token.trim())
  return parsed?.kind === 'issue' ? `${parsed.prefix}-${parsed.seq}` : undefined
}
function referenceRow(pool: MobxPool, token: string) {
  const key = issueToken(token)
  const id = key === undefined ? undefined : pool.queries.issueReferenceId(key)
  if (id === undefined) return undefined
  const row = omitGone(pool.row('issue', id, 'summary-fields')) as Loaded<{ stage: IssueStage; deletedAt?: string }>
  return !row || row === LOADING || row.deletedAt ? undefined : { id, stage: row.stage }
}
/** Clicks borrow current source identity and one named summary, retaining no
 * catalog or demand after the action. Deleted tasks have no destination. */
export function terminalIssueId(pool: MobxPool, token: string): IssueId | undefined {
  const row = referenceRow(pool, token)
  return row ? asIssueId(row.id) : undefined
}

interface PaintedAnswer<T> { read(): T; dispose(): void }
/** The viewport declares its prefixes and issue tokens each paint. Only those
 * pool questions retain observers; scrolling releases the previous band. */
export function createTerminalReferences(pool: MobxPool): TerminalReferences {
  const changes = new Set<() => void>()
  const prefixes = new Map<string, PaintedAnswer<boolean>>()
  const stages = new Map<string, PaintedAnswer<IssueStage | null>>()
  const seenPrefixes = new Set<string>(), seenStages = new Set<string>()
  let painting = false, disposed = false, active = true
  function read<T>(answers: Map<string, PaintedAnswer<T>>, seen: Set<string>, key: string, question: (pool: MobxPool) => T): T {
    if (!painting) return question(pool)
    seen.add(key)
    let answer = answers.get(key)
    if (!answer) {
      const projection = createPoolProjection(pool, question)
      const stop = projection.subscribe(() => { for (const paint of changes) paint() })
      answer = { read: projection.getSnapshot, dispose: () => { stop(); projection.dispose() } }
      answers.set(key, answer)
    }
    return answer.read()
  }
  function releaseAbsent<T>(answers: Map<string, PaintedAnswer<T>>, seen: Set<string>) {
    for (const [key, answer] of answers) if (!seen.has(key)) {
      answer.dispose(); answers.delete(key)
    }
  }
  return {
    setActive(next) {
      if (disposed || active === next) return
      active = next
      if (!active) {
        painting = false; seenPrefixes.clear(); seenStages.clear()
        releaseAbsent(prefixes, seenPrefixes); releaseAbsent(stages, seenStages)
      }
      for (const paint of changes) paint()
    },
    beginPaint() {
      if (disposed || !active) return
      painting = true; seenPrefixes.clear(); seenStages.clear()
    },
    endPaint() {
      if (disposed) return
      painting = false
      releaseAbsent(prefixes, seenPrefixes); releaseAbsent(stages, seenStages)
    },
    isKnownPrefix(prefix) {
      return !disposed && active && read(prefixes, seenPrefixes, prefix, pool => pool.queries.hasIssuePrefix(prefix))
    },
    resolveStage(token) {
      const key = issueToken(token)
      if (disposed || !active || key === undefined) return null
      return read(stages, seenStages, key, pool => referenceRow(pool, key)?.stage ?? null)
    },
    issueId: token => disposed ? undefined : terminalIssueId(pool, token),
    subscribe(paint) {
      if (disposed) return () => {}
      changes.add(paint)
      return () => { changes.delete(paint) }
    },
    dispose() {
      disposed = true; painting = false
      for (const answer of prefixes.values()) answer.dispose()
      for (const answer of stages.values()) answer.dispose()
      prefixes.clear(); stages.clear(); seenPrefixes.clear(); seenStages.clear(); changes.clear()
    },
  }
}
