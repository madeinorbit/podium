import { describe, expect, it } from 'vitest'
import { projectSecurityEvent } from './admin-routes'
import type { SecurityEventRow } from './store/settings-audit'

const names = {
  members: new Map([
    ['mike', 'Mike Wirth'],
    ['ana', 'Ana Ruiz'],
  ]),
  machines: new Map([['machine-1', 'build-box']]),
}
const row = (command: string, detail: unknown): SecurityEventRow => ({
  id: 1,
  command,
  outcome: 'applied',
  actorKind: 'user',
  actorId: 'mike',
  onBehalfOf: 'mike',
  detail,
  redactedPaths: [],
  createdAt: '2026-11-10T12:00:00Z',
})

describe('audit facts used in sentences', () => {
  it.each([
    'machines.share',
    'machines.unshare',
  ])('projects the grantee and permission for %s', (command) => {
    const projected = projectSecurityEvent(
      row(command, {
        machineId: 'machine-1',
        grantee: 'ana',
        verb: 'use',
        value: 'private-key',
        email: 'private@example.com',
        text: 'private text',
      }),
      names,
    )
    expect(projected.target).toEqual({ kind: 'machine', id: 'machine-1', name: 'build-box' })
    expect(projected.facts).toEqual({ grantee: 'Ana Ruiz', verb: 'use' })
    expect(JSON.stringify(projected)).not.toContain('private')
  })

  it('keeps both the member and the machine when removal released custody', () => {
    const projected = projectSecurityEvent(
      row('members.remove', {
        memberId: 'ana',
        machineId: 'machine-1',
        previousOwnerUserId: 'ana',
        newOwnerUserId: null,
      }),
      names,
    )
    expect(projected.target).toEqual({ kind: 'machine', id: 'machine-1', name: 'build-box' })
    expect(projected.facts).toEqual({
      member: 'Ana Ruiz',
      previousOwner: 'Ana Ruiz',
      newOwner: 'Nobody',
    })
    const plain = projectSecurityEvent(row('members.remove', { memberId: 'ana' }), names)
    expect(plain.target?.kind).toBe('member')
    expect(plain.facts).toEqual({})
  })

  it('does not project an arbitrary permission or grantee as free text', () => {
    expect(
      projectSecurityEvent(
        row('machines.share', {
          grantee: 'private@example.com',
          verb: 'private-text',
        }),
        names,
      ).facts,
    ).toEqual({ grantee: 'Removed member' })
    expect(
      projectSecurityEvent(
        row('members.disable', {
          grantee: 'ana',
          verb: 'use',
        }),
        names,
      ).facts,
    ).toEqual({})
  })
})
