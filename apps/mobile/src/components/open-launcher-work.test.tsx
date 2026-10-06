import type { MobxPool } from '@podium/client-graph/pool'
import type { GitRepositoryWire, MachineWire, SessionMeta } from '@podium/model'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../../tests/worklist/harness/src/work-meter'
import { useMobilePool } from '../client/mobile-pool'
import { renderWithMobileStore } from '../client/test-support'

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 430, height: 900 }),
}))
vi.mock('expo-router', () => ({ usePathname: () => '/work', useRouter: () => ({ back() {}, push() {}, replace() {} }) }))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('../hooks/useContentBottomInset', () => ({ useContentBottomInset: () => 0 }))
vi.mock('./Screen', () => ({
  Screen: ({ children }: { children: ReactNode }) => <>{children}</>,
  HeaderButton: ({ label, onPress }: { label: string; onPress: () => void }) => <button onClick={onPress} aria-label={label} />,
}))
vi.mock('./BottomSheet', () => ({ BottomSheet: ({ onClose, children, head }: { onClose: () => void; children: ReactNode; head: ReactNode }) => <div><button aria-label="Dismiss launcher" onClick={onClose} />{head}{children}</div> }))
vi.mock('./ActionSheet', () => ({ ActionSheet: ({ actions, onClose }: { actions: { label: string; onPress: () => void; disabled?: boolean }[]; onClose: () => void }) => <div>{actions.map(action => <button key={action.label} aria-label={action.label} disabled={action.disabled} onClick={() => { action.onPress(); onClose() }} />)}</div> }))
const { NewWorkButton } = await import('./NewWorkButton')
const { NewIssueScreen } = await import('../screens/NewIssueScreen')

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function fixture(scale: number) {
  const machines = ['mine', 'remote'].map(id => ({ id, name: id, hostname: id, online: true,
    serviceAssignment: { server: false, agentExecution: true },
    availability: { epoch: 'one', daemon: true, server: false, supervisor: true },
    inventory: { os: 'linux', arch: 'x64', tools: [], agents: [{ kind: 'claude-code', installed: true, login: { state: 'in' } }] },
  })) as MachineWire[]
  const repos = Array.from({ length: 32 * scale }, (_, at) => ({ kind: 'repository',
    path: `/project/p${String(at).padStart(3, '0')}`, originUrl: `https://example.invalid/p${String(at).padStart(3, '0')}`,
    machineId: at % 2 ? 'remote' : 'mine', branch: 'main',
    worktrees: Array.from({ length: 8 }, (_, tree) => ({ path: `/project/p${String(at).padStart(3, '0')}/wt-${tree}`, branch: 'topic' })),
  })) as GitRepositoryWire[]
  const sessions = Array.from({ length: 128 * scale }, (_, at) => ({ sessionId: `s${at}`, agentKind: 'codex', status: 'live', archived: false,
    cwd: repos[at % repos.length]!.path, machineId: repos[at % repos.length]!.machineId,
    createdAt: '2026-10-01T00:00:00Z', lastActiveAt: '2026-10-01T00:00:00Z',
  })) as SessionMeta[]
  return { machines, repos, sessions }
}

it.each(['NewWorkButton', 'NewIssueScreen'] as const)('meters actual open %s at 1x/4x', async surface => {
  const samples = []
  for (const scale of [1, 4]) {
    const data = fixture(scale)
    let pool: MobxPool | null = null
    let show!: (open: boolean) => void
    function Host() {
      pool = useMobilePool()
      const [open, setOpen] = useState(false)
      show = setOpen
      return surface === 'NewWorkButton' ? <NewWorkButton /> : open ? <NewIssueScreen /> : null
    }
    const app = await renderWithMobileStore(<Host />, data)
    const attached = pool as MobxPool | null
    if (!attached) throw new Error('Mobile pool missing')
    async function measured(action: string, fn: () => unknown) {
      const result = await measureWork(async () => insideReader(`mobile.${surface}.${action}`, async () => {
        await act(async () => { await fn() })
        for (let at = 0; at < 20; at++) {
          let loaded = 0
          await act(async () => { loaded = attached!.hydrate() })
          if (!loaded) break
        }
      }), { pool: attached! })
      return { action, ...result.work }
    }
    const cells = []
    cells.push(await measured('open', () => surface === 'NewWorkButton' ? fireEvent.click(screen.getByLabelText('New work')) : show(true)))
    if (surface === 'NewWorkButton') {
      expect(screen.getByLabelText('Start in p000')).toBeTruthy()
      cells.push(await measured('repository-picker', () => fireEvent.click(screen.getByLabelText('Project, p000'))))
      cells.push(await measured('repository-choice', () => fireEvent.click(screen.getByLabelText('p002'))))
      expect(screen.getByLabelText('Start in p002')).toBeTruthy()
      cells.push(await measured('machine-picker', () => fireEvent.click(screen.getByLabelText('Machine, mine'))))
      cells.push(await measured('machine-choice', () => fireEvent.click(screen.getByLabelText('remote'))))
      expect(screen.getByLabelText('Machine, remote')).toBeTruthy()
    } else {
      expect(screen.getByRole('radio', { name: 'Repository p000' })).toBeTruthy()
      cells.push(await measured('repository-choice', () => fireEvent.click(screen.getByRole('radio', { name: 'Repository p001' }))))
      expect(screen.getByRole('radio', { name: 'Repository p001' }).getAttribute('aria-checked')).toBe('true')
      cells.push(await measured('machine-picker', () => fireEvent.click(screen.getByLabelText('Machine, Auto'))))
      cells.push(await measured('machine-choice', () => fireEvent.click(screen.getByLabelText('remote'))))
      expect(screen.getByLabelText('Machine, remote')).toBeTruthy()
    }
    cells.push(await measured('catalog', () => {
      data.repos = data.repos.map((repo, at) => at === 0 ? { ...repo, branch: 'updated' } : repo)
      return app.runtime.access.refreshRepos()
    }))
    expect(attached.row('repository', JSON.stringify(['mine', data.repos[0]!.path]))).toMatchObject({ branch: 'updated' })
    cells.push(await measured('usage', () => app.replica.applyChanges('sessions', [{ ...data.sessions[0]!, createdAt: '2026-10-03T00:00:00Z', lastActiveAt: '2026-10-03T00:00:00Z' }], [])))
    cells.push(await measured('heartbeat', () => app.replica.applyChanges('sessions', [{ ...data.sessions[0]!, createdAt: '2026-10-03T00:00:00Z', lastActiveAt: '2026-10-04T00:00:00Z' }], [])))
    if (surface === 'NewWorkButton') {
      await act(async () => { fireEvent.click(screen.getByLabelText(/^Project, /)) })
      cells.push(await measured('picker-heartbeat', () => app.replica.applyChanges('sessions', [{ ...data.sessions[1]!, lastActiveAt: '2026-10-06T00:00:00Z' }], [])))
    }
    await act(async () => { surface === 'NewWorkButton' ? fireEvent.click(screen.getByLabelText('Dismiss launcher')) : show(false) })
    cells.push(await measured('closed-heartbeat', () => app.replica.applyChanges('sessions', [{ ...data.sessions[0]!, createdAt: '2026-10-03T00:00:00Z', lastActiveAt: '2026-10-05T00:00:00Z' }], [])))
    samples.push({ scale, repositories: data.repos.length, sessions: data.sessions.length, cells })
    app.unmount(); cleanup()
  }
  console.info(`[supported launcher ${surface}]`, JSON.stringify(samples.map(sample => ({ ...sample, cells: sample.cells.map(({ action, rows, derivations, elements, elementsBy }) => ({ action, rows, derivations, elements, elementsBy })) }))))
  expect(samples).toHaveLength(2)
  for (const action of ['catalog', 'usage', 'heartbeat', 'closed-heartbeat', ...(surface === 'NewWorkButton' ? ['picker-heartbeat'] : [])]) {
    const one = samples[0]!.cells.find(cell => cell.action === action)!.rows ?? 0
    const four = samples[1]!.cells.find(cell => cell.action === action)!.rows ?? 0
    expect(four, `${surface} ${action} rows`).toBe(one)
    expect(four, `${surface} ${action} row ceiling`).toBeLessThanOrEqual(12)
  }
}, 60_000)
