import type { ChatRow, RenderableRow } from '@podium/client-core/values'
import { buildChatRows, pairToolResults, transcriptActivityFacts } from '@podium/client-core/values'
import type { TranscriptItem } from '@podium/model'
import { expect, it } from 'vitest'
import { foldLayout, foldLead, TurnFoldState, turnFolds } from './turn-fold'

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 31, 12, 0, seconds)).toISOString()
const say = (id: string, answer = false, ts = at(1)): TranscriptItem => ({
  id,
  role: 'assistant',
  text: id,
  answer,
  ts,
})
const tool = (id: string, extra: Partial<TranscriptItem> = {}): TranscriptItem => ({
  id,
  role: 'tool',
  text: '',
  toolName: 'Bash',
  toolInput: 'bun test',
  ts: at(2),
  ...extra,
})
const note = (id: string, to = 'issue:POD-12', ask = false): TranscriptItem => ({
  id,
  role: 'user',
  ts: at(0),
  text: `[podium message ${id} · from issue:POD-10 · to ${to}]\nReview this.\n${ask ? '[this is a question: answer the sender]\n' : ''}[end podium message ${id}]`,
})
const prompt = (row: ChatRow) =>
  row.kind === 'block' &&
  row.block.item.role === 'user' &&
  !row.block.item.event &&
  !transcriptActivityFacts(row.block.item).envelopes
const rows = (items: TranscriptItem[]): RenderableRow[] =>
  buildChatRows(pairToolResults(items)).map((row, index) => ({ row, index }))

it('has one closed live fold from the first event and keeps its key when an answer lands', () => {
  const state = new TurnFoldState()
  const first = turnFolds(rows([say('intro')]), prompt)
  expect(first.folds).toHaveLength(1)
  expect(first.trailing).toMatchObject({
    key: 'intro',
    state: 'live',
    members: [0],
    narration: 'intro',
  })
  expect(foldLayout(first, state, []).lines.get(0)?.open).toBe(false)
  state.open('intro')
  const next = turnFolds(rows([say('intro'), tool('cmd'), say('answer', true, at(12))]), prompt)
  expect(next.trailing).toMatchObject({
    key: 'intro',
    state: 'done',
    durationMs: 11000,
    members: [0, 1],
  })
  expect(foldLayout(next, state, []).lines.get(0)?.open).toBe(true)
  expect(next.byMember.has(2)).toBe(false)
})

it('leaves an answer-only exchange and pre-work notes outside the line', () => {
  expect(turnFolds(rows([note('early'), say('answer', true)]), prompt).folds).toHaveLength(0)
  const folded = turnFolds(
    rows([note('early'), say('intro'), tool('cmd'), say('answer', true)]),
    prompt,
  )
  expect(folded.trailing?.members).toEqual([1, 2])
  expect(folded.byMember.has(0)).toBe(false)
})

it('starts a note-leading activity row at its first agent call', () => {
  const folded = turnFolds(rows([note('early'), tool('cmd'), say('answer', true, at(10))]), prompt)
  expect(folded.trailing).toMatchObject({ startedAt: at(2), durationMs: 8000 })
})

it('makes an interactive question a paused seam and resumes on a new line', () => {
  const ask = tool('ask', { toolName: 'AskUserQuestion', ts: at(8) })
  const paused = turnFolds(rows([say('intro'), tool('cmd'), ask]), prompt)
  expect(paused.trailing).toMatchObject({ state: 'paused', durationMs: 7000, members: [0, 1] })
  expect(paused.byMember.has(2)).toBe(false)
  const resumed = turnFolds(
    rows([
      say('intro'),
      tool('cmd'),
      { ...ask, toolResult: 'yes' },
      say('resume', false, at(10)),
      tool('next'),
    ]),
    prompt,
  )
  expect(resumed.folds.map((fold) => [fold.key, fold.state])).toEqual([
    ['intro', 'done'],
    ['ask:work', 'live'],
  ])
})

it('keeps an operator question outside and includes its ordinary note in the opened chronology', () => {
  const result = turnFolds(
    rows([say('intro'), note('ask', 'the operator', true), tool('cmd')]),
    prompt,
  )
  expect(result.trailing?.members).toEqual([0, 1, 2])
  expect(result.trailing?.asks.has(1)).toBe(true)
  expect(foldLayout(result, new TurnFoldState(), []).hidden.has(1)).toBe(false)
})

it('keeps the latest narration as an interrupted stand-in, including a narration-only turn', () => {
  const stop: TranscriptItem = {
    id: 'stop',
    role: 'user',
    event: 'interrupt',
    text: '',
    ts: at(12),
  }
  for (const work of [[say('intro')], [say('intro'), tool('cmd'), say('latest')]]) {
    const result = turnFolds(rows([...work, stop]), prompt)
    expect(result.trailing?.state).toBe('stopped')
    expect(result.standIns.size).toBe(1)
    expect(result.byMember.has([...result.standIns][0]!)).toBe(false)
  }
})

it('absorbs churn time, respects prompt boundaries, and forces search without retaining it', () => {
  const items: TranscriptItem[] = [
    say('intro'),
    tool('cmd'),
    say('answer', true),
    { id: 'duration', role: 'system', systemKind: 'duration', durationMs: 12500, text: '' },
    { id: 'prompt', role: 'user', text: 'Again' },
    say('next'),
  ]
  const result = turnFolds(rows(items), prompt)
  expect(result.folds[0]?.durationMs).toBe(12500)
  expect(result.absorbed.has(3)).toBe(true)
  const state = new TurnFoldState()
  state.prime()
  expect(foldLayout(result, state, [1]).lines.get(0)?.open).toBe(true)
  expect(state.opened.size).toBe(0)
  expect(foldLayout(result, state, []).lines.get(0)?.open).toBe(false)
  expect(foldLead({ durationMs: 41000, state: 'done', failed: true })).toBe('Failed after 41s')
})
