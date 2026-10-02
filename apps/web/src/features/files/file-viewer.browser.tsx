/** Real surfaces over one offline runtime and its existing pool. Synthetic only. */
import type { ClientRuntime } from '@podium/client-core/engine'
import { storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { writeFilePanelMode } from '@podium/client-core/ui-state'
import { asUserId } from '@podium/model/browser'
import { Profiler, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { attachWorklistPool, useWorklistPool } from '@/app/store-worklist-pool'
import { preferenceReadStats, preferencesDataLayer } from '@/lib/preferences-data-layer'
import { DiffSheet } from '../git/DiffSheet'
import { GitPanelView } from '../git/GitPanelView'
import { parseStatus } from '../git/git-panel'
import { FileBrowserModal } from './FileBrowserModal'
import { FilePanel } from './FilePanel'
import { checkFileViewerPreferences } from './file-viewer-check'
import {
  createFileViewerFixture,
  VIEWER_FILES,
  VIEWER_SCOPE,
  VIEWER_TABS,
} from './file-viewer-fixture'
import { WorktreeFileTree } from './WorktreeFileTree'
import '@/index.css'

const fixture = createFileViewerFixture(5600, 5014),
  failures: string[] = []
let owner!: ClientRuntime,
  pool: ReturnType<typeof useWorklistPool> = null
let ready = false,
  commits = 0,
  commitMs = 0
let browse = (_open: boolean) => {},
  review = (_open: boolean) => {}
storeStats.enable()
preferenceReadStats.enable()

function Surface() {
  owner = useStoreHandle() as ClientRuntime
  const currentPool = useWorklistPool()
  pool = currentPool
  const [browsing, setBrowsing] = useState(false),
    [reviewing, setReviewing] = useState(false)
  browse = setBrowsing
  review = setReviewing
  useEffect(() => {
    ready = preferencesDataLayer() === 'legacy' || currentPool !== null
    return () => {
      ready = false
    }
  }, [currentPool])
  return (
    <main style={{ padding: 20 }}>
      <h1>File and Git viewers</h1>
      <p>5,600 synthetic tasks · 5,014 sessions</p>
      <Profiler
        id="viewers"
        onRender={(_id, _phase, ms) => {
          commits++
          commitMs += ms
        }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
          {VIEWER_FILES.map(({ path }) => (
            <section
              key={path}
              data-file-viewer={path}
              style={{ height: 320, overflow: 'hidden', border: '1px solid #444' }}
            >
              <FilePanel scope={VIEWER_SCOPE} path={path} onClose={() => {}} />
            </section>
          ))}
          <section style={{ height: 180 }}>
            <FilePanel
              scope={VIEWER_SCOPE}
              path="/synthetic/project/plain.txt"
              onClose={() => {}}
            />
          </section>
          <section style={{ height: 180 }}>
            <FilePanel scope={VIEWER_SCOPE} path="/synthetic/project/data.csv" onClose={() => {}} />
          </section>
          <section style={{ height: 180 }}>
            <FilePanel
              scope={VIEWER_SCOPE}
              path="/synthetic/project/audio.mp3"
              onClose={() => {}}
            />
          </section>
          <section style={{ height: 160 }}>
            <WorktreeFileTree root="/synthetic/project" />
          </section>
          <section style={{ height: 160 }}>
            <GitPanelView cwd="/synthetic/project" />
          </section>
        </div>
        {browsing && (
          <FileBrowserModal
            root="/synthetic/project"
            title="Synthetic files"
            onClose={() => setBrowsing(false)}
          />
        )}
        {reviewing && (
          <DiffSheet
            cwd="/synthetic/project"
            entries={parseStatus('## main\n M changed.ts\n?? untracked.txt').entries}
            initialPath="changed.ts"
            onClose={() => setReviewing(false)}
            onRefresh={() => {}}
            refreshing={false}
          />
        )}
      </Profiler>
    </main>
  )
}
const host = document.getElementById('root')
if (!host) throw new Error('Missing viewer fixture mount')
const root = createRoot(host)
root.render(
  <StoreProvider
    principal={asClientPrincipal(asUserId('viewer-synthetic'))}
    config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
    api={fixture.api}
    createReplicaFn={() => fixture.newReplica()}
    networkEnabled={false}
    onFatalError={(error) => failures.push(error)}
    attachRuntime={(runtime) => {
      fixture.bindHub(runtime.hub)
      return attachWorklistPool(runtime, (error) => failures.push(error.message))
    }}
  >
    <Surface />
  </StoreProvider>,
)
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const driver = {
  ready: () => ready,
  reset() {
    storeStats.reset()
    preferenceReadStats.reset()
    commits = 0
    commitMs = 0
  },
  async activity() {
    for (let step = 1; step <= 200; step++) fixture.activity(step)
    await frame()
  },
  async preferences() {
    for (let step = 0; step < 20; step++) {
      for (const tab of VIEWER_TABS)
        writeFilePanelMode(owner.ui, tab.mapKey, tab.tabId, step % 2 ? 'preview' : 'source')
      await frame()
    }
    await frame()
  },
  async utilities() {
    browse(true)
    await frame()
    browse(false)
    review(true)
    await frame()
    await frame()
  },
  closeUtilities() {
    review(false)
  },
  snapshot: () =>
    Array.from(document.querySelectorAll('[data-file-viewer]')).map((element) => ({
      buttons: Array.from(element.querySelectorAll('button[aria-pressed]')).map((button) => ({
        label: button.getAttribute('aria-label'),
        pressed: button.getAttribute('aria-pressed'),
      })),
      preview: element.querySelector('iframe')?.getAttribute('srcdoc') ?? null,
      editor: Array.from(element.querySelectorAll('.cm-content')).map(
        (editor) => editor.textContent,
      ),
    })),
  stats() {
    const rows = storeStats.snapshot().runtimes
    return {
      selectors: rows.reduce((sum, row) => sum + row.selectorRuns, 0),
      wakes: rows.reduce((sum, row) => sum + row.subscriberWakes, 0),
      legacyDerivations: rows.reduce(
        (sum, row) => sum + Object.values(row.slices).reduce((a, n) => a + n, 0),
        0,
      ),
      ...preferenceReadStats.read(owner),
      pool: pool?.preferenceCounts(),
      commits,
      commitMs,
      failures,
      calls: {
        read: fixture.calls.read.length,
        write: fixture.calls.write.length,
        list: fixture.calls.list.length,
        git: fixture.calls.git.length,
      },
    }
  },
  async check() {
    if (!pool) return null
    checkFileViewerPreferences(pool, owner.ui, VIEWER_TABS)
    await frame()
    return checkFileViewerPreferences(pool, owner.ui, VIEWER_TABS)
  },
  close: () => root.unmount(),
}
Object.assign(window, { __fileViewers: driver })
declare global {
  interface Window {
    __fileViewers: typeof driver
  }
}
