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

it('folds only tool work: text stays outside and keys the run after it', () => {
  const state = new TurnFoldState()
  expect(turnFolds(rows([say('intro')]), prompt).folds).toHaveLength(0)
  const first = turnFolds(rows([say('intro'), tool('cmd')]), prompt)
  expect(first.folds).toHaveLength(1)
  expect(first.trailing).toMatchObject({ key: 'intro:work', state: 'live', members: [1] })
  expect(first.byMember.has(0)).toBe(false)
  expect(foldLayout(first, state, []).lines.get(1)?.open).toBe(false)
  state.open('intro:work')
  const next = turnFolds(rows([say('intro'), tool('cmd'), say('answer', true, at(12))]), prompt)
  expect(next.trailing).toMatchObject({
    key: 'intro:work',
    state: 'done',
    durationMs: 10000,
    members: [1],
  })
  expect(foldLayout(next, state, []).lines.get(1)?.open).toBe(true)
  expect(next.byMember.has(2)).toBe(false)
})

it("ends a run at the agent's next words and opens a new one at its next call", () => {
  const result = turnFolds(
    rows([
      tool('a'),
      say('between', false, at(5)),
      tool('b', { ts: at(6) }),
      say('answer', true, at(9)),
    ]),
    prompt,
  )
  expect(result.folds.map((fold) => [fold.key, fold.state, fold.members])).toEqual([
    ['a', 'done', [0]],
    ['between:work', 'done', [2]],
  ])
  expect(result.byMember.has(1)).toBe(false)
  expect(result.folds[1]?.durationMs).toBe(3000)
})

it('leaves an answer-only exchange, pre-work notes and narration outside the line', () => {
  expect(turnFolds(rows([note('early'), say('answer', true)]), prompt).folds).toHaveLength(0)
  const folded = turnFolds(
    rows([note('early'), say('intro'), tool('cmd'), say('answer', true)]),
    prompt,
  )
  expect(folded.trailing?.members).toEqual([2])
  expect(folded.byMember.has(0)).toBe(false)
  expect(folded.byMember.has(1)).toBe(false)
})

it('starts a note-leading activity row at its first agent call', () => {
  const folded = turnFolds(rows([note('early'), tool('cmd'), say('answer', true, at(10))]), prompt)
  expect(folded.trailing).toMatchObject({ startedAt: at(2), durationMs: 8000 })
})

it('makes an interactive question a paused seam and resumes on a new line', () => {
  const ask = tool('ask', { toolName: 'AskUserQuestion', ts: at(8) })
  const paused = turnFolds(rows([say('intro'), tool('cmd'), ask]), prompt)
  expect(paused.trailing).toMatchObject({ state: 'paused', durationMs: 6000, members: [1] })
  expect(paused.byMember.has(2)).toBe(false)
  const resumed = turnFolds(
    rows([say('intro'), tool('cmd'), { ...ask, toolResult: 'yes' }, tool('next', { ts: at(10) })]),
    prompt,
  )
  expect(resumed.folds.map((fold) => [fold.key, fold.state])).toEqual([
    ['intro:work', 'done'],
    ['ask:work', 'live'],
  ])
})

it('keeps an operator question before the run outside it, and one inside the run in place', () => {
  const before = turnFolds(
    rows([say('intro'), note('ask', 'the operator', true), tool('cmd')]),
    prompt,
  )
  expect(before.trailing?.members).toEqual([2])
  expect(before.byMember.has(1)).toBe(false)
  const inside = turnFolds(
    rows([tool('cmd'), note('ask', 'the operator', true), tool('more')]),
    prompt,
  )
  expect(inside.trailing?.members).toEqual([0, 1, 2])
  expect(inside.trailing?.asks.has(1)).toBe(true)
  expect(foldLayout(inside, new TurnFoldState(), []).hidden.has(1)).toBe(false)
})

it('stops the open run at an interrupt and leaves the narration on the page', () => {
  const stop: TranscriptItem = {
    id: 'stop',
    role: 'user',
    event: 'interrupt',
    text: '',
    ts: at(12),
  }
  expect(turnFolds(rows([say('intro'), stop]), prompt).folds).toHaveLength(0)
  const running = turnFolds(rows([say('intro'), tool('cmd'), stop]), prompt)
  expect(running.trailing).toMatchObject({ state: 'stopped', members: [1] })
  const spoke = turnFolds(rows([say('intro'), tool('cmd'), say('latest'), stop]), prompt)
  expect(spoke.folds.map((fold) => fold.state)).toEqual(['done'])
  expect(spoke.standIns.size).toBe(0)
  expect(spoke.byMember.has(2)).toBe(false)
})

it('absorbs churn time only into a fold that is the whole turn', () => {
  const duration: TranscriptItem = {
    id: 'duration',
    role: 'system',
    systemKind: 'duration',
    durationMs: 12500,
    text: '',
  }
  const whole = turnFolds(
    rows([
      tool('cmd'),
      say('answer', true),
      duration,
      { id: 'prompt', role: 'user', text: 'Again' },
      say('next'),
    ]),
    prompt,
  )
  expect(whole.folds[0]?.durationMs).toBe(12500)
  expect(whole.absorbed.has(2)).toBe(true)
  const state = new TurnFoldState()
  state.prime()
  expect(foldLayout(whole, state, [0]).lines.get(0)?.open).toBe(true)
  expect(state.opened.size).toBe(0)
  expect(foldLayout(whole, state, []).lines.get(0)?.open).toBe(false)
  const part = turnFolds(
    rows([say('intro'), tool('cmd'), say('answer', true, at(4)), duration]),
    prompt,
  )
  expect(part.absorbed.size).toBe(0)
  expect(part.folds[0]?.durationMs).toBe(2000)
  expect(foldLead({ durationMs: 41000, state: 'done', failed: true })).toBe('Failed after 41s')
})
