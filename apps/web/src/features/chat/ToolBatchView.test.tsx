import { asSessionId, type TranscriptItem } from '@podium/model'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildChatRows, pairToolResults, type ToolBatchRow } from './chat'
import { ToolBatchView } from './ToolBatchView'

// react-dom's act() needs this flag to drive effects/lazy flushes without warnings.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The diff sheet reads through the store, and this suite mounts a work line
// rather than an app. What it asserts is that a file edit ROUTES to the sheet;
// the sheet's own fetching has its own suite (features/git/DiffSheet.test.tsx).
// `gitDiffFile` answers with nothing on purpose: a chat-opened diff must come
// from the transcript, so any row on screen proves git was not the source.
const git = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('@/app/store', () => ({
  useStoreSelector: (sel: (s: unknown) => unknown) =>
    sel({
      gitDiffFile: async ({ path }: { path: string }) => {
        git.calls.push(path)
        return { ok: true, output: '' }
      },
      readFileScoped: async () => ({ ok: true, content: '' }),
    }),
}))

// The work line (POD-364): a run of tool calls is one progress object. Live it
// names the call in flight and counts up; settled it summarizes. What must never
// regress: a failure stays visible on the COLLAPSED row, and the count is always
// on the row so the operator can see how much happened without unfolding.

let host: HTMLDivElement
let root: Root

const call = (over: Partial<TranscriptItem> & { id: string }): TranscriptItem => ({
  role: 'tool',
  text: '',
  toolName: 'Read',
  ...over,
})

function batchOf(items: TranscriptItem[]): ToolBatchRow {
  const rows = buildChatRows(pairToolResults(items))
  const row = rows[0]
  if (!row || row.kind !== 'tools') throw new Error('expected a tools row')
  return row
}

function mount(
  row: ToolBatchRow,
  live = false,
  waiting?: { label: string; detail?: string },
): void {
  act(() => {
    root.render(
      <ToolBatchView
        row={row}
        index={0}
        highlighted={false}
        dimmed={false}
        forceOpen={false}
        live={live}
        waiting={waiting}
        sessionId={asSessionId('s1')}
        cwd="/r"
        openFile={() => {}}
      />,
    )
  })
}

/**
 * The sheet is a lazy chunk (the chat must not pay for it on open). A 200ms
 * poll lost the race with the first transform of that chunk, so the wait is
 * the import the click already started — then one more act() to paint it.
 */
async function waitForDiffSheet(): Promise<Element> {
  await act(async () => {
    await import('@/features/git/DiffSheet')
  })
  const sheet = host.querySelector('[data-testid="diff-sheet"]')
  if (!sheet) throw new Error('expected the file-edit to open the diff sheet')
  return sheet
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('ToolBatchView — the work line', () => {
  it('sheds secondary chrome progressively when its own inline size contracts', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../styles.css'), 'utf8')
    const workLine = css.match(/\.work-line \{(?<body>[^}]*)\}/)?.groups?.body ?? ''
    const frontTier = css.match(/\.work-line-deck i \{(?<body>[^}]*)\}/)?.groups?.body ?? ''
    const rearTier =
      css.match(/\.work-line-deck i:last-child \{(?<body>[^}]*)\}/)?.groups?.body ?? ''
    const elapsedRung = css.indexOf('@container work-line (max-width: 280px)')
    const countRung = css.indexOf('@container work-line (max-width: 120px)')
    const disclosureRung = css.indexOf('@container work-line (max-width: 92px)')

    expect(workLine).toContain('container-type: inline-size')
    expect(frontTier).toMatch(/right: min\(9px, 8%\)[\s\S]*left: min\(9px, 8%\)/)
    expect(frontTier).toContain('min(8px, 3cqi)')
    expect(rearTier).toMatch(/right: min\(18px, 16%\)[\s\S]*left: min\(18px, 16%\)/)
    expect(elapsedRung).toBeGreaterThan(-1)
    expect(countRung).toBeGreaterThan(elapsedRung)
    expect(disclosureRung).toBeGreaterThan(countRung)
    expect(css.slice(elapsedRung, countRung)).toMatch(/\.work-line-time\s*\{[^}]*display: none/s)
    expect(css.slice(countRung, disclosureRung)).toMatch(/\.work-line-count\s*\{[^}]*display: none/s)
    expect(css.slice(disclosureRung)).toMatch(/\.work-line-chev\s*\{[^}]*display: none/s)
  })

  it('names the call in flight and counts up while live', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-08-03T10:00:07.000Z'))
    mount(
      batchOf([
        call({ id: 'a', ts: '2026-08-03T10:00:00.000Z' }),
        call({
          id: 'b',
          toolName: 'Edit',
          toolPaths: ['/r/apps/web/src/ChatView.tsx'],
          ts: '2026-08-03T10:00:05.000Z',
        }),
      ]),
      true,
    )
    const line = host.querySelector('[data-testid="work-line"]')!
    expect(line.getAttribute('data-state')).toBe('live')
    expect(line.querySelector('.work-line-phrase')?.textContent).toBe('Editing ChatView.tsx')
    expect(line.querySelector('.work-line-count')?.textContent).toBe('2')
    // Counted from the FIRST call, not the latest one.
    expect(line.querySelector('.work-line-time')?.textContent).toBe('0:07')
  })

  it('summarizes the run once it settles, with no live timer', () => {
    mount(
      batchOf([
        call({ id: 'a', ts: '2026-08-03T10:00:00.000Z' }),
        call({ id: 'b', toolName: 'Bash', ts: '2026-08-03T10:00:09.000Z' }),
      ]),
    )
    const line = host.querySelector('[data-testid="work-line"]')!
    expect(line.getAttribute('data-state')).toBe('done')
    expect(line.querySelector('.work-line-phrase')?.textContent).toBe('Read a file, ran a command')
    expect(line.querySelector('.work-line-time')?.textContent).toBe('0:09')
  })

  it('renders a named external wait without a second spinner', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-08-03T10:00:07.000Z'))
    mount(
      batchOf([
        call({
          id: 'b',
          toolName: 'Bash',
          toolTitle: 'tests',
          ts: '2026-08-03T10:00:00.000Z',
        }),
      ]),
      true,
      { label: 'Waiting on shell', detail: 'tests' },
    )
    const line = host.querySelector('[data-testid="work-line"]')!
    expect(line.getAttribute('data-state')).toBe('wait')
    expect(line.querySelector('.work-line-phrase')?.textContent).toBe('Waiting on shell · tests')
    expect(line.querySelector('.pod-mark')).toBeNull()
    expect(line.querySelector('.work-line-glyph')?.textContent).toBe('◇')
  })

  it('keeps a failure on the collapsed row', () => {
    mount(
      batchOf([
        call({ id: 'a', toolUseId: 'u1' }),
        call({ id: 'a-res', toolUseId: 'u1', toolResult: 'ok' }),
        call({ id: 'b', toolName: 'Bash', toolUseId: 'u2' }),
        call({ id: 'b-res', toolUseId: 'u2', toolResult: 'Error: exit code 1' }),
      ]),
    )
    const line = host.querySelector('[data-testid="work-line"]')!
    expect(line.getAttribute('data-open')).toBe('false')
    expect(line.querySelector('.work-line-fail')?.textContent).toContain('1 failed')
    expect(line.querySelector('.work-line-glyph')?.className).toContain('work-line-glyph--err')
    expect(line.querySelector('.work-line-row')?.getAttribute('aria-label')).toBe(
      'Read a file, ran a command. 2 calls. 1 failed.',
    )
  })

  it('unfolds a file-edit into its diff, not the tool result text', async () => {
    const json = JSON.stringify({
      kind: 'file-edit',
      path: 'ChatView.tsx',
      mode: 'replace',
      hunks: [{ path: 'ChatView.tsx', oldText: 'const a = 1', newText: 'const a = 2' }],
      added: 1,
      removed: 1,
    })
    mount(
      batchOf([
        call({
          id: 'e',
          toolName: 'Edit',
          toolInput: 'ChatView.tsx',
          toolInputJson: json,
          toolUseId: 'u1',
        }),
        call({ id: 'e-res', toolUseId: 'u1', toolResult: 'The file has been updated.' }),
      ]),
    )
    const line = host.querySelector('[data-testid="work-line"]')!
    act(() => {
      line.querySelector<HTMLButtonElement>('.work-line-row')!.click()
    })
    // NOTHING ON THE FIRST LAYER (POD-993 round 3). The unfolded run names the
    // calls and stops: no magnitude, no preview of what each one returned.
    expect(line.querySelector('.tool-out-line')).toBeNull()
    expect(line.querySelector('.tool-row')?.textContent).toContain('Edit')
    expect(line.querySelector('.tool-subject')?.textContent).toBe('ChatView.tsx')
    // A file edit opens the run's diff SHEET rather than an inline diff cramped
    // into a work line inside a transcript row.
    act(() => {
      line.querySelector<HTMLButtonElement>('.tool-row')!.click()
    })
    expect(line.querySelector('[data-testid="tool-edit-diff"]')).toBeNull()
    const sheet = await waitForDiffSheet()

    // AND IT SHOWS THE RUN'S OWN DIFF. `git diff` would answer "what does this
    // file hold NOW" — nothing, for an edit already committed — which is what
    // the first cut of this did. The rows come from what the tool recorded.
    expect(sheet.textContent).toContain('const a = 1')
    expect(sheet.textContent).toContain('const a = 2')
    expect(git.calls).toEqual([])
    // Nothing to re-probe: there is no working tree behind a recorded edit.
    expect(sheet.parentElement?.querySelector('.animate-spin')).toBeNull()
  })

  it('unfolds and refolds the individual calls on the same click target', () => {
    mount(
      batchOf([
        call({ id: 'a', toolTitle: 'a.ts', toolUseId: 'u1' }),
        call({ id: 'a-result', toolUseId: 'u1', toolResult: 'ok' }),
        call({ id: 'b', toolName: 'Bash', toolInput: 'ls -la' }),
      ]),
    )
    const line = host.querySelector('[data-testid="work-line"]')!
    expect(line.querySelector('.work-line-list')).toBeNull()
    act(() => {
      line.querySelector<HTMLButtonElement>('.work-line-row')!.click()
    })
    expect(line.getAttribute('data-open')).toBe('true')
    expect(line.querySelectorAll('.work-line-list .tool-row')).toHaveLength(2)
    expect(line.querySelector('.tool-subject')?.textContent).toBe('a.ts')
    // The call's own output is one more click away, on the call.
    expect(line.querySelector('.tool-out-line')).toBeNull()
    act(() => {
      line.querySelector<HTMLButtonElement>('.tool-row')!.click()
    })
    expect(line.querySelector('.tool-result-full')?.textContent).toBe('ok')
    act(() => {
      line.querySelector<HTMLButtonElement>('.tool-row')!.click()
    })
    act(() => {
      line.querySelector<HTMLButtonElement>('.work-line-row')!.click()
    })
    expect(line.getAttribute('data-open')).toBe('false')
    expect(line.querySelector('.work-line-list')).toBeNull()
  })

  it('drops the fanned deck for a lone call — nothing is folded behind it', () => {
    mount(batchOf([call({ id: 'a' })]))
    expect(host.querySelector('[data-testid="work-line"]')?.getAttribute('data-single')).toBe(
      'true',
    )
  })

  it('shows no timer at all when the transcript carries no timestamps', () => {
    mount(batchOf([call({ id: 'a' }), call({ id: 'b' })]))
    expect(host.querySelector('.work-line-time')).toBeNull()
  })
})

// POD-993 round 7: the hover preview is retired. Unfolding answers "which
// calls" and is the gesture a reader reaches for anyway; what survives is the
// panel's SHORT TEXT, now on the unfolded rows (see ToolBlock).
describe('ToolBatchView — the folded run has no hover panel', () => {
  it('keeps the native title on every folded run, previewable or not', () => {
    // A multi-call run used to DROP its title so the native tooltip could not
    // race the panel's. With no panel, every run carries it again.
    mount(batchOf([call({ id: 'a' }), call({ id: 'b' })]))
    expect(host.querySelector('.work-line-row')?.getAttribute('title')).toBe('Read 2 files')
    mount(batchOf([call({ id: 'a' })]))
    expect(host.querySelector('.work-line-row')?.getAttribute('title')).toBe('Read a file')
  })

  it('mounts no panel on hover or focus', () => {
    mount(batchOf([call({ id: 'a' }), call({ id: 'b' })]))
    const rowEl = host.querySelector('.work-line-row') as HTMLElement
    act(() => {
      rowEl.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
      rowEl.focus()
    })
    expect(document.querySelector('.work-line-preview')).toBeNull()
  })
})

describe('ToolBatchView — the settle', () => {
  it('does not settle on mount — a transcript of finished runs replays nothing', () => {
    mount(batchOf([call({ id: 'a' }), call({ id: 'b' })]))
    expect(host.querySelector('[data-testid="work-line"]')?.hasAttribute('data-settle')).toBe(false)
  })

  it('plays one morph when a live run resolves, then holds still', () => {
    vi.useFakeTimers()
    const row = batchOf([call({ id: 'a' }), call({ id: 'b' })])
    mount(row, true)
    const line = (): Element => host.querySelector('[data-testid="work-line"]')!
    expect(line().hasAttribute('data-settle')).toBe(false)
    mount(row, false)
    expect(line().getAttribute('data-settle')).toBe('true')
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(line().hasAttribute('data-settle')).toBe(false)
  })
})

/**
 * THE RAIL IS WHAT THE RUN CHANGED (POD-993 round 5).
 *
 * It was built from `toolPaths` — every path any call reported, reads included
 * — so a run that edited one file and read two listed three, disagreeing with
 * the "1 edit" on the folded line right behind it. Worse, a read has no
 * recorded diff, so opening one fell through to `git diff` on a path git could
 * not accept. An agent reads and writes plenty of files outside the repo it is
 * working in — its own memory, a log, something under /tmp — and the reported
 * failure was exactly that:
 *
 *     fatal: '/home/podium/.claude/projects/…/land-locally-no-push.md' is
 *     outside repository at '/home/podium/podium/.worktrees/issue-1122-…'
 */
describe('ToolBatchView — the diff rail lists edits, not everything touched', () => {
  const edit = (path: string): string =>
    JSON.stringify({
      kind: 'file-edit',
      path,
      mode: 'replace',
      hunks: [{ path, oldText: 'a', newText: 'b' }],
      added: 1,
      removed: 1,
    })

  const openSheet = async (): Promise<Element> => {
    const line = host.querySelector('[data-testid="work-line"]')!
    act(() => {
      line.querySelector<HTMLButtonElement>('.work-line-row')!.click()
    })
    const openable = host.querySelector<HTMLButtonElement>('.tool-row[title^="Open "]')!
    act(() => {
      openable.click()
    })
    return waitForDiffSheet()
  }

  it('leaves out a file the run only read, and never asks git about it', async () => {
    git.calls.length = 0
    mount(
      batchOf([
        call({
          id: 'e',
          toolName: 'Edit',
          toolInput: 'ChatView.tsx',
          toolInputJson: edit('/r/apps/web/ChatView.tsx'),
          toolUseId: 'u1',
        }),
        call({ id: 'e-res', toolUseId: 'u1', toolResult: 'ok' }),
        // A read of a file OUTSIDE the repo — the shape that produced the fatal.
        call({
          id: 'r',
          toolName: 'Read',
          toolInput: 'memory.md',
          toolPaths: ['/home/podium/.claude/projects/x/memory.md'],
          toolUseId: 'u2',
        }),
        call({ id: 'r-res', toolUseId: 'u2', toolResult: 'ok' }),
      ]),
    )
    const sheet = await openSheet()
    expect(sheet.textContent).toContain('ChatView.tsx')
    expect(sheet.textContent).not.toContain('memory.md')
    // Every entry now has a transcript diff, so git is never consulted at all.
    expect(git.calls).toEqual([])
  })

  it('shows an edited path relative to the session, not as an absolute one', async () => {
    mount(
      batchOf([
        call({
          id: 'e',
          toolName: 'Edit',
          toolInput: 'ChatView.tsx',
          toolInputJson: edit('/r/apps/web/ChatView.tsx'),
          toolUseId: 'u1',
        }),
        call({ id: 'e-res', toolUseId: 'u1', toolResult: 'ok' }),
      ]),
    )
    // `cwd` is /r in this suite, so the rail reads apps/web/… and the sheet's
    // dir/name split has something to split.
    const sheet = await openSheet()
    expect(sheet.textContent).toContain('apps/web')
    expect(sheet.textContent).not.toContain('/r/apps/web/ChatView.tsx')
  })

  it('offers no diff on a call that changed nothing', () => {
    mount(
      batchOf([
        call({
          id: 'r',
          toolName: 'Read',
          toolInput: 'a.ts',
          toolPaths: ['/r/a.ts'],
          toolUseId: 'u1',
        }),
        call({ id: 'r-res', toolUseId: 'u1', toolResult: 'ok' }),
      ]),
    )
    const line = host.querySelector('[data-testid="work-line"]')!
    act(() => {
      line.querySelector<HTMLButtonElement>('.work-line-row')!.click()
    })
    // The row unfolds in place instead — a read has nothing to diff.
    expect(line.querySelector('.tool-row[title^="Open "]')).toBeNull()
  })
})
