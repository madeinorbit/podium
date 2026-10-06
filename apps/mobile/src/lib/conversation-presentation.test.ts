import { TranscriptGraph } from '@podium/client-core/conversation'
import type { TranscriptItem } from '@podium/model'
import { observable, runInAction } from 'mobx'
import { expect, it } from 'vitest'
import { MobileConversationPresentation } from './conversation-presentation'
import { buildMobileTranscript, shapeMobileChatRow, searchMobileTranscript } from './transcript-feed'

const item = (id: string, role: TranscriptItem['role'], text = '', extra: Partial<TranscriptItem> = {}): TranscriptItem =>
  ({ id, role, text, ...extra })
const call = (id: string, use = id) => item(id, 'tool', '', { toolName: 'Read', toolUseId: use, toolInput: id, durationMs: 10 })
const result = (id: string, use: string, text = 'needle') => item(id, 'tool', '', { toolUseId: use, toolResult: text })
const envelope = '[podium message msg_a · from system:auto-continue · to your session]\nneedle\n[end podium message msg_a]\n[podium message msg_b · from system:auto-continue · to your session]\nalso needle\n[end podium message msg_b]\nOperator reply'

it.each([false, true])('keeps phone rows, search and point aliases equivalent through source changes (collapse=%s)', collapseContext => {
  let items = [item('u', 'user', envelope), call('t1'), call('t2'), result('r2', 't2'),
    item('a', 'assistant', 'Answer', { answer: true }), item('blank', 'assistant'), item('stop', 'assistant', '', { event: 'interrupt' })]
  const graph = new TranscriptGraph(items)
  const phone = new MobileConversationPresentation(graph, shapeMobileChatRow, id => graph.itemPosition(id), { collapseContext })
  const check = () => {
    const oracle = buildMobileTranscript(items, { collapseContext, includeEmpty: true })
    expect(phone.snapshot()).toEqual(oracle.rows)
    expect(phone.latestAssistantKey).toBe(oracle.latestAssistantKey)
    for (const query of ['', 'needle', 'answer', 'not present', 'read']) for (const cursor of [-1, 0, 1, 3])
      expect(phone.search(query, cursor)).toEqual(searchMobileTranscript(oracle, query, cursor))
    for (const row of oracle.rows) expect(phone.positionOfKey(row.key)).toBe(oracle.positionOfKey(row.key))
    for (const block of oracle.blocks) if (oracle.positionOfKey(block.item.id) !== undefined)
      expect(phone.positionOfKey(block.item.id)).toBe(oracle.positionOfKey(block.item.id))
  }
  const apply = (changed: TranscriptItem[], insertions: { id: string; before?: string }[] = []) => {
    const values = new Map(items.map(item => [item.id, item]))
    for (const item of changed) values.set(item.id, item)
    const order = items.map(item => item.id)
    for (const insertion of insertions) {
      const at = insertion.before === undefined ? order.length : order.indexOf(insertion.before)
      order.splice(at < 0 ? order.length : at, 0, insertion.id)
    }
    items = order.map(id => values.get(id)!)
    runInAction(() => { graph.apply({ changed, insertions }); phone.apply(graph.rowPublication) })
    check()
  }
  try {
    check()
    apply([item('a', 'assistant', 'Streamed needle', { answer: true })])
    apply([result('r2', 't2', 'complete')])
    apply([call('t0')], [{ id: 't0', before: 'u' }])
    apply([item('u', 'user', envelope.replace('msg_a', 'msg_swap').replaceAll('msg_b', 'msg_a').replaceAll('msg_swap', 'msg_b'))])
    apply([item('u', 'user', 'Plain needle')])
    apply([item('new', 'assistant', 'Incoming')], [{ id: 'new' }])
    apply([item('older', 'user', 'Older'), item('latest', 'assistant', 'Tail')], [{ id: 'older', before: 't0' }, { id: 'latest' }])
    // Role/pairing identity changes deliberately take the authoritative reset path.
    apply([item('t1', 'assistant', 'Split run')])
    items = [item('replacement', 'assistant', 'Reset')]
    runInAction(() => { graph.reset(items); phone.apply(graph.rowPublication) })
    check()
  } finally { phone.dispose(); graph.dispose() }
})

it('changes hidden question membership and skips blank/interrupt assistant facts exactly', () => {
  const hidden = observable.box<string | undefined>('ask')
  const ask = item('ask', 'tool', '', { toolName: 'AskUserQuestion', toolInputJson: '{"questions":[]}' })
  let items = [item('answer', 'assistant', 'Done'), ask]
  const graph = new TranscriptGraph(items)
  const phone = new MobileConversationPresentation(graph, shapeMobileChatRow, id => graph.itemPosition(id), {
    hiddenQuestionId: () => hidden.get(),
  })
  try {
    expect(phone.positionOfKey('ask')).toBeUndefined()
    runInAction(() => {
      hidden.set(undefined)
      graph.apply({ changed: [item('answer', 'assistant', 'Updated')] })
      phone.apply(graph.rowPublication)
    })
    items = [item('answer', 'assistant', 'Updated'), ask]
    expect(phone.snapshot()).toEqual(buildMobileTranscript(items, { includeEmpty: true }).rows)
    expect(phone.positionOfKey('ask')).toBe(1)
    runInAction(() => {
      hidden.set('ask')
      graph.apply({ changed: [{ ...ask, toolResult: 'Chosen' }] })
      phone.apply(graph.rowPublication)
    })
    expect(phone.row('ask')?.kind).toBe('receipt')
  } finally { phone.dispose(); graph.dispose() }
})

it('publishes arrivals only for unseen tail slots and retains quiet-run duration through prefix rekeys', () => {
  const graph = new TranscriptGraph([call('first')])
  const phone = new MobileConversationPresentation(graph, shapeMobileChatRow, id => graph.itemPosition(id))
  const change = (changed: TranscriptItem[], insertions: { id: string; before?: string }[]) => runInAction(() => {
    graph.apply({ changed, insertions }); phone.apply(graph.rowPublication)
  })
  try {
    change([call('last')], [{ id: 'last' }])
    expect(phone.appendCount).toBe(0) // Existing folded row receives another child.
    change([call('prefix')], [{ id: 'prefix', before: 'first' }])
    expect(phone.positionOfKey('last')).toBe(0)
    expect(phone.row('prefix')?.run?.durationMs).toBe(30)
    change([item('answer', 'assistant', 'New')], [{ id: 'answer' }])
    expect(phone.appendCount).toBe(1)
    expect(phone.arrivalKeys).toEqual(new Set(['answer']))
    const version = phone.version
    change([item('answer', 'assistant', 'Stream')], [])
    expect(phone.version).toBe(version)
    expect(phone.appendCount).toBe(1)
    change([item('older', 'user', 'Page')], [{ id: 'older', before: 'prefix' }])
    expect(phone.appendCount).toBe(1)
    expect(phone.arrivalKeys.size).toBe(0)
  } finally { phone.dispose(); graph.dispose() }
})
