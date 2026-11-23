/**
 * THE ADD-REPOSITORY PICKER, REAL, IN A BROWSER (POD-6869).
 *
 * `bunx vite --config vite.repo-picker-harness.config.ts` in apps/web, then open
 * `/harness/repo-picker.html`. Mounts the SHIPPING `RepoPickerModal` the way
 * Settings → Projects embeds it. `?theme=light` opens the Paper appearance;
 * `?source=github` opens the clone-from-GitHub source.
 */
import { asMachineId } from '@podium/model/browser'
import { createRoot } from 'react-dom/client'
import { RepoPickerModal } from '@/features/setup/RepoPickerModal'
import '@/index.css'
import '@/styles.css'

const params = new URLSearchParams(location.search)
const machine = {
  id: asMachineId('laptop'),
  name: 'laptop',
  hostname: 'laptop',
  online: true,
  serviceAssignment: { server: false, agentExecution: true },
  availability: { epoch: 'boot-1', server: false, daemon: true, supervisor: true },
  inventory: { os: 'linux' as const, arch: 'x64' as const, agents: [], tools: [] },
}
const noop = async (): Promise<void> => {}

document.documentElement.setAttribute('data-theme', 'podium')
document.documentElement.classList.toggle('dark', params.get('theme') !== 'light')
createRoot(document.getElementById('root') as HTMLElement).render(
  <div style={{ width: 760, height: 720, display: 'flex', background: 'var(--card)' }}>
    <RepoPickerModal
      embedded
      onClose={() => {}}
      onPick={noop}
      onScan={noop}
      onCloneGithub={noop}
      initialSource={params.get('source') === 'github' ? 'github' : 'local'}
      machines={[machine as never]}
      selectedMachineId={machine.id}
    />
  </div>,
)
