type Item = Record<string, unknown>

const field = (item: Item, key: string) => typeof item[key] === 'string' ? item[key] as string : null
const itemId = (item: Item) => field(item, 'id') ?? field(item, 'itemId') ?? field(item, 'eventId')

/** Turn-scoped, content-free Stop evidence: preserve IDs/structure/classification, not text. */
export function scoreStoppedTurn(items: Item[], finalNonce: string) {
  const seen = new Set<string>()
  const matches = items.flatMap((item) => {
    const text = field(item, 'text') ?? ''
    const role = field(item, 'role')
    const event = field(item, 'event')
    const id = itemId(item)
    const classification = role === 'user' && text.includes(finalNonce)
      ? 'user-prompt'
      : event === 'interrupt' || /request interrupted by user/i.test(text)
        ? 'interrupt-marker'
        : role === 'assistant' && text.includes(finalNonce)
          ? 'assistant-final'
          : text.includes(finalNonce) ? 'other-match' : null
    if (classification === null) return []
    const projectionDuplicate = id !== null && seen.has(id)
    if (id !== null) seen.add(id)
    return [{
      itemId: id,
      kind: field(item, 'kind') ?? field(item, 'type'),
      role,
      event,
      classification,
      source: field(item, 'source') ?? field(item, 'projection'),
      projection: field(item, 'projection'),
      turnId: field(item, 'turnId') ?? field(item, 'turn_id'),
      messageId: field(item, 'messageId') ?? field(item, 'message_id'),
      sessionItemType: field(item, 'type'),
      projectionDuplicate,
      textClassification: text.length === 0 ? 'empty' : 'present-not-preserved',
    }]
  })
  const durableIds = new Set(matches.filter((m) => m.classification === 'interrupt-marker' && m.itemId !== null).map((m) => m.itemId))
  return {
    matches,
    rawInterruptMatchCount: matches.filter((m) => m.classification === 'interrupt-marker').length,
    distinctDurableInterruptCount: durableIds.size,
    anonymousInterruptMatchCount: matches.filter((m) => m.classification === 'interrupt-marker' && m.itemId === null).length,
    userPromptNonceSeen: matches.some((m) => m.classification === 'user-prompt'),
    assistantFinalSeen: matches.some((m) => m.classification === 'assistant-final'),
  }
}

if (import.meta.main) {
  const nonce = 'FINAL-NONCE'
  const prompt = { id: 'u1', role: 'user', text: `Only then print ${nonce}` }
  const marker = { id: 'i1', role: 'system', kind: 'event', event: 'interrupt', text: 'Request interrupted by user' }
  const sameProjection = { ...marker, kind: 'transcript-projection' }
  const one = scoreStoppedTurn([prompt, marker, sameProjection], nonce)
  if (!one.userPromptNonceSeen || one.assistantFinalSeen) throw Error('prompt/final classification')
  if (one.rawInterruptMatchCount !== 2 || one.distinctDurableInterruptCount !== 1) throw Error('projection dedupe')
  if (one.matches.filter((m) => m.projectionDuplicate).length !== 1) throw Error('duplicate preservation')
  const two = scoreStoppedTurn([marker, { ...marker, id: 'i2' }], nonce)
  if (two.distinctDurableInterruptCount !== 2) throw Error('distinct IDs collapsed')
  const final = scoreStoppedTurn([prompt, { id: 'a1', role: 'assistant', text: nonce }], nonce)
  if (!final.assistantFinalSeen) throw Error('assistant final missed')
  console.log('r14 stop scorer self-tests: PASS')
}
