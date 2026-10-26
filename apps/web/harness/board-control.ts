import { omitGone } from '@podium/client-graph/lookup'
import { referenceState } from '../../../tests/worklist/diagnostics/reference-state'
import type { ClientRuntime } from '@podium/client-core/engine'

import { allIssueViewModels } from '../../../tests/worklist/diagnostics/reference/issue-view-models'
import type { MobxPool } from '@podium/client-graph'
import {
  boardSnapshot,
  compareBoardValues,
  readBoardSnapshot,
} from '../../../tests/worklist/diagnostics/issue-board-check'
import type { BoardOptions, BoardSnapshotData } from '@podium/client-graph/issue-board-schema'
import { DEFAULT_DISPLAY } from '../src/features/issues/issues-display'
import { deriveIssuesViewModel } from '../src/features/issues/issues-view-model'

export function checkBoard(runtime: ClientRuntime, pool: MobxPool, options: BoardOptions) {
  const issues = allIssueViewModels(runtime.replica),
    sessions = referenceState(runtime).sessions
  const expected = deriveIssuesViewModel({
    ...options,
    now: options.now ?? pool.clock.current,
    openIssueId: options.openIssueId ?? null,
    issues,
    sessions,
    display: { ...DEFAULT_DISPLAY, ...options.display },
    expanded: new Set(options.expanded),
  })
  const paths = [...new Set(issues.map((row) => row.repoPath).filter(Boolean))].sort((a, b) =>
    (a.split('/').pop() || a).localeCompare(b.split('/').pop() || b),
  )
  const actual = readBoardSnapshot(pool, options)
  return !actual || typeof actual === 'symbol'
    ? { differences: 0, pending: 1, first: null }
    : compareBoardValues(
        boardSnapshot({ issues, sessions, projectPaths: paths, view: expected } as BoardSnapshotData),
        actual,
      )
}
