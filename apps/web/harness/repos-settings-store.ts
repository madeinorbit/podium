/**
 * SETTINGS → Projects, REAL, WITH NO SERVER (POD-6267).
 *
 * The section reads the shared pool through `useWorklistPool` and writes
 * through `useSettingsTrpc`; `vite.repos-settings-harness.config.ts` points both
 * imports here. The pool is a real `MobxPool` fed the scan, repo and machine
 * rows a two-machine install really reports, so what renders is the shipping
 * `SettingsRepositories` grouping, not a picture of it. A prefix save writes
 * the new prefix back into the pool, so the editor can be driven end to end.
 *
 * `?scene=` picks the data: `full` (default), `single`, `empty`, `loading`.
 */
import { headerEntities } from '@podium/client-graph/header-entities'
import { MobxPool } from '@podium/client-graph/pool'
import type { GitRepositoryWire } from '@podium/model'
import { asMachineId, asRepoId } from '@podium/model/browser'

export type SceneName = 'full' | 'single' | 'empty' | 'loading'

export const sceneName = (): SceneName => {
  const value = new URLSearchParams(location.search).get('scene')
  return value === 'single' || value === 'empty' || value === 'loading' ? value : 'full'
}

const ludovico = asMachineId('m-ludovico')
const flatblock = asMachineId('m-flatblock')
const polaris = asMachineId('m-polaris')
const podium = asRepoId('repo-podium')
const site = asRepoId('repo-site')
const infra = asRepoId('repo-infra')
const notes = asRepoId('repo-notes')
const ORIGIN = 'git@github.com:podium-hq/podium.git'

/** Task worktrees the way `podium issue start` names them, beside the root. */
const TASKS = [
  ['6002-pairing', 'pod-6002-mobile-pairing'],
  ['6007', 'fix/6007-superagent-account'],
  ['6114', 'pod-6114-quota-ledger'],
  ['6140', 'pod-6140-server-data'],
  ['6155', 'pod-6155-api-removal'],
  ['6186', 'pod-6186-offline-cache'],
  ['6212', 'pod-6212-deck-filters'],
  ['6225', 'pod-6225-ref-miniview'],
  ['6236', 'pod-6236-transcript-window'],
  ['6240', 'pod-6240-artifact-tabs'],
  ['6246', 'pod-6246-lane-feed'],
  ['6257', 'pod-6266-desktop-log-relay'],
  ['6263', 'pod-6263-backup-locks'],
  ['6267', 'pod-6267-repos-settings'],
] as const
const taskWorktrees = TASKS.map(([dir, branch], i) => ({
  path: `/home/mgw/src/other/podium-${dir}`,
  branch,
  ...(i === 3 ? { prunable: true } : {}),
}))

function scans(scene: SceneName): GitRepositoryWire[] {
  if (scene === 'empty' || scene === 'loading') return []
  const root: GitRepositoryWire = {
    kind: 'repository',
    machineId: ludovico,
    repoId: podium,
    originUrl: ORIGIN,
    path: '/home/mgw/src/other/podium',
    branch: 'main',
    worktrees: [...taskWorktrees, { path: '/home/mgw/src/other/podium-dev-mw', branch: 'dev/mw' }],
  }
  if (scene === 'single') return withScannedWorktrees([root])
  return withScannedWorktrees([
    root,
    {
      kind: 'repository',
      machineId: flatblock,
      repoId: podium,
      originUrl: 'https://github.com/podium-hq/podium.git',
      path: '/home/mgw/podium',
      branch: 'dev/mw',
      worktrees: [
        { path: '/home/mgw/podium-test-6236', branch: 'test-6236' },
        { path: '/home/mgw/podium-test-6240', branch: 'test-6240' },
      ],
    },
    {
      kind: 'repository',
      machineId: ludovico,
      repoId: site,
      originUrl: 'https://github.com/podium-hq/podium.do.git',
      path: '/home/mgw/src/podium.do',
      branch: 'main',
      worktrees: [{ path: '/home/mgw/src/podium.do-pricing', branch: 'pricing-page' }],
    },
    {
      kind: 'bare',
      machineId: polaris,
      repoId: infra,
      originUrl: 'git@github.com:podium-hq/infra.git',
      path: '/srv/git/infra.git',
      worktrees: [],
    },
    {
      kind: 'repository',
      machineId: ludovico,
      repoId: notes,
      path: '/home/mgw/notes',
      branch: 'main',
      worktrees: [],
    },
  ])
}

/**
 * What `scanReposAll` publishes beside each registered root: the scanner also
 * reports every linked worktree as a scan of its own (harness discovery
 * `withRegisteredWorktrees` -> `toWorktreeRepository`): path, branch, the root's
 * remote, and no repo id, because only the registered root gets one. This is
 * the shape the old page listed as dozens of repositories.
 */
function withScannedWorktrees(roots: GitRepositoryWire[]): GitRepositoryWire[] {
  return roots.flatMap((root) => [
    root,
    ...(root.kind === 'worktree' ? [] : root.worktrees).map(
      (tree): GitRepositoryWire => ({
        kind: 'worktree',
        ...(root.machineId ? { machineId: root.machineId } : {}),
        path: tree.path,
        ...(tree.branch ? { branch: tree.branch } : {}),
        ...(root.originUrl ? { originUrl: root.originUrl } : {}),
        worktrees: [],
      }),
    ),
  ])
}

function buildPool(scene: SceneName): MobxPool | null {
  if (scene === 'loading') return null
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  pool.apply({
    type: 'update',
    rows: [
      {
        kind: 'repo',
        id: podium,
        value: {
          id: podium,
          prefix: 'POD',
          defaultParentBranch: 'dev/mw',
          path: '/home/mgw/src/other/podium',
        } as never,
      },
      {
        kind: 'repo',
        id: site,
        value: {
          id: site,
          prefix: 'WEB',
          defaultParentBranch: null,
          path: '/home/mgw/src/podium.do',
        } as never,
      },
      {
        kind: 'repo',
        id: infra,
        value: {
          id: infra,
          prefix: 'OPS',
          defaultParentBranch: 'production',
          path: '/srv/git/infra.git',
        } as never,
      },
      {
        kind: 'repo',
        id: notes,
        value: {
          id: notes,
          prefix: null,
          defaultParentBranch: null,
          path: '/home/mgw/notes',
        } as never,
      },
    ],
  })
  const rows = scans(scene)
  headerEntities(pool).apply([
    {
      kind: 'machine',
      id: ludovico,
      value: { id: ludovico, name: 'ludovico', online: true } as never,
    },
    {
      kind: 'machine',
      id: flatblock,
      value: { id: flatblock, name: 'flatblock', online: true } as never,
    },
    {
      kind: 'machine',
      id: polaris,
      value: { id: polaris, name: 'polaris', online: false } as never,
    },
    ...rows.map((value, i) => ({ kind: 'repository' as const, id: `scan${i}`, value })),
  ])
  headerEntities(pool).order(
    'repository',
    rows.map((_, i) => `scan${i}`),
  )
  return pool
}

const pool = buildPool(sceneName())

export const useWorklistPool = (): MobxPool | null => pool

/** The one write the section makes, answered the way the server answers it. */
const trpc = {
  repos: {
    setPrefix: {
      async mutate(input: { path: string; prefix: string }) {
        await new Promise((resolve) => setTimeout(resolve, 350))
        if (input.prefix === 'WEB') throw new Error('Prefix WEB is already used by podium.do.')
        const scan = scans(sceneName()).find((row) => row.path === input.path)
        const repoId = scan?.repoId
        if (!pool || !repoId) throw new Error('No repository at that path.')
        const repo = pool.row('repo', repoId) as Record<string, unknown>
        pool.apply({
          type: 'update',
          rows: [{ kind: 'repo', id: repoId, value: { ...repo, prefix: input.prefix } as never }],
        })
        return []
      },
    },
  },
}

export const useSettingsTrpc = () => trpc as never
