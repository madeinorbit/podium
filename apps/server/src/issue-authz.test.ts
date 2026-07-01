import { describe, expect, it } from 'vitest'
import { authorize, type Capability, can, OPERATOR, PROC_ACTION } from './issue-authz'

const cap = (
  role: Capability['role'],
  scope: Capability['scope'] = { kind: 'all' },
): Capability => ({
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
    for (const p of ['delete', 'archive', 'setLabels', 'reparent', 'supersede']) {
      expect(PROC_ACTION[p]).toBe('manage')
    }
  })
  it('maps the work procs to write (create is additive ⇒ write)', () => {
    for (const p of ['create', 'update', 'claim', 'addComment', 'close', 'depAdd']) {
      expect(PROC_ACTION[p]).toBe('write')
    }
  })
  it('leaves queries unlisted (⇒ read by default)', () => {
    expect(PROC_ACTION.list).toBeUndefined()
    expect(PROC_ACTION.show).toBeUndefined()
  })
})

const worker = (rootId: string): Capability => ({
  role: 'worker',
  scope: { kind: 'subtree', rootId },
})
const unbound: Capability = { role: 'worker', scope: { kind: 'none' } }
const viewer: Capability = { role: 'viewer', scope: { kind: 'all' } }
const admin: Capability = { role: 'admin', scope: { kind: 'all' } }

describe('authorize', () => {
  it('reads are allowed for any role+scope', () => {
    expect(authorize(worker('A'), 'read', { id: 'B' })).toBe('allow')
    expect(authorize(viewer, 'read')).toBe('allow')
  })
  it('role gate: viewer cannot write, worker cannot manage', () => {
    expect(authorize(viewer, 'write')).toBe('forbidden')
    expect(authorize(worker('A'), 'manage', { id: 'A' })).toBe('forbidden')
  })
  it('write inside the subtree is allowed', () => {
    expect(authorize(worker('A'), 'write', { id: 'A' })).toBe('allow')
    expect(authorize(worker('A'), 'write', { id: 'C', ancestorIds: ['A'] })).toBe('allow')
  })
  it('write outside the subtree needs confirmation, override allows', () => {
    expect(authorize(worker('A'), 'write', { id: 'B', ancestorIds: [] })).toBe('confirm-required')
    expect(authorize(worker('A'), 'write', { id: 'B' }, { override: true })).toBe('allow')
  })
  it('additive write with no target issue (create) is allowed for a worker', () => {
    expect(authorize(worker('A'), 'write')).toBe('allow')
    expect(authorize(unbound, 'write')).toBe('allow')
  })
  it('unbound (scope none) may create but not write an existing issue without override', () => {
    expect(authorize(unbound, 'write', { id: 'B' })).toBe('confirm-required')
    expect(authorize(unbound, 'write', { id: 'B' }, { override: true })).toBe('allow')
  })
  it('admin (scope all) may do anything', () => {
    expect(authorize(admin, 'manage', { id: 'B' })).toBe('allow')
  })
  it('create is a write action (workers may create)', () => {
    expect(PROC_ACTION.create).toBe('write')
  })
})
