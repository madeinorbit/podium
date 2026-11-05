import { createRoot } from 'react-dom/client'
import { applyTheme } from '@/app/theme'
import { UpdatePanel } from '@/features/updates/UpdatePanel'
import { UpdateSpaceReadout } from '@/features/updates/UpdateSpaceNotice'
import { UpdateSpaceView } from '@/features/updates/update-space-view'
import '@/index.css'
import '@/styles.css'

const GiB = 1024 ** 3
const view = new UpdateSpaceView(async () => ({
  machines: [
    {
      machineId: 'build',
      name: 'build-box',
      targetVersion: '0.4.3',
      status: 'low',
      checkedAt: Date.now(),
      volumes: [
        {
          path: '/var/lib/podium',
          availableBytes: Math.floor(1.2 * GiB),
          peakBytes: 2 * GiB,
          requiredBytes: 3 * GiB,
          shortfallBytes: Math.floor(1.8 * GiB),
        },
      ],
    },
    {
      machineId: 'laptop',
      name: 'laptop',
      targetVersion: '0.4.3',
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
applyTheme({ mode: 'dark' }, document.documentElement)
const root = document.getElementById('root')
if (!root) throw new Error('Harness root is missing')
createRoot(root).render(
  <div style={{ minHeight: '100vh', background: 'var(--background)' }}>
    <UpdatePanel
      view={{
        state: 'offer',
        title: 'Update available',
        version: '0.4.3',
        subtitle: 'Your machines will restart briefly.',
        steps: [],
        awaitingElsewhere: [],
        places: [
          { kind: 'machines', label: 'build-box and laptop', effect: 'Update in the background' },
        ],
        primary: { kind: 'start', label: 'Update now', pendingLabel: 'Starting…' },
        indicator: 'idle-dot',
        indicatorLabel: 'Update available',
      }}
      pending={null}
      onAction={() => {}}
      onHide={() => {}}
      spacePreview={<UpdateSpaceReadout view={view} />}
    />
  </div>,
)
