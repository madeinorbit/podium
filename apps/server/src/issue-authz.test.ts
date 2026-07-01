import { describe, expect, it } from 'vitest'
import { authorize, type Capability, OPERATOR, PROC_ACTION } from './issue-authz'

describe('OPERATOR', () => {
  it('is an unconstrained admin over all issues', () => {
    expect(OPERATOR).toEqual({ role: 'admin', scope: { kind: 'all' } })
    expect(authorize(OPERATOR, 'manage', { id: 'iss_any' })).toBe('allow')
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
  it('override never bypasses a role denial', () => {
    expect(authorize(viewer, 'write', { id: 'X' }, { override: true })).toBe('forbidden')
  })
})
