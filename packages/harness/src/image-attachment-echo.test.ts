import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { claudePromptTextMatches, promptEntryMatches } from './accept-correlation.js'
import { claudeCodeManifest } from './adapters/claude-code/index.js'
import { claudeRecordReceipts, claudeRecordToItems } from './adapters/claude-code/transcript.js'
import { codexManifest } from './adapters/codex/index.js'
import { codexRecordToItems } from './adapters/codex/transcript.js'
import { grokManifest } from './adapters/grok/index.js'
import { grokRecordToItems } from './adapters/grok/transcript.js'

/**
 * A SEND WITH ATTACHMENTS IS PROVEN BY THE ENTRY THE PROGRAM WROTE (POD-5923).
 *
 * The terminal driver types each attachment's path on its own line ahead of
 * the text. These tests read what the real CLIs recorded for exactly that,
 * typed through Podium's own paste into a scratch HOME against a fake model
 * (docs/measurements/pod-5923-image-attachments): Claude Code 2.1.283, 2.1.286
 * and 2.1.295, Codex 0.162.0 and Grok 1.0.46.
 */
const DIR = fileURLToPath(
  new URL('../../../docs/measurements/pod-5923-image-attachments/', import.meta.url),
)

type Row = {
  case: string
  busy: boolean
  paths: string[]
  text: string
  typed: string
  records: { source: string; record: Record<string, unknown> }[]
}
const rows = (label: string): Row[] =>
  readFileSync(`${DIR}${label}.jsonl`, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row)

type Program = 'claude' | 'codex' | 'grok'
const LANES: { label: string; program: Program }[] = [
  { label: 'claude-2.1.283', program: 'claude' },
  { label: 'claude-2.1.286', program: 'claude' },
  { label: 'claude-2.1.295', program: 'claude' },
  { label: 'codex-0.162.0', program: 'codex' },
  { label: 'grok-1.0.46', program: 'grok' },
]
const manifests = { claude: claudeCodeManifest, codex: codexManifest, grok: grokManifest }
const echoFor = (program: Program) => {
  const echo = manifests[program].runtime.terminal.acceptCorrelation?.['transcript-echo']
  if (!echo?.entryMatches) throw new Error(`${program}: no measured entry matcher`)
  return echo
}

/** Every case's items, read by the production reader in file order. Grok's
 *  reader takes the record before (in `updates.jsonl`) as context. */
function itemsByCase(label: string, program: Program): Map<string, TranscriptItem[]> {
  const out = new Map<string, TranscriptItem[]>()
  let previous: unknown
  for (const row of rows(label)) {
    const items: TranscriptItem[] = []
    for (const { source, record } of row.records) {
      if (program === 'grok') {
        if (!source.endsWith('/updates.jsonl')) continue
        items.push(...grokRecordToItems(record, previous))
        previous = record
      } else if (program === 'codex') {
        items.push(...codexRecordToItems(record))
      } else {
        items.push(...claudeRecordReceipts(record), ...claudeRecordToItems(record))
      }
    }
    out.set(row.case, items)
  }
  return out
}

/** Two sends no record can tell apart: the same words, and the same kinds of
 *  attachment in the same number (a recorded image does not keep its path). */
const indistinguishable = (a: Row, b: Row): boolean =>
  a.text === b.text &&
  JSON.stringify(a.paths.map((p) => p.split('.').pop())) ===
    JSON.stringify(b.paths.map((p) => p.split('.').pop()))

describe.each(LANES)('$label: attachment sends', ({ label, program }) => {
  const cases = rows(label)
  const items = itemsByCase(label, program)
  const echo = echoFor(program)

  it.each(cases.map((row) => [row.case, row] as const))(
    '%s: exactly one prompt entry, and it is the send',
    (_, row) => {
      const entries = (items.get(row.case) ?? []).filter(
        (item) => item.queued !== true && echo.accepts(item),
      )
      expect(entries).toHaveLength(1)
      const entry = entries[0]!
      expect(echo.entryMatches?.(row.typed, entry)).toBe(true)
      // Only its own send, or one no record could tell apart from it.
      for (const other of cases) {
        expect(echo.entryMatches?.(other.typed, entry), `${row.case} vs ${other.case}`).toBe(
          indistinguishable(row, other),
        )
      }
    },
  )

  it.each(cases.filter((row) => row.busy).map((row) => [row.case, row] as const))(
    '%s: a queue record typed while busy holds that send',
    (_, row) => {
      const queued = (items.get(row.case) ?? []).filter((item) => item.queued === true)
      if (program !== 'claude') return expect(queued).toEqual([])
      expect(queued).toHaveLength(1)
      expect(echo.entryMatches?.(row.typed, queued[0]!)).toBe(true)
    },
  )
})

describe("Claude's image prompt text", () => {
  const items = itemsByCase('claude-2.1.295', 'claude')
  const entry = (name: string) =>
    (items.get(name) ?? []).find((item) => item.role === 'user' && item.promptEntry !== false)

  it("keeps the person's trailing spaces: the record kept them", () => {
    expect(entry('trailing-spaces')?.text).toBe(
      'IMG3 first line ends with a space \nsecond line ends with two  \nthird line',
    )
  })

  it("names the image the record carries and the path from its companion record", () => {
    const all = items.get('two-images') ?? []
    expect(entry('two-images')).toMatchObject({
      text: 'IMG2 compare these two images',
      tags: [{ kind: 'image' }, { kind: 'image' }],
    })
    // The paths ride in the isMeta companion, shown with the prompt, never an entry.
    const companion = all.find((item) => item.toolPaths?.length === 2)
    expect(companion).toMatchObject({ text: '', promptEntry: false })
    expect(companion?.harnessRef).toBeUndefined()
  })

  it('a text file path stays a line of the text', () => {
    expect(entry('text-file-then-image')?.text).toMatch(/^\/.*\.txt\nMIX2 a text file then an image$/)
  })
})

/**
 * THE GUARDS. Each rule that lets an image stand for a typed line is held to
 * the opposite case: the shapes it must still refuse.
 */
describe('promptEntryMatches refuses what the program did not do', () => {
  const path = '/home/u/.podium/uploads/s1/a.png'
  const other = '/home/u/.podium/uploads/s1/b.png'
  const image = { kind: 'image' as const }
  const entry = (text: string, images: number, toolPaths?: string[]): TranscriptItem => ({
    id: 'e',
    role: 'user',
    text,
    ...(images ? { tags: Array.from({ length: images }, () => image) } : {}),
    ...(toolPaths ? { toolPaths } : {}),
  })
  const matches = (typed: string, item: TranscriptItem) =>
    promptEntryMatches(claudePromptTextMatches, typed, item)

  it('matches the measured shapes', () => {
    expect(matches(`${path}\nlook`, entry('look', 1))).toBe(true)
    expect(matches(`${path}\n${other}\nlook`, entry('look', 2))).toBe(true)
    expect(matches(path, entry('', 1))).toBe(true)
    expect(matches(`${path}\nlook`, entry('look', 1, [path]))).toBe(true)
    expect(matches(path, entry('[Image #1]', 0))).toBe(true)
    expect(matches(`${path}\n${other}`, entry('[Image #3] [Image #4]', 0))).toBe(true)
  })

  it('an image stands only for a path line, and one image for one line', () => {
    expect(matches('not a path\nlook', entry('look', 1))).toBe(false)
    expect(matches(`${path}\nlook`, entry('look', 2))).toBe(false)
    expect(matches(`${path}\n${other}\nlook`, entry('look', 1))).toBe(false)
    expect(matches(`${path}\nlook`, entry('look', 0))).toBe(false)
  })

  it('the rest of the text must still be the same words, spaces included', () => {
    expect(matches(`${path}\nlook \nmore`, entry('look\nmore', 1))).toBe(false)
    expect(matches(`${path}\nlook\nmore`, entry('look', 1))).toBe(false)
    expect(matches(`${path}\nlook`, entry('', 1))).toBe(false)
    expect(matches(path, entry('look', 1))).toBe(false)
  })

  it('paths the entry names must be the lines removed', () => {
    expect(matches(`${path}\nlook`, entry('look', 1, [other]))).toBe(false)
  })

  it('an entry with no image and no text proves nothing', () => {
    expect(matches(path, entry('', 0))).toBe(false)
    expect(matches('', entry('', 1))).toBe(false)
  })
})
