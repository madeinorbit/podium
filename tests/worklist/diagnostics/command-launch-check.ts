import { launchRepositoryFacts, machineFacts } from '@podium/client-graph/test-support/launch-repository-facts.test.fixture'
/** The command palette and launcher's pool data as one comparable snapshot.
 * Row values stay in process; reports contain counts and positions. */

import type { SessionView } from '@podium/client-core/session-values'
import { COMMAND_SUMMARIES } from '@podium/client-graph/command-launch-schema'
import { type CommandLaunchData, commandLaunchViews } from '@podium/client-graph/command-launch-views'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import type { CheckRow, SidebarSnapshot } from './sidebar-check'

const fields = (value: object, keys: readonly string[]) =>
  Object.fromEntries(keys.map((key) => [key, (value as Record<string, unknown>)[key] ?? null]))
const issueFields = COMMAND_SUMMARIES.issue.filter((key) => key !== 'displayRef')
function snapshot(
  data: Pick<
    CommandLaunchData,
    | 'repos'
    | 'repoViews'
    | 'machines'
    | 'issues'
    | 'repoChoices'
    | 'initialRepoPath'
    | 'spawnTargets'
  > &
    Partial<CommandLaunchData> & { sessions: SessionView[] },
): SidebarSnapshot {
  const issueRows: CheckRow[] = data.issues.map((issue) => ({
    id: issue.id,
    fields: { ...fields(issue, issueFields), displayRef: issue.displayRef ?? `#${issue.seq}` },
  }))
  const selected = data.issues.find(
    (issue) => issue.id === (data.openIssueId ?? data.selectedIssueId),
  )
  return {
    pending: data.pending ?? 0,
    sections: [
      {
        key: 'window',
        fields: fields(data, [
          'paletteOpen',
          'pins',
          'selectedIssueId',
          'openIssueId',
          'selectedWorktree',
          'paneA',
          'recentFiles',
          'sidebarSettings',
        ]),
        rows: [],
      },
      {
        key: 'repos',
        fields: {},
        rows: data.repoViews.map((repo) => ({ id: repo.path, fields: { value: launchRepositoryFacts(repo) } })),
      },
      {
        key: 'machines',
        fields: {},
        rows: data.machines.map((machine) => ({ id: machine.id, fields: { value: machineFacts(machine) } })),
      },
      {
        key: 'sessions',
        fields: {},
        rows: data.sessions.map((session) => ({
          id: session.sessionId,
          fields: fields(session, [...COMMAND_SUMMARIES.session, 'agentState']),
        })),
      },
      { key: 'issues', fields: {}, rows: issueRows },
      {
        key: 'selected',
        fields: selected
          ? fields(selected, [
              'id',
              'unread',
              'readAt',
              'memberSessionIds',
              'childCount',
              'childDoneCount',
              'gitState',
              'needsHuman',
              'blocked',
              'stage',
              'closedReason',
            ])
          : { id: null },
        rows: [],
      },
      {
        key: 'repoChoices',
        fields: { initialRepoPath: data.initialRepoPath },
        rows: data.repoChoices.map((repo) => ({
          id: JSON.stringify([repo.machineId ?? '', repo.path]),
          fields: {},
        })),
      },
      {
        key: 'spawn',
        fields: {},
        rows: data.spawnTargets.map((tree) => ({
          id: tree.path,
          fields: fields(tree, ['path', 'repoPath', 'repoId', 'machineId', 'placement']),
        })),
      },
    ],
  }
}
export function poolCommandLaunchSnapshot(pool: MobxPool): SidebarSnapshot {
  const views = commandLaunchViews(pool), data = views.palette()
  if (!data || data === LOADING) return { pending: 1, sections: [] }
  const rows = data.sessionIds.map(id => views.session(id))
  return snapshot({ ...data,
    sessions: rows.filter((row): row is SessionView => !!row && row !== LOADING),
    pending: data.pending + rows.filter(row => row === LOADING).length,
  })
}
