import { describe, expect, it } from 'vitest'
import {
  BOOTSTRAP_VIEW_MAX_INSTANCES,
  BOOTSTRAP_VIEW_MAX_QUERY_CHARS,
  bootstrapViewQuery,
} from './http-sources'

const instance = (id: string) => ({ collection: 'session.ofIssue', args: { issueId: id } }) as never

function decodedView(query: string): unknown[] {
  return JSON.parse(new URLSearchParams(query).get('view') ?? '[]') as unknown[]
}

describe('bootstrap view in the URL', () => {
  it('sends nothing for an empty view', () => {
    expect(bootstrapViewQuery(undefined)).toBeUndefined()
    expect(bootstrapViewQuery([])).toBeUndefined()
  })

  it('sends a small view whole', () => {
    const query = bootstrapViewQuery([instance('i1'), instance('i2')])
    expect(query).toBeDefined()
    expect(decodedView(query as string)).toHaveLength(2)
  })

  it('never sends more instances than the server accepts', () => {
    const view = Array.from({ length: 400 }, (_, i) => instance(`i${i}`))
    const query = bootstrapViewQuery(view) as string
    expect(decodedView(query).length).toBeLessThanOrEqual(BOOTSTRAP_VIEW_MAX_INSTANCES)
  })

  // Operator 2026-11-19: a resync after the storage upgrade sent a view so long
  // that the server answered 431 and the client showed "could not be read safely".
  it('keeps the query under the length bound however large the instances are', () => {
    const long = 'x'.repeat(500)
    const view = Array.from({ length: 40 }, (_, i) => instance(`${long}${i}`))
    const query = bootstrapViewQuery(view) as string
    expect(query.length).toBeLessThanOrEqual(BOOTSTRAP_VIEW_MAX_QUERY_CHARS)
    expect(decodedView(query).length).toBeGreaterThan(0)
    expect(decodedView(query).length).toBeLessThan(40)
  })
})
