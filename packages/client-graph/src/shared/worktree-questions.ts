import { machinePathKey } from '@podium/model/browser'
import { createKeyedAnswer } from '../query-result'

type Row = Readonly<Record<string, unknown>>
interface WorktreeOrder { id: string; project: number; root: number; ordinal: number }

/** Registered lanes are never cold. Their source-stamped project order
 * maintains the fallback root without projecting repositories or lanes. */
export function createWorktreeQuestions() {
  const compare = (a: WorktreeOrder, b: WorktreeOrder) =>
    a.project - b.project || a.root - b.root || a.ordinal - b.ordinal
  let lanes = createKeyedAnswer<WorktreeOrder>(compare)
  let sequence = 0
  const paths = new Map<string, string>()
  return {
    set(id: string, row: Row | undefined) {
      if (row?.path !== id) { lanes.delete(id); if (paths.get(machinePathKey(id)) === id) paths.delete(machinePathKey(id)); return }
      paths.set(machinePathKey(id), id)
      const before = lanes.get(id)
      const ordinal = before?.ordinal ?? ++sequence
      const project = typeof row.projectIndex === 'number' ? row.projectIndex : ordinal
      const root = row.projectRoot === true ? 0 : row.isMain === true ? 1 : 2
      if (before?.project === project && before.root === root) return
      lanes.set(id, '', { id, project, root, ordinal })
    },
    path: (path: string): string | undefined => paths.get(machinePathKey(path)),
    clear() { paths.clear(); lanes = createKeyedAnswer<WorktreeOrder>(compare); sequence = 0 },
    first(): string | null { return lanes.first()?.id ?? null },
  }
}
