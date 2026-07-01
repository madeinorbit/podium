import { describe, expect, it } from 'vitest'
import { type Capability, can, OPERATOR, PROC_ACTION } from './issue-authz'

const cap = (role: Capability['role'], scope: Capability['scope'] = { kind: 'all' }): Capability => ({
  role,
  scope,
})

describe('issue-authz can()', () => {
  it('viewer may read but not write or manage', () => {
    expect(can(cap('viewer'), 'read')).toBe(true)
    expect(can(cap('viewer'), 'write')).toBe(false)
    expect(can(cap('viewer'), 'manage')).toBe(false)
  })

  it('worker may read + write but not manage', () => {
    expect(can(cap('worker'), 'read')).toBe(true)
    expect(can(cap('worker'), 'write')).toBe(true)
    expect(can(cap('worker'), 'manage')).toBe(false)
  })

  it('admin may do everything', () => {
    expect(can(cap('admin'), 'read')).toBe(true)
    expect(can(cap('admin'), 'write')).toBe(true)
    expect(can(cap('admin'), 'manage')).toBe(true)
  })

  it('OPERATOR is an unconstrained admin over all issues', () => {
    expect(OPERATOR).toEqual({ role: 'admin', scope: { kind: 'all' } })
    expect(can(OPERATOR, 'manage')).toBe(true)
  })

  describe('subtree scope (the reserved per-issue extension)', () => {
    const scoped = cap('worker', { kind: 'subtree', rootId: 'iss_root' })

    it('allows an in-scope action: the root issue itself', () => {
      expect(can(scoped, 'write', { id: 'iss_root' })).toBe(true)
    })

    it('allows a descendant (root is an ancestor)', () => {
      expect(can(scoped, 'write', { id: 'iss_child', ancestorIds: ['iss_root'] })).toBe(true)
    })

    it('denies an out-of-tree issue even for an allowed action', () => {
      expect(can(scoped, 'write', { id: 'iss_other', ancestorIds: ['iss_elsewhere'] })).toBe(false)
    })

    it('denies when the target issue is unknown (cannot prove in-scope)', () => {
      expect(can(scoped, 'write')).toBe(false)
    })

    it('still enforces the role within scope (worker cannot manage even in-tree)', () => {
      expect(can(scoped, 'manage', { id: 'iss_root' })).toBe(false)
    })
  })
})

describe('PROC_ACTION mapping', () => {
  it('maps the structural/destructive procs to manage', () => {
    for (const p of ['create', 'delete', 'archive', 'setLabels', 'reparent', 'supersede']) {
      expect(PROC_ACTION[p]).toBe('manage')
    }
  })
  it('maps the work procs to write', () => {
    for (const p of ['update', 'claim', 'addComment', 'close', 'depAdd']) {
      expect(PROC_ACTION[p]).toBe('write')
    }
  })
  it('leaves queries unlisted (⇒ read by default)', () => {
    expect(PROC_ACTION.list).toBeUndefined()
    expect(PROC_ACTION.show).toBeUndefined()
  })
})
