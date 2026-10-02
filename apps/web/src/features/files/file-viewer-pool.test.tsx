import type { ClientRuntime } from '@podium/client-core/engine'
import { storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import {
  createRoutedUiState,
  DIFF_SHEET_WRAP_KEY,
  HTML_MODE_MAP_KEY,
  JSON_MODE_MAP_KEY,
  MD_MODE_MAP_KEY,
  writeFilePanelMode,
} from '@podium/client-core/ui-state'
import type { FileScope } from '@podium/client-core/viewmodels'
import { MobxPool } from '@podium/client-graph'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { asArtifactId, asIssueId, asSessionId, asUserId } from '@podium/model'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { attachWorklistPool, useWorklistPool } from '@/app/store-worklist-pool'
import { preferenceReadStats } from '@/lib/preferences-data-layer'
import { DiffSheet } from '../git/DiffSheet'
import { GitPanelView } from '../git/GitPanelView'
import { parseStatus } from '../git/git-panel'
import { FileBrowserModal } from './FileBrowserModal'
import { FilePanel } from './FilePanel'
import { checkFileViewerPreferences, FILE_VIEWER_PREFERENCE_KEYS } from './file-viewer-check'
import {
  createFileViewerFixture,
  VIEWER_FILES,
  VIEWER_SCOPE,
  VIEWER_TABS,
} from './file-viewer-fixture'
import { useFileDocument } from './useFileDocument'
import { WorktreeFileTree } from './WorktreeFileTree'

vi.mock('@/lib/preferences-data-layer', async (original) => ({
  ...(await original<typeof import('@/lib/preferences-data-layer')>()),
  preferencesDataLayer: () => 'pool',
}))
// Editor rendering is covered by its existing tests and the real-browser proof.
vi.mock('./SourceEditor', () => ({
  SourceEditor: ({
    path,
    initialContent,
    editable,
    onChange,
  }: {
    path: string
    initialContent: string
    editable: boolean
    onChange: (value: string) => void
  }) => (
    <textarea
      aria-label={path}
      defaultValue={initialContent}
      readOnly={!editable}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}))
vi.mock('@/lib/hooks/use-is-mobile', () => ({ useIsMobile: () => false }))

afterEach(() => {
  cleanup()
  storeStats.enable(false)
  preferenceReadStats.enable(false)
  vi.restoreAllMocks()
})
const counts = () =>
  storeStats
    .snapshot()
    .runtimes.reduce(
      (sum, row) =>
        sum + row.selectorRuns + Object.values(row.slices).reduce((n, count) => n + count, 0),
      0,
    )

it('compares all file modes through declared, batched preference rows, including corrupt and missing maps', async () => {
  const values = new Map<string, string>(),
    listeners = new Set<() => void>()
  const port = {
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string | null) => {
      value === null ? values.delete(key) : values.set(key, value)
      for (const wake of listeners) wake()
    },
    subscribe: (wake: () => void) => {
      listeners.add(wake)
      return () => {
        listeners.delete(wake)
      }
    },
    hydrate: async () => {},
    clear: (key: string) => {
      values.delete(key)
      for (const wake of listeners) wake()
    },
  }
  const ui = createRoutedUiState({ local: port, replicated: port }),
    pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const tabs = [HTML_MODE_MAP_KEY, JSON_MODE_MAP_KEY, MD_MODE_MAP_KEY].flatMap((mapKey) =>
    Array.from({ length: 200 }, (_, index) => ({
      mapKey,
      tabId: `file:synthetic:${index}`,
      fallback: 'source' as const,
    })),
  )
  try {
    pool.attachPreferences(ui)
    for (const key of FILE_VIEWER_PREFERENCE_KEYS) expect(pool.row('preference', key)).toBe(LOADING)
    expect(checkFileViewerPreferences(pool, ui, tabs)).toMatchObject({ pending: 4, positions: 604 })
    await Promise.resolve()
    expect(pool.preferenceCounts()).toMatchObject({ batches: 1, loaded: 4 })
    for (const map of [
      null,
      '{corrupt',
      '[]',
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 200 }, (_, i) => [
            `file:synthetic:${i}`,
            ['preview', 'source', 'split', 'invalid'][i % 4],
          ]),
        ),
      ),
    ]) {
      for (const key of [HTML_MODE_MAP_KEY, JSON_MODE_MAP_KEY, MD_MODE_MAP_KEY]) ui.set(key, map)
      ui.set(DIFF_SHEET_WRAP_KEY, map === null ? null : 'false')
      await Promise.resolve()
      expect(checkFileViewerPreferences(pool, ui, tabs)).toEqual({
        differences: 0,
        pending: 0,
        positions: 604,
        first: null,
      })
    }
    const read = pool.row.bind(pool)
    vi.spyOn(pool, 'row').mockImplementation(((entity: never, id: string) => {
      const row = read(entity, id)
      return row && typeof row === 'object' ? { ...row, value: 'planted mismatch' } : row
    }) as typeof pool.row)
    expect(checkFileViewerPreferences(pool, ui, tabs).differences).toBeGreaterThan(0)
  } finally {
    pool.dispose()
  }
})

it('mounts actual file and Git surfaces with zero legacy derivations and adopts late file modes', async () => {
  const fixture = createFileViewerFixture(),
    failures: string[] = [],
    owners = new Set<ClientRuntime>()
  let owner!: ClientRuntime,
    pool: MobxPool | null = null
  function Surfaces() {
    owner = useStoreHandle() as ClientRuntime
    owners.add(owner)
    pool = useWorklistPool()
    return (
      <>
        {VIEWER_FILES.map(({ path }) => (
          <section key={path} data-testid={path}>
            <FilePanel scope={VIEWER_SCOPE} path={path} onClose={() => {}} />
          </section>
        ))}
        <FilePanel scope={VIEWER_SCOPE} path="/synthetic/project/plain.txt" onClose={() => {}} />
        <FilePanel scope={VIEWER_SCOPE} path="/synthetic/project/data.csv" onClose={() => {}} />
        <FilePanel scope={VIEWER_SCOPE} path="/synthetic/project/audio.mp3" onClose={() => {}} />
        <WorktreeFileTree root="/synthetic/project" />
        <FileBrowserModal root="/synthetic/project" title="Files" onClose={() => {}} />
        <GitPanelView cwd="/synthetic/project" />
        <DiffSheet
          cwd="/synthetic/project"
          entries={parseStatus('## main\n M changed.ts\n?? untracked.txt').entries}
          initialPath="changed.ts"
          onClose={() => {}}
          onRefresh={() => {}}
          refreshing={false}
        />
      </>
    )
  }
  storeStats.enable()
  storeStats.reset()
  preferenceReadStats.enable()
  preferenceReadStats.reset()
  const view = render(
    <StoreProvider
      principal={asClientPrincipal(asUserId('file-reader'))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      api={fixture.api}
      networkEnabled={false}
      createReplicaFn={() => fixture.newReplica()}
      onFatalError={(error) => failures.push(error)}
      attachRuntime={(runtime) =>
        attachWorklistPool(runtime, (error) => failures.push(error.message))
      }
    >
      <Surfaces />
    </StoreProvider>,
  )
  await waitFor(() => {
    expect(pool).not.toBeNull()
    expect(view.container.querySelector('iframe')).not.toBeNull()
    expect(fixture.calls.git.length).toBeGreaterThanOrEqual(3)
  })
  await act(async () => {})
  expect(owners.size).toBe(1)
  for (const key of [HTML_MODE_MAP_KEY, JSON_MODE_MAP_KEY, MD_MODE_MAP_KEY])
    expect(owner.ui.get(key)).toBeNull()
  await act(async () => {
    for (const tab of VIEWER_TABS) writeFilePanelMode(owner.ui, tab.mapKey, tab.tabId, 'source')
  })
  // Utility dialogs intentionally hide the surrounding mounted file panels.
  for (const { path } of VIEWER_FILES)
    expect(
      within(view.getByTestId(path)).getByRole('textbox', { name: path, hidden: true }),
    ).toBeTruthy()
  const attachedPool = pool as MobxPool | null
  if (!attachedPool) throw new Error('Pool did not attach')
  expect(checkFileViewerPreferences(attachedPool, owner.ui, VIEWER_TABS)).toMatchObject({
    differences: 0,
    pending: 0,
    positions: 7,
  })
  await act(async () => {
    for (let step = 1; step <= 20; step++) fixture.activity(step)
  })
  expect(counts()).toBe(0)
  expect(preferenceReadStats.read(owner).legacyReads).toBe(0)
  expect(fixture.calls.write).toEqual([])
  expect(failures).toEqual([])
})

it('keeps scoped read and write ownership, base hashes, and immutable artifact documents', async () => {
  const fixture = createFileViewerFixture()
  const scopes: [FileScope, FileScope, FileScope] = [
    { kind: 'session', sessionId: asSessionId('synthetic-session-0') },
    VIEWER_SCOPE,
    { kind: 'artifact', issueId: asIssueId('synthetic-0'), artifactId: asArtifactId('snapshot') },
  ]
  function Document({ scope }: { scope: FileScope }) {
    const doc = useFileDocument(scope, '/file.txt')
    return (
      <>
        <span>{doc.status}</span>
        <input
          aria-label="Document"
          value={doc.content}
          onChange={(event) => doc.setContent(event.target.value)}
        />
        <button type="button" onClick={() => void doc.save()}>Save document</button>
        <span>{doc.saveFeedback?.message}</span>
      </>
    )
  }
  const tree = (scope: FileScope) => (
    <StoreProvider
      principal={asClientPrincipal(asUserId('file-writer'))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      api={fixture.api}
      networkEnabled={false}
      createReplicaFn={() => fixture.newReplica()}
      onFatalError={() => {}}
    >
      <Document scope={scope} />
    </StoreProvider>
  )
  const view = render(tree(scopes[0]))
  for (const [index, scope] of scopes.entries()) {
    if (index) view.rerender(tree(scope))
    await waitFor(() => expect(view.getByText('ready')).toBeTruthy())
    fireEvent.change(view.getByRole('textbox', { name: 'Document' }), {
      target: { value: 'edited' },
    })
    fireEvent.click(view.getByRole('button', { name: 'Save document' }))
    if (scope.kind !== 'artifact') await waitFor(() => expect(view.getByText('Saved')).toBeTruthy())
    const routed =
      scope.kind === 'session'
        ? { sessionId: scope.sessionId }
        : scope.kind === 'artifact'
          ? { issueId: scope.issueId, artifactId: scope.artifactId }
          : { root: scope.root, machineId: scope.machineId }
    expect(fixture.calls.read.at(-1)).toEqual({ ...routed, path: '/file.txt' })
    expect(fixture.calls.write).toHaveLength(Math.min(index + 1, 2))
    if (scope.kind !== 'artifact')
      expect(fixture.calls.write.at(-1)).toEqual({
        ...routed,
        path: '/file.txt',
        content: 'edited',
        baseHash: 'original',
      })
  }
})
