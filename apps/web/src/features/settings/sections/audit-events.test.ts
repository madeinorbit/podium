import { describe, expect, it } from 'vitest'
import {
  auditDayLabel,
  auditEventSentence,
  groupAuditEvents,
  type SecurityEvent,
} from './audit-events'

const mike = { kind: 'member', id: 'mike', name: 'Mike Wirth' }
const ana = { kind: 'member', id: 'ana', name: 'Ana Ruiz' }
const machine = { kind: 'machine', id: 'machine-1', name: 'build-box' }
function event(command: string, overrides: Partial<SecurityEvent> = {}): SecurityEvent {
  return {
    id: 1,
    at: '2026-11-10T12:00:00Z',
    command,
    result: 'applied',
    actor: mike,
    onBehalfOf: mike,
    target: command.startsWith('members.')
      ? ana
      : command.startsWith('issues.')
        ? { kind: 'task', id: 'issue-1', name: 'A comment' }
        : command.startsWith('settings.')
          ? { kind: 'secret', id: null, name: 'apiKeys.openai' }
          : machine,
    facts: {},
    ...overrides,
  }
}

describe('sentences for security events', () => {
  it.each([
    ['members.invite', 'invited Ana Ruiz as a member'],
    ['members.inviteRevoked', 'revoked an invitation'],
    ['members.join', 'joined this workspace'],
    ['members.setRole', 'changed Ana Ruiz’s role'],
    ['members.disable', 'disabled Ana Ruiz'],
    ['members.enable', 're-enabled Ana Ruiz'],
    ['members.remove', 'removed Ana Ruiz'],
    ['members.signOut', 'signed Ana Ruiz out everywhere'],
    ['members.revokeSignIn', 'signed Ana Ruiz out of one device'],
    ['members.recoveryIssued', 'created a recovery link for Ana Ruiz'],
    ['members.resetMailed', 'emailed Ana Ruiz a password reset'],
    ['members.recover', 'reset Ana Ruiz’s password'],
    ['takeover', 'took over build-box'],
    ['machines.adopt', 'adopted build-box'],
    ['machines.transferOwnership', 'handed build-box over to another person'],
    ['machines.share', 'let another person access build-box'],
    ['machines.unshare', 'removed another person’s permission to access build-box'],
    ['machines.revoke', 'removed build-box'],
    ['machines.supersede', 'replaced build-box'],
    ['machines.replace', 're-enrolled build-box'],
    ['machines.enrollSetup', 'added build-box to this workspace'],
    ['machines.adoptLegacyHost', 'adopted build-box'],
    ['machines.rename', 'renamed build-box'],
    ['machines.setAssignment', 'changed the services on build-box'],
    ['machines.applyUpdate', 'requested an update for build-box'],
    ['machines.moveServer', 'requested moving the server to build-box'],
    ['machines.pairingCode', 'created a machine pairing code'],
    ['settings.setSecret', 'set the OpenAI API key'],
    ['settings.clearSecret', 'cleared the OpenAI API key'],
    ['accounts.unsend', 'took a key back from build-box'],
    ['issues.editComment', 'edited another person’s comment'],
    ['issues.deleteComment', 'deleted another person’s comment'],
  ])('%s has a sentence and an explicit attempted form', (command, action) => {
    expect(auditEventSentence(event(command))).toBe(`Mike Wirth ${action}`)
    const refused = auditEventSentence(event(command, { result: 'refused' }))
    expect(refused).toMatch(/^Mike Wirth tried to /)
    expect(refused).not.toContain(command)
  })

  it('names the role, machine grantee and permission, and delegated human', () => {
    expect(
      auditEventSentence(event('members.setRole', { facts: { from: 'member', to: 'admin' } })),
    ).toBe('Mike Wirth made Ana Ruiz an admin')
    expect(
      auditEventSentence(
        event('members.invite', {
          target: { kind: 'invite', id: 'invite-1', name: 'An invitation' },
          result: 'refused',
          facts: { role: 'admin' },
        }),
      ),
    ).toBe('Mike Wirth tried to invite an admin')
    expect(
      auditEventSentence(
        event('machines.share', {
          actor: ana,
          onBehalfOf: ana,
          facts: { grantee: mike.name, verb: 'use' },
        }),
      ),
    ).toBe('Ana Ruiz let Mike Wirth run agents on build-box')
    expect(
      auditEventSentence(
        event('machines.unshare', {
          actor: { kind: 'agent', id: 'session-1', name: 'An agent' },
          facts: { grantee: ana.name, verb: 'manage' },
        }),
      ),
    ).toBe('An agent for Mike Wirth removed Ana Ruiz’s permission to manage build-box')
  })

  it('mentions a released machine only when the removal applied and names one', () => {
    const release = event('members.remove', { target: machine, facts: { member: ana.name } })
    expect(auditEventSentence(release)).toBe('Mike Wirth removed Ana Ruiz, releasing build-box')
    expect(auditEventSentence({ ...release, result: 'refused' })).toBe(
      'Mike Wirth tried to remove Ana Ruiz',
    )
    expect(auditEventSentence(event('members.remove'))).toBe('Mike Wirth removed Ana Ruiz')
  })

  it('uses readable secret labels and never prints an unknown command', () => {
    expect(
      auditEventSentence(
        event('settings.setSecret', {
          target: { kind: 'secret', id: null, name: 'notifications.telegramBotToken' },
        }),
      ),
    ).toBe('Mike Wirth set the Telegram bot token')
    expect(auditEventSentence(event('machines.aFutureCommand'))).toBe(
      'Mike Wirth made a security-related change',
    )
    expect(auditEventSentence(event('members.aFutureCommand', { result: 'refused' }))).toBe(
      'Mike Wirth tried to make a security-related change',
    )
  })

  it('keeps system events attributed to the system', () => {
    expect(
      auditEventSentence(
        event('members.recover', {
          actor: { kind: 'system', id: null, name: 'Podium' },
          onBehalfOf: null,
        }),
      ),
    ).toBe('Podium reset Ana Ruiz’s password')
    expect(auditEventSentence(event('members.recover', { target: mike }))).toBe(
      'Mike Wirth reset their password',
    )
  })
})

describe('calendar day grouping', () => {
  it('joins a day across pages without changing event order', () => {
    const first = event('members.invite', { id: 10, at: new Date(2026, 10, 10, 15).toISOString() })
    const older = event('members.disable', { id: 9, at: new Date(2026, 10, 10, 9).toISOString() })
    const yesterday = event('members.setRole', {
      id: 8,
      at: new Date(2026, 10, 9, 21).toISOString(),
    })
    expect(
      groupAuditEvents([first, older, yesterday]).map((day) => day.events.map((row) => row.id)),
    ).toEqual([[10, 9], [8]])
  })

  it('uses local calendar days at midnight and across year/daylight-saving changes', () => {
    const today = new Date(2026, 0, 1, 0, 5)
    expect(auditDayLabel(new Date(2026, 0, 1, 0, 1).toISOString(), +today)).toBe('Today')
    expect(auditDayLabel(new Date(2025, 11, 31, 23, 59).toISOString(), +today)).toBe('Yesterday')
    const previousYear = new Date(2025, 11, 30, 23)
    expect(auditDayLabel(previousYear.toISOString(), +today)).toBe(
      previousYear.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
    )
    expect(
      auditDayLabel(new Date(2026, 2, 28, 23, 55).toISOString(), +new Date(2026, 2, 29, 23, 59)),
    ).toBe('Yesterday')
  })
})
