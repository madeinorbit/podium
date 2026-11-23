/**
 * The "Set up agents" panel (POD-6858) over fixture machines, rendered by the
 * product's shared view model and real panel component. `?state=` picks the
 * scene, `?theme=light|dark` the appearance.
 */
import type { MachineModel } from '@podium/client-graph'
import { AgentSetupView } from '@podium/client-graph/agent-setup-view'
import { MachineHarness } from '@podium/client-graph/machine-harness'
import {
  type AgentInventory,
  asMachineId,
  asSessionId,
  BUILTIN_HARNESS_KINDS,
  type BuiltinHarnessKind,
  type Inventory,
} from '@podium/model'
import { observable, observableRef, runInAction } from 'mobx'
import { createRoot } from 'react-dom/client'
import { SetupAgentsPanel } from '@/features/setup-agents/SetupAgentsPanel'
import '@/index.css'
import '@/styles.css'

const params = new URLSearchParams(location.search)
const scene = params.get('state') ?? 'list'
const theme = params.get('theme') ?? 'light'
const MB = 1024 * 1024
const checkedAt = new Date(Date.now() - 2 * 3600000).toISOString()

const managed = (
  version: string,
  over: Partial<NonNullable<NonNullable<AgentInventory['install']>['managed']>> = {},
) => ({
  active: { path: `/state/harnesses/x/3-${version}/tool`, version, release: 3 },
  previousVersion: undefined as string | undefined,
  paused: false,
  lastCheckAt: checkedAt,
  ...over,
})

function fleet(): AgentInventory[] {
  const claude: AgentInventory = {
    kind: 'claude-code',
    installed: true,
    version: '2.1.323',
    login: { state: 'in', account: 'person@example.com' },
    management: { installable: true, homeVariable: 'CLAUDE_CONFIG_DIR' },
    install: {
      external: { path: '/person/bin/claude', version: '2.1.292' },
      managed: managed('2.1.323', { previousVersion: '2.1.322', latest: '2.1.323' }),
    },
  }
  const cursor: AgentInventory = {
    kind: 'cursor',
    installed: true,
    version: '2026.11.19',
    login: { state: 'out' },
    management: {
      installable: true,
      updateNotice: 'Cursor updates itself. Podium installed it once and leaves updates to it.',
    },
    install: { managed: managed('2026.11.19', { vendorUpdated: true }) },
  }
  const codex: AgentInventory = {
    kind: 'codex',
    installed: false,
    login: { state: 'unknown' },
    management: { installable: true, homeVariable: 'CODEX_HOME' },
  }
  const opencode: AgentInventory = {
    kind: 'opencode',
    installed: false,
    login: { state: 'unknown' },
    management: { installable: true },
  }
  const grok: AgentInventory = {
    kind: 'grok',
    installed: false,
    login: { state: 'unknown' },
    management: {
      installable: false,
      reason: 'Podium can’t install Grok on Linux arm64 yet.',
    },
  }
  const pi: AgentInventory = {
    kind: 'pi',
    installed: true,
    version: '0.31.0',
    login: { state: 'unknown' },
    management: { installable: true },
    install: { managed: managed('0.31.0', { previousVersion: '0.30.2' }) },
  }
  const antigravity: AgentInventory = {
    kind: 'antigravity',
    installed: true,
    version: '1.11.3',
    path: '/person/bin/agy',
    login: { state: 'in' },
    management: { installable: false, reason: 'Podium can’t install Antigravity yet.' },
  }
  if (scene === 'installing' || scene === 'signin') {
    codex.install = {
      managed: {
        paused: false,
        installing: {
          version: '0.171.0',
          progress: { phase: 'download', receivedBytes: 18 * MB, totalBytes: 41 * MB },
        },
      },
    }
    opencode.install = { managed: { paused: false, installing: { version: '1.14.2' } } }
  }
  if (scene === 'failed') {
    codex.install = {
      managed: {
        paused: false,
        lastError: {
          at: checkedAt,
          message: 'Download stopped at 18 of 41 MB: the connection was reset.',
        },
      },
    }
    opencode.install = { managed: { paused: false, installing: { version: '1.14.2' } } }
  }
  return [claude, antigravity, cursor, pi, codex, opencode, grok]
}

class FixtureMachine {
  readonly id = asMachineId('fixture-machine')
  readonly name = 'Research machine'
  readonly online = true
  readonly use = 'granted' as const
  @observableRef accessor inventory: Inventory = {
    os: 'linux',
    arch: 'x64',
    agents: fleet(),
    tools: [],
  }
  readonly harnessInstalls = BUILTIN_HARNESS_KINDS.map(
    (kind) => new MachineHarness(this as unknown as MachineModel, kind),
  )
}
const fixture = new FixtureMachine()
const machine = fixture as unknown as MachineModel

const defaults = observable.object<Partial<Record<BuiltinHarnessKind, string>>>({})
const view = new AgentSetupView({
  machine,
  client: {
    harnessInstalls: {
      action: { mutate: async () => ({ ok: true, outcome: 'confirmed' }) as never },
    },
    credentials: { login: { mutate: async () => ({ sessionId: asSessionId('login') }) } },
  },
  preferences: {
    credentialDefaults: () => defaults,
    saveCredentialDefaults: (next) => runInAction(() => Object.assign(defaults, next)),
    savedCredentials: (harness) =>
      harness === 'codex'
        ? [{ id: 'cred_work', label: 'OpenAI API key “work”', hint: 'OpenAI API key' }]
        : [],
  },
  origin: scene === 'embedded' ? { kind: 'settings' } : { kind: 'menu', onStart: () => {} },
  ...(scene === 'embedded' ? {} : { focus: 'codex' as const }),
})
if (scene === 'detail') view.openDetail('claude-code')
if (scene === 'detail-pi') view.openDetail('pi')
if (scene === 'list') view.toggle('opencode')

// The sign-in page follows a finished install of the focused harness.
if (scene === 'signin')
  setTimeout(
    () =>
      runInAction(() => {
        fixture.inventory = {
          ...fixture.inventory,
          agents: fixture.inventory.agents.map((agent) =>
            agent.kind === 'codex'
              ? {
                  ...agent,
                  installed: true,
                  version: '0.171.0',
                  login: { state: 'out' },
                  install: { managed: managed('0.171.0') },
                }
              : agent.kind === 'opencode'
                ? {
                    ...agent,
                    install: {
                      managed: {
                        paused: false,
                        installing: {
                          version: '1.14.2',
                          progress: {
                            phase: 'download',
                            receivedBytes: 29 * MB,
                            totalBytes: 50 * MB,
                          },
                        },
                      },
                    },
                  }
                : agent,
          ),
        }
      }),
    250,
  )

document.documentElement.setAttribute('data-theme', 'podium')
if (theme === 'dark') document.documentElement.classList.add('dark')

createRoot(document.getElementById('root')!).render(
  scene === 'embedded' ? (
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-10">
      <div className="mx-auto max-w-4xl">
        <p className="text-xs text-muted-foreground">Settings / Machines</p>
        <h1 className="mt-6 text-xl font-medium">Research machine</h1>
        <p className="mt-1 text-xs text-muted-foreground">Linux · x86-64</p>
        <section aria-label="Harnesses" className="mt-6">
          <h3 className="text-sm font-medium">Harnesses</h3>
          <p className="settings-prose mt-1 mb-3 max-w-prose">
            The agents Podium can run on this machine. Open one for its versions, updates and
            sign-in. This is the same panel as Set up agents in the harness menus.
          </p>
          <SetupAgentsPanel view={view} variant="embedded" />
        </section>
      </div>
    </main>
  ) : (
    <main className="flex min-h-screen items-start justify-center bg-background/60 px-2 py-4 text-foreground sm:py-8">
      <div className="flex w-full max-w-[680px] flex-col overflow-hidden rounded-xl shadow-2xl ring-1 ring-foreground/10">
        <SetupAgentsPanel view={view} variant="dialog" onClose={() => {}} />
      </div>
    </main>
  ),
)
