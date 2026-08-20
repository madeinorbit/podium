/**
 * THE SIDEBAR'S SPAWN MENU, OPEN, IN A BROWSER (POD-1322).
 *
 * `bunx vite --config vite.harness.config.ts` in apps/web, then drive
 * `e2e/pod1322-spawn-menu-shots.ts`.
 *
 * The shipping `NewAgentMenu` takes its whole world as props, so this needs no
 * stubbed store — only a fixture. That fixture is THIS HOST's real inventory
 * (claude/codex/grok signed in, opencode installed and signed out, cursor
 * absent), which is the arrangement that produced the report: one row refused,
 * one row merely signed out, and the question of which should be louder.
 */
import { createRoot } from 'react-dom/client'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { NewAgentMenu } from '@/features/worklist/NewAgentMenu'
import '@/index.css'
import '@/styles.css'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = 'podium'
document.documentElement.classList.toggle('dark', (params.get('mode') ?? 'light') === 'dark')

const machine = {
  machine: {
    id: 'vmi3431366',
    name: 'vmi3431366',
    hostname: 'vmi3431366',
    online: true,
    inventory: {
      os: 'linux',
      arch: 'x64',
      agents: [
        { kind: 'claude-code', installed: true, login: { state: 'in' } },
        { kind: 'codex', installed: true, login: { state: 'in' } },
        { kind: 'grok', installed: true, login: { state: 'in' } },
        { kind: 'opencode', installed: true, login: { state: 'out' } },
        { kind: 'cursor', installed: false, login: { state: 'unknown' } },
      ],
    },
  },
  grants: { see: true, use: true, manage: true },
  availability: 'available' as const,
}

const repo = {
  path: '/home/podium/podium',
  name: 'podium',
  machines: [{ machineId: 'vmi3431366' }],
}

function Harness() {
  return (
    // The sidebar's ground and its column width, so the menu is measured against
    // the same aside it opens inside.
    <div
      style={{
        width: 306,
        height: '100dvh',
        padding: '10px',
        background: 'var(--sidebar)',
      }}
    >
      {/* A REAL TRIGGER, not `open` on the root: the popup is a `popover`
          element, and nothing paints it until the trigger opens it — an
          `open`-by-default harness renders the rows into the DOM and shows a
          blank page. The chip wears the shipping class so the menu is measured
          under the control it actually hangs from. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="shell-spawn-chip flex h-10 w-full min-w-0 items-center gap-[9px] rounded-[8px] border border-border-strong bg-chip px-[11px] pr-[36px] text-[12.5px] font-medium tracking-[-0.005em] leading-[normal] text-foreground"
            >
              New Claude in podium
            </button>
          }
        />
        <NewAgentMenu
          menuRepos={[repo as never]}
          machineViews={[machine] as never}
          defaultRepo={repo as never}
          onSpawn={() => {}}
          onPersistDefaultAgent={() => {}}
          onNewIssue={() => {}}
        />
      </DropdownMenu>
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<Harness />)
