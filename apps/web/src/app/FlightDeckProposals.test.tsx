// @vitest-environment happy-dom
import { readFileSync, writeFileSync } from 'node:fs'
import { MissionScreen } from '@podium/client-graph/mission-screen'
import { settled } from '@podium/client-graph/mission-view'
import { MobxPool } from '@podium/client-graph/pool'
import { attachPreferenceSource } from '@podium/client-graph/preference-source'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { autorun } from 'mobx'
import { createRef } from 'react'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FlightDeckFullGroups } from './FlightDeckFullGroups'
import { FlightDeckProposals } from './FlightDeckProposals'

const commands = vi.hoisted(() => ({ promote: vi.fn(), start: vi.fn(), close: vi.fn() }))
vi.mock('./store', () => ({
  useRuntimeSelector: (read: (value: unknown) => unknown) => read({
    renameSession: vi.fn(), trpc: { issues: {
      promote: { mutate: commands.promote }, start: { mutate: commands.start }, close: { mutate: commands.close },
    } },
  }),
}))
vi.mock('@/lib/use-harness-descriptors', () => ({ useHarnessDescriptors: () => ({ served: undefined }) }))
const stamp = '2026-10-15T12:00:00Z'
type Row = Record<string, unknown>
const issue = (id: string, seq: number, parentId: string | null, patch: Row = {}): Row => ({
  id, seq, parentId, title: `Task ${id}`, stage: 'backlog', type: 'task', audience: 'human',
  repoId: 'repo', repoPath: '/synthetic', deps: [], sortKey: String(seq),
  createdAt: stamp, updatedAt: stamp, readAt: stamp, ...patch,
})
const releases: (() => void)[] = []
beforeEach(() => { for (const cmd of Object.values(commands)) cmd.mockReset().mockResolvedValue({}) })
afterEach(() => { cleanup(); for (const release of releases.splice(0)) release() })
function deferred() {
  let resolve!: (value?: unknown) => void
  let reject!: (error: Error) => void
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function open(extra: Row[] = [], proposalPatch: Row = {}) {
  const rows = [
    issue('root', 1, null, { agentProfileId: 'mission-profile' }),
    issue('parent', 2, 'root', { agentProfileId: 'parent-profile' }),
    issue('proposal', 3, 'parent', { stage: 'proposed', startedBySession: 'author', ...proposalPatch }),
    ...extra,
  ]
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  const values = new Map<string, string>()
  const listeners = new Set<(keys: ReadonlySet<string>) => void>()
  const preferences: RoutedUiState = {
    get: key => values.get(key) ?? null,
    set: (key, value) => {
      if (value === null) values.delete(key); else values.set(key, value)
      for (const listen of listeners) listen(new Set([key]))
    },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  attachPreferenceSource(pool, preferences)
  pool.apply({ type: 'replace', rows: [
    { kind: 'repo', id: 'repo', value: { id: 'repo', repoPath: '/synthetic', prefix: 'POD' } },
    ...rows.map(row => ({ kind: 'issue' as const, id: row['id'] as string, value: row as never })),
    { kind: 'session', id: 'author', value: {
      sessionId: 'author', refRepoId: 'repo', refSeq: 7, refLetter: 'C', issueId: 'root', name: 'Author', agentKind: 'codex', status: 'live',
      cwd: '/synthetic', archived: false, createdAt: stamp, lastActiveAt: stamp, readAt: stamp,
      agentState: { phase: 'idle' },
    } as never },
  ] })
  const screen = new MissionScreen(pool, 'root', { setPreference: (key, value) => preferences.set(key, value) })
  screen.open()
  const stop = autorun(() => { void settled(() => screen.full.ready) })
  releases.push(() => { stop(); screen.close(); pool.dispose() })
  await waitFor(() => expect(settled(() => screen.full.ready)).toBe(true))
  const actions = { onSelect: vi.fn(), onMenu: vi.fn() }
  const ui = render(<>
    <FlightDeckFullGroups full={screen.full} scrollRef={createRef()} activeSessionId={null} renameTarget={null}
      onSelectSession={vi.fn()} onMenu={vi.fn()} onStatusPick={vi.fn()} onRename={vi.fn()} onRenameDone={vi.fn()} />
    <FlightDeckProposals full={screen.full} {...actions} />
  </>)
  const update = async (id: string, patch: Row) => {
    const row = rows.find(row => row['id'] === id)!
    Object.assign(row, patch)
    await act(async () => pool.apply({ type: 'batch', rows: [{ kind: 'issue', id, value: { ...row } as never }] }))
  }
  const proposal = (id = 'proposal') => ui.container.querySelector<HTMLElement>(`[data-flight-issue="${id}"]`)
  const section = () => ui.queryByTestId('flight-proposed')
  return { ui, pool, screen, rows, update, proposal, section, actions }
}

it('shows ref and live truncating title, with provenance and placement in a keyboard tooltip', async () => {
  const f = await open([], { title: 'A very long proposal title that must yield space to every action' })
  const details = within(f.proposal()!).getByRole('button', { name: /^Open POD-3/ })
  expect(details.getAttribute('aria-description')).toBe('Proposed by POD-7-C · Here in this mission')
  const user = userEvent.setup()
  details.focus()
  await user.keyboard('{Tab}{Shift>}{Tab}{/Shift}')
  expect(await f.ui.findByRole('tooltip')).toHaveProperty('textContent', details.getAttribute('aria-description'))
  expect(f.proposal()!.getAttribute('data-depth')).toBeNull()
  expect(f.proposal()!.querySelector('.flight-proposal-title')?.textContent).toContain('very long proposal')
  expect(within(f.proposal()!).getByRole('button', { name: 'Backlog' })).toBeTruthy()
  expect(within(f.proposal()!).getByRole('button', { name: 'Start' })).toBeTruthy()
  expect(within(f.proposal()!).getByRole('button', { name: 'Dismiss POD-3' })).toBeTruthy()
  capture('Proposals · full size actions and a yielding title', f.section()!)
  await f.update('proposal', { title: 'Live revised title' })
  expect(f.proposal()!.querySelector('.flight-proposal-title')?.textContent).toBe('Live revised title')
})

it.each(['backlog', 'start'] as const)('%s sends only the correct operator command, retains success before and after publication', async verb => {
  const f = await open([], { agentProfileId: 'proposal-profile', defaultAgent: 'legacy-agent', defaultModel: 'legacy-model' })
  fireEvent.click(within(f.proposal()!).getByRole('button', { name: verb === 'start' ? 'Start' : 'Backlog' }))
  const command = verb === 'start' ? commands.start : commands.promote
  await waitFor(() => expect(f.ui.getByRole('status').textContent).toBe(verb === 'start' ? 'Started' : 'In backlog'))
  expect(command).toHaveBeenCalledExactlyOnceWith({ id: 'proposal', mutationId: expect.any(String) })
  expect(verb === 'start' ? commands.promote : commands.start).not.toHaveBeenCalled()
  expect(commands.close).not.toHaveBeenCalled()
  expect(f.proposal()!.querySelector('.flight-proposal-actions')).toBeNull()
  capture(`${verb} · success before publication`, f.section()!)
  await f.update('proposal', { stage: verb === 'start' ? 'in_progress' : 'backlog' })
  expect(f.ui.container.querySelectorAll('[data-flight-issue="proposal"]')).toHaveLength(1)
  expect(f.section()!.querySelector('[data-flight-issue="proposal"]')).toBeNull()
  expect(f.section()!.textContent).toContain(verb === 'start' ? 'Started' : 'In backlog')
  expect(f.section()!.querySelector('.flight-proposal-details')?.getAttribute('aria-description')).toBe('Proposed by POD-7-C · Here in this mission')
  capture(`${verb} · receipt after publication, task appears once`, f.section()!)
  // Opening a fresh Full view drops receipts; normal server membership wins.
  f.ui.unmount()
  const reopened = render(<FlightDeckProposals full={f.screen.full} {...f.actions} />)
  expect(reopened.queryByTestId('flight-proposed')).toBeNull()
})

it.each([undefined, 'proposal-profile'])('hands profile resolution to issues.start with profile %s', async agentProfileId => {
  const f = await open([], { agentProfileId })
  fireEvent.click(within(f.proposal()!).getByRole('button', { name: 'Start' }))
  await waitFor(() => expect(commands.start).toHaveBeenCalledTimes(1))
  // No client profile/agent/model/machine fallback can override the server chain.
  expect(Object.keys(commands.start.mock.calls[0]![0]).sort()).toEqual(['id', 'mutationId'])
})

it.each(['Backlog', 'Start'])('keeps own-issue provenance and sends its own ID without reparenting on %s', async label => {
  const spin = issue('spin', 4, null, { stage: 'proposed', startedBySession: 'author', deps: [{ id: 'root', type: 'discovered-from' }] })
  const f = await open([spin])
  const row = f.proposal('spin')!
  expect(row.querySelector('.flight-proposal-details')?.getAttribute('aria-description')).toContain('Own issue')
  fireEvent.click(within(row).getByRole('button', { name: label }))
  const command = label === 'Start' ? commands.start : commands.promote
  await waitFor(() => expect(command).toHaveBeenCalledExactlyOnceWith({ id: 'spin', mutationId: expect.any(String) }))
  await f.update('spin', { stage: label === 'Start' ? 'in_progress' : 'backlog' })
  expect(f.section()!.querySelector('[data-flight-issue="spin"]')).toBeNull()
  expect(f.section()!.querySelector('[data-proposal-receipt="spin"]')?.textContent).toContain(label === 'Start' ? 'Started' : 'In backlog')
  expect(f.pool.issueObject('spin').parentId).toBeNull()
  expect(f.section()!.querySelector('[data-proposal-receipt="spin"] .flight-proposal-details')?.getAttribute('aria-description')).toContain('Own issue')

})

it.each(['Backlog', 'Start', 'Dismiss POD-3'])('blocks rapid repeated and competing submits during %s', async label => {
  const pending = deferred()
  for (const cmd of Object.values(commands)) cmd.mockReturnValue(pending.promise)
  const f = await open()
  const buttons = within(f.proposal()!).getAllByRole('button').filter(b => !b.classList.contains('flight-proposal-details'))
  const button = within(f.proposal()!).getByRole('button', { name: label })
  act(() => { fireEvent.click(button); fireEvent.click(button); for (const b of buttons) fireEvent.click(b) })
  expect(Object.values(commands).reduce((n, cmd) => n + cmd.mock.calls.length, 0)).toBe(1)
  for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(true)
  expect(f.ui.getByRole('status').textContent).toMatch(/Adding|Starting|Dismissing/)
  expect(f.actions.onSelect).not.toHaveBeenCalled()
  expect(f.screen.full.task('parent').open).toBe(true)
  await act(async () => pending.resolve())
})

it.each(['Backlog', 'Start', 'Dismiss POD-3'])('shows failure and retries %s with the same mutation identity', async label => {
  const failed = deferred()
  for (const cmd of Object.values(commands)) cmd.mockReturnValueOnce(failed.promise)
  const f = await open()
  fireEvent.click(within(f.proposal()!).getByRole('button', { name: label }))
  await act(async () => failed.reject(new Error('Operator permission denied')))
  expect(f.ui.getByRole('alert').textContent).toContain('Operator permission denied')
  expect(f.ui.queryByRole('status')).toBeNull()
  expect(within(f.proposal()!).getByRole('button', { name: 'Start' }).hasAttribute('disabled')).toBe(false)
  capture('Failed command · retry without claimed success', f.section()!)
  fireEvent.click(f.ui.getByRole('button', { name: /^Retry/ }))
  const command = label === 'Start' ? commands.start : label === 'Backlog' ? commands.promote : commands.close
  await waitFor(() => expect(command).toHaveBeenCalledTimes(2))
  expect(command.mock.calls[1]![0]).toEqual(command.mock.calls[0]![0])
  await waitFor(() => label.startsWith('Dismiss') ? expect(f.section()).toBeNull() : expect(f.ui.getByRole('status').textContent).toMatch(/Started|In backlog/))
})

it.each(['backlog', 'start'] as const)('publication before %s response shows pending, then one retained success receipt', async verb => {
  const result = deferred()
  commands[verb === 'start' ? 'start' : 'promote'].mockReturnValue(result.promise)
  const f = await open()
  fireEvent.click(within(f.proposal()!).getByRole('button', { name: verb === 'start' ? 'Start' : 'Backlog' }))
  await f.update('proposal', { stage: 'in_progress' })
  expect(f.section()!.querySelector('[data-flight-issue="proposal"]')).toBeNull()
  expect(f.ui.container.querySelectorAll('[data-flight-issue="proposal"]')).toHaveLength(1)
  expect(f.ui.getByRole('status').textContent).toMatch(/Starting|Adding/)
  await act(async () => result.resolve())
  expect(f.ui.getByRole('status').textContent).toBe(verb === 'start' ? 'Started' : 'In backlog')
})

it('does not claim success if a publication beats a rejected command; the receipt can retry', async () => {
  const result = deferred()
  commands.start.mockReturnValueOnce(result.promise)
  const f = await open()
  fireEvent.click(within(f.proposal()!).getByRole('button', { name: 'Start' }))
  await f.update('proposal', { stage: 'in_progress' })
  await act(async () => result.reject(new Error('Response lost')))
  expect(f.ui.queryByRole('status')).toBeNull()
  fireEvent.click(f.ui.getByRole('button', { name: 'Retry Start' }))
  await waitFor(() => expect(f.ui.getByRole('status').textContent).toBe('Started'))
  expect(commands.start.mock.calls[1]![0]).toEqual(commands.start.mock.calls[0]![0])
})

it.each([false, true])('Dismiss closes as declined and disappears consistently (publication first: %s)', async publicationFirst => {
  const result = deferred()
  commands.close.mockReturnValue(result.promise)
  const f = await open()
  fireEvent.click(within(f.proposal()!).getByRole('button', { name: 'Dismiss POD-3' }))
  expect(commands.close).toHaveBeenCalledExactlyOnceWith({ id: 'proposal', reason: 'declined', mutationId: expect.any(String) })
  if (publicationFirst) await f.update('proposal', { stage: 'cancelled', closedReason: 'declined', closedAt: stamp })
  await act(async () => result.resolve())
  expect(f.section()).toBeNull()
  if (!publicationFirst) await f.update('proposal', { stage: 'cancelled', closedReason: 'declined', closedAt: stamp })
  expect(f.ui.container.querySelector('[data-flight-issue="proposal"]')).toBeNull()
  expect(commands.promote).not.toHaveBeenCalled()
  expect(commands.start).not.toHaveBeenCalled()
})


it('drops proposals declined by another operator without resurrecting them', async () => {
  const f = await open()
  await f.update('proposal', { stage: 'cancelled', closedReason: 'declined', closedAt: stamp })
  expect(f.section()).toBeNull()
  expect(f.proposal()).toBeNull()
})

it('keeps a proposal subtree outside the tree and accessible through details and its menu', async () => {
  const f = await open([issue('child', 4, 'proposal')])
  expect(f.screen.full.rowIds).not.toContain('proposal')
  expect(f.screen.full.rowIds).not.toContain('child')
  const details = within(f.proposal()!).getByRole('button', { name: /^Open/ })
  fireEvent.contextMenu(details)
  expect(f.actions.onMenu.mock.calls[0]![0]).toBe(f.screen.full.task('proposal'))
  const user = userEvent.setup()
  details.focus()
  await user.keyboard('{Enter}')
  expect(f.actions.onSelect).toHaveBeenCalledExactlyOnceWith(f.screen.full.task('proposal'), true)
})

it('retains full Backlog, Start and Dismiss buttons in narrow decks while the title truncates', async () => {
  const f = await open([], { title: 'A long title for a narrow deck'.repeat(5) })
  const css = readFileSync('src/styles.css', 'utf8').split('/* Full proposal triage.')[1]!
  expect(css).toContain('.flight-proposal-actions { display:flex; align-items:center; gap:4px; flex:none; }')
  expect(css).toContain('white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0;')
  expect(css).not.toMatch(/\.flight-proposal-actions[^}]*display:\s*none/)
  for (const name of ['Backlog', 'Start', 'Dismiss POD-3']) expect(within(f.proposal()!).getByRole('button', { name })).toBeTruthy()
  capture('Narrow deck · all three actions retained', f.section()!, 300)
})

const captures: { title: string; html: string; width: number }[] = []
function capture(title: string, node: HTMLElement, width = 640) {
  if (process.env['PODIUM_PROPOSAL_REVIEW_HTML']) captures.push({ title, html: node.outerHTML, width })
}
afterAll(() => {
  const path = process.env['PODIUM_PROPOSAL_REVIEW_HTML']
  if (!path) return
  const css = readFileSync('src/styles.css', 'utf8').split('/* Full proposal triage.')[1]
  writeFileSync(path, `<!doctype html><html lang="en"><meta charset="utf-8"><title>Full proposal triage</title><style>
  :root{--foreground:#d7dae0;--text-dim:#a8adb6;--text-faint:#848a94;--destructive:#f87171;--border:#33373f;--font-mono:ui-monospace,monospace}
  *{box-sizing:border-box}body{margin:24px;background:#16171a;color:#d7dae0;font:13px system-ui}main{max-width:960px;margin:auto}h1{font-size:18px}h3{font-size:13px}button{font:inherit;color:inherit;background:none;border:0;padding:0}svg{flex:none}article>div{container-type:inline-size;border:1px solid #33373f}p{color:#a8adb6;line-height:1.5}
  /* Full proposal triage.${css}</style><main><h1>Full proposal triage</h1><p>Actual rendered acceptance fixtures with production proposal CSS. Backlog promotes, Start delegates profiles and placement to the server, and Dismiss declines. Command receipts persist for this Full opening. Publication replaces the proposal row with a compact receipt so the accepted task appears once. These are static captures of tested states.</p>${captures.map(c => `<article><h3>${c.title}</h3><div style="width:${c.width}px;max-width:100%">${c.html}</div></article>`).join('')}</main></html>`)
})
