import { EMPTY_FIRST_TASK_DRAFT, readFirstTaskDraft } from '@podium/client-core/first-task-draft'
import { COORDINATOR_PROMPT } from '@podium/client-core/new-task'
import { FIRST_TASK_ACTIVATION_DRAFT_KEY, LAST_LAUNCH_PICK_KEY } from '@podium/client-core/ui-state'
import {
  asMachineId,
  asRepoId,
  type GitRepositoryWire,
  type MachineWire,
  type SessionMeta,
} from '@podium/model'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { type ComponentProps, type ReactElement, useState } from 'react'
import type { TextInput } from 'react-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'
import type { ComposeMenuItem } from '../components/compose/ComposeMenu'
import type { ComposeSheetHeaderProps } from '../components/compose/ComposeStartButton'
import type { ComposerAttachmentsApi } from '../components/useComposerAttachments'

const seams = vi.hoisted(() => ({
  replace: vi.fn(),
  back: vi.fn(),
  params: {} as { repoPath?: string; backTo?: string },
  attachments: null as ComposerAttachmentsApi | null,
  close: undefined as (() => void) | undefined,
  agentItems: [] as readonly ComposeMenuItem[],
  presented: true,
  finishPresentation: undefined as (() => void) | undefined,
  promptLayout: undefined as ComponentProps<typeof TextInput>['onLayout'],
  bindPaste: vi.fn(),
  stopPaste: vi.fn(),
}))
vi.mock('react-native', async (original) => {
  const rn = await original<typeof import('react-native')>()
  const { forwardRef } = await import('react')
  return {
    ...rn,
    TextInput: forwardRef<TextInput, ComponentProps<typeof TextInput>>((props, ref) => {
      if (props.accessibilityLabel === 'Task prompt') seams.promptLayout = props.onLayout
      return <rn.TextInput {...props} ref={ref} onLayout={undefined} />
    }),
  }
})
vi.mock('../lib/composer-media', async (original) => {
  const real = await original<typeof import('../lib/composer-media')>()
  return {
    ...real,
    onMediaPaste: (...args: Parameters<typeof real.onMediaPaste>) => {
      seams.bindPaste(...args)
      const stop = real.onMediaPaste(...args)
      return () => {
        seams.stopPaste()
        stop()
      }
    },
  }
})
vi.mock('expo-router', () => ({
  useRouter: () => ({
    replace: seams.replace,
    back: () => {
      seams.back()
      seams.close?.()
    },
  }),
  useLocalSearchParams: () => seams.params,
}))
vi.mock('expo-router/react-navigation', async () => ({
  HeaderHeightContext: (await import('react')).createContext(0),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}))
vi.mock('../hooks/useKeyboardHeight', () => ({ useKeyboardLift: () => 0 }))
vi.mock('../components/compose/useComposePresentation', () => ({
  useComposePresentation: () => {
    const [presented, setPresented] = useState(seams.presented)
    seams.finishPresentation = () => setPresented(true)
    return presented
  },
}))
vi.mock('../components/compose/ComposeSheetHeader', () => ({
  ComposeSheetHeader: (props: ComposeSheetHeaderProps) => (
    <header>
      <button type="button" onClick={props.onCancel}>
        Cancel
      </button>
      <button type="button" disabled={!props.canStart} onClick={props.onStart}>
        Start Task
      </button>
      <button type="button" disabled={!props.canSave} onClick={props.onSave}>
        Save to Backlog
      </button>
      {props.saveReason}
    </header>
  ),
}))
// Only native menu presentation is replaced. The screen reads the real pool and calls real store actions.
vi.mock('../components/compose/ComposeMenu', () => ({
  ComposeMenu: ({
    label,
    items,
    children,
  }: {
    label: string
    items: readonly ComposeMenuItem[]
    children: (open: () => void) => ReactElement
  }) => {
    if (label === 'Agent') seams.agentItems = items
    // Match the native UIMenu and ActionSheet: capture items per presentation.
    const [presented, setPresented] = useState<readonly ComposeMenuItem[] | null>(null)
    const choices = (entries: readonly ComposeMenuItem[], parent = ''): ReactElement[] =>
      entries.flatMap((item) =>
        item.items
          ? [
              <fieldset key={`${parent}/${item.id}`} aria-label={item.label}>
                {choices(item.items, `${parent}/${item.id}`)}
              </fieldset>,
            ]
          : [
              <button
                key={`${parent}/${item.id}`}
                type="button"
                role="menuitemradio"
                aria-checked={item.selected}
                disabled={item.disabled}
                onClick={() => {
                  item.onPress?.()
                  setPresented(null)
                }}
              >
                <span>{item.label}</span>
                {item.subtitle ? <small>{item.subtitle}</small> : null}
              </button>,
            ],
      )
    return (
      <>
        {children(() => setPresented(presented ? null : items))}
        {presented ? (
          <div role="menu" aria-label={label}>
            {choices(presented)}
          </div>
        ) : null}
      </>
    )
  },
}))
vi.mock('../components/useComposerAttachments', async (original) => {
  const real = await original<typeof import('../components/useComposerAttachments')>()
  return {
    ...real,
    useComposerAttachments: (...args: Parameters<typeof real.useComposerAttachments>) => {
      seams.attachments = real.useComposerAttachments(...args)
      return seams.attachments
    },
  }
})
const { NewIssueScreen } = await import('./NewIssueScreen')
// Transform the real lazy sources before the fixture's bounded attach deadline.
await Promise.all([
  import('@podium/client-graph/mobile-screens'),
  import('@podium/client-graph/issue-page-source'),
  import('@podium/client-graph/command-launch-source'),
  import('@podium/client-graph/command-launch-views'),
  import('@podium/client-graph/mobile-settings'),
  import('@podium/client-graph/mobile-inbox-source'),
  import('@podium/client-graph/mobile-inbox-views'),
  import('@podium/client-graph/mobile-session-context'),
])

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  seams.replace.mockReset()
  seams.params = {}
  seams.close = undefined
  seams.presented = true
  seams.finishPresentation = undefined
  seams.promptLayout = undefined
})
const repository = (path = '/repo/podium', machineId = 'host'): GitRepositoryWire =>
  ({
    path,
    kind: 'repository',
    branch: 'main',
    repoId: asRepoId(path),
    machineId: asMachineId(machineId),
    worktrees: [],
  }) as GitRepositoryWire
function machine(patch: Partial<MachineWire> = {}): MachineWire {
  return {
    id: 'host',
    name: 'Studio',
    hostname: 'studio',
    online: true,
    use: 'granted',
    serviceAssignment: { server: false, agentExecution: true },
    availability: { epoch: 'boot', server: false, daemon: true, supervisor: true },
    lastSeenAt: '2026-01-01T00:00:00Z',
    inventory: {
      os: 'linux',
      arch: 'x64',
      agents: [{ kind: 'claude-code', installed: true, login: { state: 'in' } }],
      tools: [],
    },
    ...patch,
  } as MachineWire
}
const prompt = () => screen.getByRole('textbox', { name: 'Task prompt' }) as HTMLTextAreaElement
async function ready() {
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Start Task' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  )
}
async function mount(
  extra: Parameters<typeof renderWithMobileStore>[1] = {},
  child = <NewIssueScreen />,
) {
  return renderWithMobileStore(child, {
    repos: [repository()],
    machines: [machine()],
    ...extra,
    api: {
      models: {
        catalog: {
          query: async () => ({
            machineId: 'host',
            fetchedAt: Date.now(),
            byAgent: {
              'claude-code': [
                { value: 'reported-model', label: 'Reported Model', efforts: ['low', 'high'] },
              ],
              codex: [{ value: 'codex-model', label: 'Codex Model', efforts: ['medium', 'xhigh'] }],
            },
          }),
        },
      },
      ...extra.api,
    },
  })
}

describe('native New Task sheet logic', () => {
  it('binds paste to the real prompt after its delayed native layout and keeps it through edits', async () => {
    seams.presented = false
    const upload = vi.fn(async () => ({ path: '/uploads/pasted.png' }))
    const app = await mount({ api: { sessions: { uploadImage: { mutate: upload } } } })
    expect(seams.bindPaste).not.toHaveBeenCalled()
    act(() => seams.finishPresentation?.())
    const input = prompt()
    expect(seams.bindPaste).not.toHaveBeenCalled()
    const layout = () =>
      act(() =>
        seams.promptLayout?.({
          nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 72 } },
        } as never),
      )
    layout()
    expect(seams.bindPaste).toHaveBeenCalledTimes(1)
    expect(seams.bindPaste.mock.calls[0]?.[0]).toBe(input)
    fireEvent.paste(input, {
      clipboardData: {
        items: [
          { kind: 'file', getAsFile: () => new File(['png'], 'pasted.png', { type: 'image/png' }) },
        ],
      },
    })
    await waitFor(() => expect(seams.attachments?.ready()).toHaveLength(1))
    expect(upload).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Remove pasted.png' })).toBeTruthy()
    fireEvent.change(input, { target: { value: 'Keep this image' } })
    layout()
    expect(seams.bindPaste).toHaveBeenCalledTimes(1)
    expect(seams.stopPaste).not.toHaveBeenCalled()
    app.unmount()
    expect(seams.stopPaste).toHaveBeenCalledTimes(1)
  })

  it('ignores opening double taps until presentation ends and keeps empty Send enabled afterwards', async () => {
    seams.presented = false
    const create = vi.fn(async (input: { sessionId: string }) => ({ sessionId: input.sessionId }))
    await mount({ api: { sessions: { create: { mutate: create } } } })
    await ready()
    const send = screen.getByRole('button', { name: 'Start Task' }) as HTMLButtonElement
    expect(send.disabled).toBe(false)
    expect(screen.queryByRole('textbox', { name: 'Task prompt' })).toBeNull()
    fireEvent.click(send)
    fireEvent.click(send)
    expect(create).not.toHaveBeenCalled()
    expect(seams.replace).not.toHaveBeenCalled()
    act(() => seams.finishPresentation?.())
    expect(prompt().value).toBe('')
    fireEvent.click(send)
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
  })

  it('opens before projects and machines arrive, then hydrates the existing sheet without losing the prompt', async () => {
    let discovered = {
      repositories: [] as GitRepositoryWire[],
      machines: [] as MachineWire[],
      diagnostics: [],
    }
    const app = await mount({
      repos: [],
      machines: [],
      api: { discovery: { refreshRepos: { mutate: async () => discovered } } },
    })
    const input = prompt()
    fireEvent.change(input, { target: { value: 'Typed before discovery finished' } })
    expect((screen.getByRole('button', { name: 'Start Task' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    discovered = { repositories: [repository()], machines: [machine()], diagnostics: [] }
    await act(async () => {
      await app.runtime.access.refreshRepos()
    })
    await ready()
    expect(screen.getByRole('button', { name: 'Project, podium' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Machine, Studio' })).toBeTruthy()
    expect(prompt()).toBe(input)
    expect(prompt().value).toBe('Typed before discovery finished')
    expect(seams.back).not.toHaveBeenCalled()
    expect(seams.replace).not.toHaveBeenCalled()
  })

  it('offers Auto and Shell for an empty catalog and no Effort for models that report none', async () => {
    await mount({
      api: {
        models: {
          catalog: {
            query: async () => ({ machineId: 'host', fetchedAt: Date.now(), byAgent: {} }),
          },
        },
      },
    })
    await ready()
    const configuration = () => seams.agentItems.find((row) => row.id === 'configuration')?.items
    expect(configuration()?.map((row) => row.id)).toEqual(['model'])
    expect(configuration()?.[0]?.items?.map((row) => row.id)).toEqual(['auto', 'shell'])
    cleanup()
    await mount({
      api: {
        models: {
          catalog: {
            query: async () => ({
              machineId: 'host',
              fetchedAt: Date.now(),
              byAgent: {
                'claude-code': [{ value: 'no-effort', label: 'Without effort', efforts: [] }],
              },
            }),
          },
        },
      },
    })
    await ready()
    fireEvent.click(screen.getByRole('button', { name: /^Agent, / }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Without effort' }))
    expect(configuration()?.map((row) => row.id)).toEqual(['model'])
  })

  it('lists cross-machine clones once and distinguishes separate projects named pipp', async () => {
    const origin = 'https://github.com/example/pipp.git'
    const otherOrigin = 'https://github.com/another/pipp.git'
    const app = await mount({
      repos: [
        { ...repository('/repo/pipp'), repoId: asRepoId('pipp'), originUrl: origin },
        { ...repository('/remote/pipp', 'remote'), repoId: asRepoId('pipp'), originUrl: origin },
        {
          ...repository('/repo/other-pipp'),
          repoId: asRepoId('other-pipp'),
          originUrl: otherOrigin,
        },
        repository('/local/pipp'),
      ],
      machines: [machine(), machine({ id: asMachineId('remote'), name: 'Remote' })],
    })
    await ready()
    const input = prompt()
    fireEvent.change(input, { target: { value: 'Keep this unsent draft' } })
    fireEvent.click(screen.getByRole('button', { name: /^Project, / }))
    const choices = within(screen.getByRole('menu', { name: 'Project' })).getAllByRole(
      'menuitemradio',
    )
    expect(choices).toHaveLength(3)
    expect(new Set(choices.map((choice) => choice.textContent)).size).toBe(3)
    const other = choices.find((choice) => choice.textContent?.includes('github.com/another/pipp'))
    if (!other) throw new Error('Missing distinct pipp project')
    fireEvent.click(other)
    await waitFor(() =>
      expect(
        readFirstTaskDraft(app.runtime.access.uiState.get(FIRST_TASK_ACTIVATION_DRAFT_KEY))
          .repoPath,
      ).toBe('/repo/other-pipp'),
    )
    expect(prompt()).toBe(input)
    expect(prompt().value).toBe('Keep this unsent draft')
    expect(seams.back).not.toHaveBeenCalled()
  })

  it('distinguishes the separately registered pipp clones by machine without merging their IDs', async () => {
    await mount({
      repos: [
        {
          ...repository('/home/podium/pipp'),
          repoId: asRepoId('repo_2928f71bab0412fa'),
          originUrl: 'https://github.com/madeinorbit/pipp.git',
        },
        {
          ...repository('/Users/till/Sites/pipp', 'remote'),
          repoId: asRepoId('repo_6a281f1347ed8b9f'),
          originUrl: 'https://github.com/madeinorbit/pipp.git',
        },
      ],
      machines: [
        machine({ name: 'vmi3431366' }),
        machine({ id: asMachineId('remote'), name: 'MBP-Cofo' }),
      ],
    })
    await ready()
    fireEvent.click(screen.getByRole('button', { name: /^Project, / }))
    const choices = within(screen.getByRole('menu', { name: 'Project' })).getAllByRole(
      'menuitemradio',
    )
    expect(choices).toHaveLength(2)
    expect(choices.map((choice) => choice.textContent)).toEqual(
      expect.arrayContaining([
        'pippvmi3431366 · github.com/madeinorbit/pipp',
        'pippMBP-Cofo · github.com/madeinorbit/pipp',
      ]),
    )
    const mac = choices.find((choice) => choice.textContent?.includes('MBP-Cofo'))
    if (!mac) throw new Error('Missing Mac checkout')
    fireEvent.click(mac)
    expect(screen.getByRole('button', { name: 'Machine, MBP-Cofo' })).toBeTruthy()
  })

  it('keeps Model and Effort at the root while unavailable agents occupy one submenu', async () => {
    await mount({
      api: {
        models: {
          catalog: {
            query: async () => ({
              machineId: 'host',
              fetchedAt: Date.now(),
              byAgent: {
                'claude-code': [{ value: 'current', label: 'Current', efforts: ['high'] }],
              },
            }),
          },
        },
      },
    })
    await ready()
    fireEvent.click(screen.getByRole('button', { name: /^Agent, / }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Current' }))
    await waitFor(() =>
      expect(
        seams.agentItems
          .find((row) => row.id === 'configuration')
          ?.items?.some((row) => row.id === 'effort'),
      ).toBe(true),
    )
    const agents = seams.agentItems.find((row) => row.id === 'agents')?.items ?? []
    expect(agents.length).toBeLessThanOrEqual(3)
    const unavailable = agents.find((row) => row.id === 'unavailable')
    expect(unavailable?.items?.length).toBeGreaterThan(0)
    expect(unavailable?.items?.every((row) => row.disabled && row.subtitle)).toBe(true)
    expect(
      seams.agentItems.find((row) => row.id === 'configuration')?.items?.map((row) => row.id),
    ).toEqual(['model', 'effort'])
  })

  it('matches desktop by resetting effort to Auto on every model pick', async () => {
    const { runtime } = await mount({
      api: {
        models: {
          catalog: {
            query: async () => ({
              machineId: 'host',
              fetchedAt: Date.now(),
              byAgent: {
                'claude-code': [
                  { value: 'first', label: 'First model', efforts: ['low', 'high'] },
                  { value: 'second', label: 'Second model', efforts: ['high'] },
                  { value: 'limited', label: 'Limited model', efforts: ['low'] },
                  { value: 'none', label: 'No effort model', efforts: [] },
                ],
              },
            }),
          },
        },
      },
    })
    await ready()
    const input = prompt()
    const pick = (name: string) => {
      fireEvent.click(screen.getByRole('button', { name: /^Agent, / }))
      fireEvent.click(screen.getByRole('menuitemradio', { name }))
    }
    const selected = () =>
      readFirstTaskDraft(runtime.access.uiState.get(FIRST_TASK_ACTIVATION_DRAFT_KEY))
    pick('First model')
    pick('High')
    pick('Second model')
    await waitFor(() => expect(selected()).toMatchObject({ model: 'second', effort: 'auto' }))
    pick('High')
    pick('Second model')
    expect(selected()).toMatchObject({ model: 'second', effort: 'auto' })
    pick('First model')
    pick('High')
    pick('Limited model')
    await waitFor(() => expect(selected()).toMatchObject({ model: 'limited', effort: 'auto' }))
    pick('First model')
    pick('High')
    pick('No effort model')
    await waitFor(() => expect(selected()).toMatchObject({ model: 'none', effort: 'auto' }))
    pick('First model')
    pick('High')
    fireEvent.click(screen.getByRole('button', { name: /^Agent, / }))
    fireEvent.click(
      within(screen.getByRole('group', { name: /^Model · / })).getByRole('menuitemradio', {
        name: 'Auto',
      }),
    )
    await waitFor(() => expect(selected()).toMatchObject({ model: 'auto', effort: 'auto' }))
    expect(prompt()).toBe(input)
    expect(seams.back).not.toHaveBeenCalled()
    expect(seams.replace).not.toHaveBeenCalled()
  })

  it('uses each harness catalog and keeps a selected agent, model and effort across reopening', async () => {
    function Harness() {
      const [open, setOpen] = useState(true)
      seams.close = () => setOpen(false)
      return open ? (
        <NewIssueScreen />
      ) : (
        <button type="button" onClick={() => setOpen(true)}>
          Reopen
        </button>
      )
    }
    const { runtime } = await mount(
      {
        machines: [
          machine({
            inventory: {
              os: 'linux',
              arch: 'x64',
              tools: [],
              agents: [
                { kind: 'claude-code', installed: true, login: { state: 'in' } },
                { kind: 'codex', installed: true, login: { state: 'in' } },
              ],
            },
          }),
        ],
      },
      <Harness />,
    )
    await ready()
    const open = () => fireEvent.click(screen.getByRole('button', { name: /^Agent, / }))
    const pick = (name: string) => fireEvent.click(screen.getByRole('menuitemradio', { name }))
    open()
    pick('Codex')
    expect(screen.getByRole('button', { name: /^Agent, Codex/ })).toBeTruthy()
    open()
    expect(screen.queryByRole('menuitemradio', { name: 'Reported Model' })).toBeNull()
    pick('Codex Model')
    await waitFor(() => expect(screen.getByRole('button', { name: /Codex Model/ })).toBeTruthy())
    open()
    pick('Extra high')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Codex Model · Extra high/ })).toBeTruthy(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Agent, Codex, Codex Model · Extra high/ }),
      ).toBeTruthy(),
    )
    open()
    pick('Claude Code')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Agent, Claude Code/ })).toBeTruthy(),
    )
    open()
    pick('Reported Model')
    await waitFor(() => expect(screen.getByRole('button', { name: /Reported Model/ })).toBeTruthy())
    open()
    pick('High')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Agent, Claude Code, Reported Model · High/ }),
      ).toBeTruthy(),
    )
    expect(
      readFirstTaskDraft(runtime.access.uiState.get(FIRST_TASK_ACTIVATION_DRAFT_KEY)),
    ).toMatchObject({ agent: 'claude-code', model: 'reported-model', effort: 'high' })
    expect(runtime.access.uiState.get(LAST_LAUNCH_PICK_KEY)).toBeNull()
  })

  it('discovers an originless repo synced after app start without a manual refresh', async () => {
    let repos = [repository('/repo/alpha')]
    const refresh = vi.fn(async () => ({
      repositories: repos,
      diagnostics: [],
      machines: [machine()],
    }))
    const app = await mount({ api: { discovery: { refreshRepos: { mutate: refresh } } } })
    await ready()
    const beforeAdd = refresh.mock.calls.length
    const added = { ...repository('/tmp/new-local-project'), repoId: asRepoId('local-project') }
    repos = [...repos, added]
    await act(async () => {
      app.replica.applyChanges(
        'repos',
        [
          {
            id: added.repoId,
            repoPath: added.path,
            name: 'new-local-project',
            prefix: 'LOCAL',
          },
        ],
        [],
      )
    })
    await waitFor(() => expect(refresh.mock.calls.length).toBeGreaterThan(beforeAdd))
    await waitFor(() =>
      expect(app.runtime.access.repos.some((repo) => repo.path === added.path)).toBe(true),
    )
    fireEvent.click(screen.getByRole('button', { name: /^Project, / }))
    await waitFor(() =>
      expect(screen.getByRole('menuitemradio', { name: /^new-local-project/ })).toBeTruthy(),
    )
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^new-local-project/ }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Project, new-local-project' })).toBeTruthy(),
    )
  })

  it('starts an empty prompt through sessions.create and opens the terminal without filing a named task', async () => {
    const create = vi.fn(async (input: { sessionId: string }) => ({ sessionId: input.sessionId }))
    const file = vi.fn()
    await mount({
      api: { sessions: { create: { mutate: create } }, issues: { create: { mutate: file } } },
    })
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Start Task' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      cwd: '/repo/podium',
      agentKind: 'claude-code',
      draftIssue: { repoPath: '/repo/podium' },
    })
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('initialPrompt')
    expect(file).not.toHaveBeenCalled()
    expect(seams.replace.mock.calls[0]?.[0]).toMatchObject({
      pathname: '/session/[sessionId]/terminal',
    })
  })

  it('starts a written prompt through the desktop draft-session procedure and opens its chat', async () => {
    const create = vi.fn(async (input: { sessionId: string }) => ({ sessionId: input.sessionId }))
    await mount({ api: { sessions: { create: { mutate: create } } } })
    await ready()
    fireEvent.change(prompt(), { target: { value: 'Fix the jump\n\nKeep context.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start Task' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start Task' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      initialPrompt: 'Fix the jump\n\nKeep context.',
    })
    expect(seams.replace.mock.calls[0]?.[0]).toMatchObject({ pathname: '/session/[sessionId]' })
  })

  it.each([
    'before',
    'after',
  ] as const)('restores the same image when New Task reopens %s a delayed launch failure and retries without uploading', async (reopen) => {
    let rejectCreate!: (error: Error) => void
    const delayed = new Promise<{ sessionId: string }>((_resolve, reject) => {
      rejectCreate = reject
    })
    const create = vi
      .fn(async (input: { sessionId: string }) => ({ sessionId: input.sessionId }))
      .mockImplementationOnce(() => delayed)
    const ref = {
      id: 'held-retry',
      filename: 'retry.png',
      mediaType: 'image/png',
      kind: 'image' as const,
    }
    const upload = vi.fn(async () => ({ path: '', attachment: ref }))
    function Harness() {
      const [open, setOpen] = useState(true)
      seams.close = () => setOpen(false)
      return open ? (
        <NewIssueScreen />
      ) : (
        <button type="button" onClick={() => setOpen(true)}>
          New Task
        </button>
      )
    }
    const app = await mount(
      { api: { sessions: { create: { mutate: create }, uploadImage: { mutate: upload } } } },
      <Harness />,
    )
    await ready()
    fireEvent.change(prompt(), { target: { value: 'Review this screenshot' } })
    const previewUri = 'data:image/png;base64,aGVsbG8='
    act(() =>
      seams.attachments?.accept([
        { name: 'retry.png', mimeType: 'image/png', dataBase64: 'aGVsbG8=', previewUri },
      ]),
    )
    await waitFor(() => expect(seams.attachments?.ready()).toHaveLength(1))
    const chip = seams.attachments?.attachments[0]
    seams.replace.mockImplementation(() => seams.close?.())
    fireEvent.click(screen.getByRole('button', { name: 'Start Task' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('textbox', { name: 'Task prompt' })).toBeNull()
    const first = create.mock.calls[0]?.[0]
    expect(first).toMatchObject({ attachments: [ref], initialPrompt: 'Review this screenshot' })
    if (reopen === 'before') fireEvent.click(screen.getByRole('button', { name: 'New Task' }))
    await act(async () => rejectCreate(new Error('Connection interrupted')))
    if (reopen === 'after') fireEvent.click(screen.getByRole('button', { name: 'New Task' }))
    await waitFor(() => expect(screen.getByText(/Couldn't start the agent/)).toBeTruthy(), {
      timeout: 5000,
    })
    expect(prompt().value).toBe('Review this screenshot')
    expect(screen.getByRole('button', { name: 'Remove retry.png' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'retry.png' }).getAttribute('src')).toBe(previewUri)
    expect(seams.attachments?.attachments[0]).toEqual(chip)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Start Task' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(create.mock.calls[1]?.[0]).toEqual(first)
    expect(upload).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(app.runtime.access.uiState.get(FIRST_TASK_ACTIVATION_DRAFT_KEY)).toBeNull(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'New Task' }))
    await ready()
    expect(prompt().value).toBe('')
    expect(screen.queryByRole('button', { name: 'Remove retry.png' })).toBeNull()
  })

  it('keeps a recovered image removed when the sheet is reopened', async () => {
    function Harness() {
      const [open, setOpen] = useState(true)
      seams.close = () => setOpen(false)
      return open ? (
        <NewIssueScreen />
      ) : (
        <button type="button" onClick={() => setOpen(true)}>
          New Task
        </button>
      )
    }
    const app = await mount({}, <Harness />)
    await ready()
    act(() =>
      app.runtime.access.uiState.set(
        FIRST_TASK_ACTIVATION_DRAFT_KEY,
        JSON.stringify({
          ...EMPTY_FIRST_TASK_DRAFT,
          repoPath: '/repo/podium',
          title: 'Keep this prompt',
          attachments: [
            {
              id: 'restored-chip',
              name: 'remove.png',
              previewUri: '',
              state: 'ready',
              ref: {
                id: 'held-remove',
                filename: 'remove.png',
                mediaType: 'image/png',
                kind: 'image',
              },
            },
          ],
        }),
      ),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Remove remove.png' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'New Task' }))
    await ready()
    expect(prompt().value).toBe('Keep this prompt')
    expect(screen.queryByRole('button', { name: 'Remove remove.png' })).toBeNull()
    expect(
      readFirstTaskDraft(app.runtime.access.uiState.get(FIRST_TASK_ACTIVATION_DRAFT_KEY))
        .attachments,
    ).toEqual([])
  })

  it('saves to Backlog with the shared first-line title and never starts a session', async () => {
    const create = vi.fn(async (_input: Record<string, unknown>) => ({ id: 'iss_saved' }))
    const start = vi.fn()
    await mount({
      api: { issues: { create: { mutate: create } }, sessions: { create: { mutate: start } } },
    })
    await ready()
    fireEvent.change(prompt(), { target: { value: '\n  Fix the jump  \n\nKeep exact context. ' } })
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Save to Backlog' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save to Backlog' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      title: 'Fix the jump',
      description: '\n  Fix the jump  \n\nKeep exact context. ',
      startNow: false,
    })
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('defaultModel')
    expect(start).not.toHaveBeenCalled()
  })

  it('retries an ambiguous backlog save with the same issue and mutation identities', async () => {
    const create = vi
      .fn(async (_input: Record<string, unknown>) => ({ id: 'iss_saved' }))
      .mockRejectedValueOnce(new Error('Connection interrupted'))
    await mount({ api: { issues: { create: { mutate: create } } } })
    await ready()
    fireEvent.change(prompt(), { target: { value: 'Keep one backlog task' } })
    const save = () => screen.getByRole('button', { name: 'Save to Backlog' }) as HTMLButtonElement
    await waitFor(() => expect(save().disabled).toBe(false))
    fireEvent.click(save())
    await waitFor(() => expect(screen.getByText(/Connection interrupted/)).toBeTruthy())
    await waitFor(() => expect(save().disabled).toBe(false))
    fireEvent.click(save())
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(create.mock.calls[1]?.[0]).toEqual(create.mock.calls[0]?.[0])
  })

  it('opens Shell from the Model submenu through the same session launch', async () => {
    const create = vi.fn(async (input: { sessionId: string }) => ({ sessionId: input.sessionId }))
    await mount({ api: { sessions: { create: { mutate: create } } } })
    await ready()
    fireEvent.click(screen.getByRole('button', { name: /Agent, Claude Code/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Shell' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Agent, Shell' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Start Task' }))
    await waitFor(() => expect(create.mock.calls[0]?.[0]).toMatchObject({ agentKind: 'shell' }))
    expect(seams.replace.mock.calls[0]?.[0]).toMatchObject({
      pathname: '/session/[sessionId]/terminal',
    })
  })

  it('keeps attached files removable and blocks a Shell launch that cannot consume them', async () => {
    await mount({
      api: {
        sessions: {
          uploadImage: {
            mutate: async () => ({
              path: '',
              attachment: {
                id: 'held',
                filename: 'shot.png',
                mediaType: 'image/png',
                kind: 'image',
              },
            }),
          },
        },
      },
    })
    await ready()
    fireEvent.change(prompt(), { target: { value: 'Keep the attached file' } })
    act(() =>
      seams.attachments?.accept([
        { name: 'shot.png', mimeType: 'image/png', dataBase64: 'aGVsbG8=', previewUri: '' },
      ]),
    )
    await waitFor(() => expect(seams.attachments?.attachments[0]?.state).toBe('ready'))
    fireEvent.click(screen.getByRole('button', { name: /Agent, Claude Code/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Shell' }))
    await waitFor(() =>
      expect(screen.getByText('This agent cannot accept file attachments.')).toBeTruthy(),
    )
    expect((screen.getByRole('button', { name: 'Start Task' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove shot.png' }))
    await ready()
    expect(prompt().value).toBe('Keep the attached file')
  })

  it('seeds a project entry point and resolves that project’s usable checkout on its machine', async () => {
    seams.params = { repoPath: '/repo/second' }
    const create = vi.fn(async (input: { sessionId: string }) => ({ sessionId: input.sessionId }))
    await mount({
      repos: [repository(), repository('/repo/second', 'remote')],
      machines: [machine(), machine({ id: 'remote' as MachineWire['id'], name: 'Remote' })],
      api: { sessions: { create: { mutate: create } } },
    })
    await ready()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Project, second' })).toBeTruthy(),
    )
    expect(screen.getByRole('button', { name: 'Machine, Remote' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Start Task' }))
    await waitFor(() =>
      expect(create.mock.calls[0]?.[0]).toMatchObject({ cwd: '/repo/second', machineId: 'remote' }),
    )
  })

  it('shows a newly discovered project on the next menu opening without reopening the sheet', async () => {
    let repos = [repository('/repo/alpha'), repository('/repo/beta')]
    const create = vi.fn(async (input: { sessionId: string }) => ({ sessionId: input.sessionId }))
    const app = await mount({
      repos,
      api: {
        discovery: {
          refreshRepos: {
            mutate: async () => ({ repositories: repos, machines: [machine()], diagnostics: [] }),
          },
        },
        sessions: { create: { mutate: create } },
      },
    })
    await ready()
    const projectButton = () => screen.getByRole('button', { name: /^Project, / })
    const names = () =>
      within(screen.getByRole('menu', { name: 'Project' }))
        .getAllByRole('menuitemradio')
        .map((item) => item.firstElementChild?.textContent)
    fireEvent.click(projectButton())
    expect(names()).toEqual(['alpha', 'beta'])
    repos = [...repos, repository('/repo/gamma')]
    await act(async () => {
      await app.runtime.access.refreshRepos()
    })
    expect(names()).toEqual(['alpha', 'beta'])
    fireEvent.click(projectButton())
    fireEvent.click(projectButton())
    expect(names()).toEqual(['alpha', 'beta', 'gamma'])
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^gamma/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Project, gamma' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Start Task' }))
    await waitFor(() => expect(create.mock.calls[0]?.[0]).toMatchObject({ cwd: '/repo/gamma' }))
  })

  it('refreshes project recency on each menu opening while keeping the presented order steady', async () => {
    const session = (id: string, project: string, at: string) =>
      ({
        sessionId: id,
        cwd: `/repo/${project}`,
        machineId: 'host',
        agentKind: 'claude-code',
        status: 'live',
        createdAt: at,
        lastActiveAt: at,
      }) as SessionMeta
    const alpha = session('alpha-session', 'alpha', '2026-01-02T00:00:00Z')
    const beta = session('beta-session', 'beta', '2026-01-01T00:00:00Z')
    const app = await mount({
      repos: [repository('/repo/alpha'), repository('/repo/beta')],
      sessions: [alpha, beta],
    })
    await ready()
    const projectButton = () => screen.getByRole('button', { name: /^Project, / })
    const names = () =>
      within(screen.getByRole('menu', { name: 'Project' }))
        .getAllByRole('menuitemradio')
        .map((item) => item.firstElementChild?.textContent)
    fireEvent.click(projectButton())
    expect(names()).toEqual(['alpha', 'beta'])
    await act(async () => {
      app.replica.applyChanges(
        'sessions',
        [{ ...beta, createdAt: '2026-01-03T00:00:00Z', lastActiveAt: '2026-01-03T00:00:00Z' }],
        [],
      )
    })
    expect(names()).toEqual(['alpha', 'beta'])
    fireEvent.click(projectButton())
    fireEvent.click(projectButton())
    expect(names()).toEqual(['beta', 'alpha'])
  })

  it('keeps prompt and picks on cancel and restores them from the same UI-state key on reopen', async () => {
    function Harness() {
      const [open, setOpen] = useState(true)
      seams.close = () => setOpen(false)
      return open ? (
        <NewIssueScreen />
      ) : (
        <button type="button" onClick={() => setOpen(true)}>
          Reopen
        </button>
      )
    }
    const { runtime } = await mount({}, <Harness />)
    await ready()
    act(() =>
      runtime.access.uiState.set(
        FIRST_TASK_ACTIVATION_DRAFT_KEY,
        JSON.stringify({
          ...EMPTY_FIRST_TASK_DRAFT,
          title: 'A saved prompt\nContext.',
          repoPath: '/repo/podium',
          machineId: 'host',
          agent: 'claude-code',
          model: 'reported-model',
          effort: 'high',
          launchPickTouched: true,
        }),
      ),
    )
    await waitFor(() => expect(prompt().value).toBe('A saved prompt\nContext.'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    await waitFor(() => expect(prompt().value).toBe('A saved prompt\nContext.'))
    expect(
      screen.getByRole('button', { name: /Agent, Claude Code, Reported Model · High/ }),
    ).toBeTruthy()
    expect(
      readFirstTaskDraft(runtime.access.uiState.get(FIRST_TASK_ACTIVATION_DRAFT_KEY)).effort,
    ).toBe('high')
  })

  it('restores the last launch picks per machine and harness without writing them on dismissal', async () => {
    const { runtime } = await mount()
    await ready()
    act(() => {
      runtime.access.uiState.set(
        LAST_LAUNCH_PICK_KEY,
        JSON.stringify({ host: { 'claude-code': { model: 'reported-model', effort: 'high' } } }),
      )
      runtime.access.uiState.set(
        FIRST_TASK_ACTIVATION_DRAFT_KEY,
        JSON.stringify(EMPTY_FIRST_TASK_DRAFT),
      )
    })
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Agent, Claude Code, Reported Model · High/ }),
      ).toBeTruthy(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(JSON.parse(runtime.access.uiState.get(LAST_LAUNCH_PICK_KEY) ?? '{}')).toEqual({
      host: { 'claude-code': { model: 'reported-model', effort: 'high' } },
    })
  })

  it('keeps Start enabled for headed sign-in, shows desktop copy, and opens the terminal', async () => {
    const host = machine()
    const reportedAgent = host.inventory?.agents[0]
    if (!reportedAgent) throw new Error('Missing fixture agent')
    reportedAgent.login = { state: 'out' }
    await mount({ machines: [host] })
    await ready()
    fireEvent.change(prompt(), { target: { value: 'Start after signing in' } })
    expect(
      screen.getByText(
        'Claude Code is not signed in on Studio. It opens in its terminal, where you can sign in.',
      ),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Start Task' }))
    expect(seams.replace.mock.calls[0]?.[0]).toMatchObject({
      pathname: '/session/[sessionId]/terminal',
    })
  })

  it('shows desktop permission copy and permits Save while Start is blocked', async () => {
    await mount({ machines: [machine({ use: 'denied' })] })
    fireEvent.change(prompt(), { target: { value: 'File this for later' } })
    expect(
      screen.getByText(
        'You do not have access to run work on this machine. Ask its owner for access, or pick another machine.',
      ),
    ).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Start Task' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Save to Backlog' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    )
  })

  it('blocks Start during attachment preparation and sends the completed ref with the same prompt', async () => {
    const ref = {
      id: 'slow-upload',
      filename: 'slow.png',
      mediaType: 'image/png',
      kind: 'image' as const,
    }
    const upload = vi.fn(async () => ({ path: '', attachment: ref }))
    const create = vi.fn(async (input: { sessionId: string }) => ({ sessionId: input.sessionId }))
    let finishRead: ((files: Parameters<ComposerAttachmentsApi['accept']>[0]) => void) | undefined
    await mount({
      api: { sessions: { uploadImage: { mutate: upload }, create: { mutate: create } } },
    })
    await ready()
    fireEvent.change(prompt(), { target: { value: 'Fix the image' } })
    act(() => {
      seams.attachments?.fromSource(
        () =>
          new Promise((resolve) => {
            finishRead = resolve
          }),
      )
      fireEvent.click(screen.getByRole('button', { name: 'Start Task' }))
    })
    expect(create).not.toHaveBeenCalled()
    expect(seams.attachments?.uploading).toBe(true)
    expect((screen.getByRole('button', { name: 'Start Task' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    await waitFor(() => expect(finishRead).toBeTypeOf('function'))
    await act(async () =>
      finishRead?.([
        {
          name: 'slow.png',
          mimeType: 'image/png',
          dataBase64: 'cG5n',
          previewUri: 'file:///slow.png',
        },
      ]),
    )
    await waitFor(() => expect(seams.attachments?.attachments[0]?.state).toBe('ready'))
    fireEvent.click(screen.getByRole('button', { name: 'Start Task' }))
    await waitFor(() => expect(create.mock.calls[0]?.[0]).toMatchObject({ attachments: [ref] }))
  })

  it('holds attachments with pending:true and passes their refs through Start', async () => {
    const ref = {
      id: 'held-upload',
      filename: 'shot.png',
      mediaType: 'image/png',
      kind: 'image' as const,
    }
    const upload = vi.fn(async (_input: Record<string, unknown>) => ({ path: '', attachment: ref }))
    const create = vi.fn(async (input: { sessionId: string }) => ({ sessionId: input.sessionId }))
    await mount({
      api: { sessions: { uploadImage: { mutate: upload }, create: { mutate: create } } },
    })
    await ready()
    fireEvent.change(prompt(), { target: { value: 'Fix the attached issue' } })
    act(() =>
      seams.attachments?.accept([
        {
          name: 'shot.png',
          mimeType: 'image/png',
          dataBase64: 'aGVsbG8=',
          previewUri: 'data:image/png;base64,aGVsbG8=',
        },
      ]),
    )
    await waitFor(() => expect(seams.attachments?.attachments[0]?.state).toBe('ready'))
    expect(upload.mock.calls[0]?.[0]).toMatchObject({ pending: true })
    expect(
      (screen.getByRole('button', { name: 'Save to Backlog' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.getByText('Attachments go with Start')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Start Task' }))
    await waitFor(() => expect(create.mock.calls[0]?.[0]).toMatchObject({ attachments: [ref] }))
  })

  it('inserts the coordinator prompt once and treats Return as a newline', async () => {
    await mount()
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Try adding a coordinator prompt' }))
    await waitFor(() => expect(prompt().value).toBe(COORDINATOR_PROMPT))
    expect(screen.queryByRole('button', { name: 'Try adding a coordinator prompt' })).toBeNull()
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(seams.replace).not.toHaveBeenCalled()
    fireEvent.keyDown(prompt(), { key: 'Enter', metaKey: true })
    expect(seams.replace).toHaveBeenCalledTimes(1)
  })
})
