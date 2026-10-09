import { autorun } from 'mobx'
import { describe, expect, it } from 'vitest'
import { TranscriptSearchIndex } from './transcript-search-index'

// These are the retained allocation owners from the native removal experiment.
// Inspect cardinalities without adding a product diagnostics API.
function retained(index: TranscriptSearchIndex) {
  const owner = index as unknown as {
    texts: Map<string, string>
    postings: Map<string, Set<string>>
    gramsById: Map<string, Set<string>>
  }
  return { texts: owner.texts.size, postings: owner.postings.size, grams: owner.gramsById.size }
}

describe('transcript search demand', () => {
  it('ingests history without retaining n-grams before or after snapshot search', () => {
    const index = new TranscriptSearchIndex(id => Number(id))
    for (let at = 0; at < 128; at++) index.set(String(at), `Item ${at}: ${'alphabet '.repeat(64)}`)
    expect(retained(index)).toEqual({ texts: 128, postings: 0, grams: 0 })
    expect(index.find('ITEM 12:')).toEqual(['12'])
    expect(retained(index)).toEqual({ texts: 128, postings: 0, grams: 0 })
  })

  it('keeps an incremental index only until the last search observer leaves', () => {
    const rank = new Map([['a',0],['b',1],['c',2]])
    const index = new TranscriptSearchIndex(id => rank.get(id)!)
    index.set('a', 'needle first')
    index.set('b', 'unrelated')
    let matches: string[] = [], reads = 0
    const stop = autorun(() => { matches = index.find('needle'); reads++ })
    const other = autorun(() => { index.find('first') })
    try {
      expect(matches).toEqual(['a'])
      expect(retained(index).postings).toBeGreaterThan(0)
      index.set('b', 'abc xyz')
      expect(reads).toBe(1)
      index.set('c', 'needle last')
      expect(matches).toEqual(['a','c'])
      index.remove('a')
      expect(matches).toEqual(['c'])
      stop()
      expect(retained(index).postings).toBeGreaterThan(0)
    } finally { stop(); other() }
    expect(retained(index)).toEqual({ texts: 2, postings: 0, grams: 0 })
    index.set('c', 'changed while search is closed')
    const reopen = autorun(() => { matches = index.find('changed') })
    try { expect(matches).toEqual(['c']) }
    finally { reopen() }
    expect(retained(index)).toEqual({ texts: 2, postings: 0, grams: 0 })
  })

  it('agrees with normalized substring search for snapshots and watched edits', () => {
    const texts = new Map([['late','ABC needle 💡'],['early','İstanbul aab'],['middle','ab needle']])
    const ranks = new Map([['early',0],['middle',1],['late',2]])
    const index = new TranscriptSearchIndex(id => ranks.get(id)!)
    for (const [id,text] of texts) index.set(id,text)
    const expected = (query: string) => {
      const key = query.trim().toLowerCase()
      return !key ? [] : [...texts].filter(([,text]) => text.toLowerCase().includes(key))
        .map(([id]) => id).sort((a,b) => ranks.get(a)!-ranks.get(b)!)
    }
    for (const query of ['', ' ', 'a', 'ab', 'abc', ' NEEDLE ', '💡', 'i̇', 'aab', 'absent']) {
      expect(index.find(query)).toEqual(expected(query))
      let matches: string[] = []
      const stop = autorun(() => { matches = index.find(query) })
      try {
        expect(matches).toEqual(expected(query))
        texts.set('middle', 'ABC 💡 aab needle updated')
        index.set('middle', texts.get('middle')!)
        expect(matches).toEqual(expected(query))
      } finally { stop() }
    }
    expect(retained(index).postings).toBe(0)
  })
})
