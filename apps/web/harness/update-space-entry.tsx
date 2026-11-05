/** Stubbed review: channel=stable|dev, space=none|low|enough|unknown, theme=light|dark. */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { applyTheme } from '@/app/theme'
import { operationView } from '@/features/updates/operation-view'
import { UpdatePanel } from '@/features/updates/UpdatePanel'
import { UpdateSpaceReadout } from '@/features/updates/UpdateSpaceNotice'
import { UpdateSpaceView } from '@/features/updates/update-space-view'
import type { UpdateView } from '@/features/updates/update-view'
import changelog from '../../../CHANGELOG.md?raw'
import '@/index.css'
import '@/styles.css'

const params = new URLSearchParams(window.location.search)
const dev = params.get('channel') === 'dev'
const space = params.get('space') ?? 'low'
const GiB = 1024 ** 3
const summary = changelog
  .split(/^## /m)
  .find((section) => section.startsWith('[0.3.0-edge.1]'))
  ?.replace(/^[^\n]*\n/, '')
  .trim()
const commits = [
  ['cc4b495', 'Give simple issues a compact flight deck'],
  ['acb7c49', 'Polish chat image galleries and shared viewer'],
  ['8bc960c', 'Polish update states and verify release context'],
  ['91a7c0c', 'Rebuild update cards around release notes and commit history'],
  ['4e89dd1', 'Write the 0.3.0 release notes under Unreleased'],
  ['e861f21', 'Show release notes as Markdown in the update panel'],
  ['f2a2238', 'Draw blocker lines over the row text and fade the words they cross'],
  ['c67da8b', 'Bring back the flight deck’s fold-all button'],
  ['242a453', 'Tucking the task on screen returns to the new-prompt screen'],
  ['4990cce', 'Name the moved-conversation note “Where it left off”'],
  ['ca2e8cb', 'Drop the duplicated task title from the moved-conversation subtitle'],
  ['5d62fe7', 'Build the Repos settings rows from repository records'],
].map(([sha, summary]) => ({ sha: sha ?? '', summary: summary ?? '' }))
const offer: Extract<UpdateView, { state: 'available' | 'required' }> = {
  state: 'available',
  version: dev ? '0.2.0-dev.80+cc4b495' : '0.3.0',
  runningVersion: dev ? '0.2.0-dev.79+1111111' : '0.2.0',
  releasedAt: '2026-11-04',
  machineCount: 2,
  notes: { summary, url: 'https://github.com/madeinorbit/podium/releases/tag/v0.3.0' },
  ...(dev ? { branch: 'dev/mw', commits, commitCount: 28 } : {}),
  restartNote: 'Your sessions keep running.',
  places: [
    {
      kind: 'server',
      label: 'Server',
      detail: 'build-box',
      effect: 'Restarts for a few seconds; open sessions reconnect',
      impact: 'interrupts',
    },
    {
      kind: 'machines',
      label: 'build-box, laptop',
      effect: 'Update in the background; agents keep running',
      impact: 'background',
    },
    {
      kind: 'database',
      label: 'Database',
      effect: '5 schema changes, backed up first',
      impact: 'background',
    },
  ],
}
const panel = operationView({
  operation: null,
  offer,
  local: { behind: false, canReload: true, canInstallDesktop: false },
  surface: 'web',
  now: Date.UTC(2026, 10, 5),
})
const view = new UpdateSpaceView(async () => ({
  machines: [
    {
      machineId: 'build',
      name: 'build-box',
      targetVersion: offer.version,
      status: space === 'unknown' ? 'unknown' : space === 'enough' ? 'enough' : 'low',
      checkedAt: Date.now(),
      ...(space === 'unknown'
        ? { reason: 'This machine does not support disk-space estimates yet.' }
        : {}),
      volumes:
        space === 'unknown'
          ? []
          : [
              {
                path: '/var/lib/podium',
                availableBytes: space === 'enough' ? 20 * GiB : Math.floor(1.2 * GiB),
                peakBytes: 2 * GiB,
                requiredBytes: 3 * GiB,
                shortfallBytes: space === 'enough' ? 0 : Math.floor(1.8 * GiB),
              },
            ],
    },
    {
      machineId: 'laptop',
      name: 'laptop',
      targetVersion: offer.version,
      status: 'enough',
      checkedAt: Date.now(),
      volumes: [
        {
          path: '/Users/operator/Library/Application Support/Podium',
          availableBytes: 20 * GiB,
          peakBytes: 2 * GiB,
          requiredBytes: 3 * GiB,
          shortfallBytes: 0,
        },
      ],
    },
  ],
}))
void view.refresh()
applyTheme({ mode: params.get('theme') === 'light' ? 'light' : 'dark' }, document.documentElement)
function Preview() {
  const [message, setMessage] = useState('')
  return (
    <main style={{ minHeight: '100vh', background: 'var(--background)' }}>
      <UpdatePanel
        view={panel}
        pending={null}
        onAction={(action) => setMessage(`Preview action: ${action}`)}
        onHide={() => setMessage('Preview: panel hidden')}
        {...(space === 'none' ? {} : { spacePreview: <UpdateSpaceReadout view={view} /> })}
      />
      <output style={{ position: 'fixed', bottom: 0, padding: 8, fontSize: 11 }} aria-live="polite">
        {message}
      </output>
    </main>
  )
}
const root = document.getElementById('root')
if (!root) throw new Error('Harness root is missing')
createRoot(root).render(<Preview />)
