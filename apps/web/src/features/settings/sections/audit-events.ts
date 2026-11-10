interface Party {
  kind: string
  id: string | null
  name: string
}

/** The safe projection returned by /auth/admin/audit, never a stored audit row. */
export interface SecurityEvent {
  id: number
  at: string
  command: string
  result: 'applied' | 'refused'
  actor: Party
  onBehalfOf: Party | null
  target: Party | null
  facts: Record<string, string>
}

const SECRET_NAMES: Record<string, string> = {
  'apiKeys.openrouter': 'OpenRouter API key',
  'apiKeys.anthropic': 'Anthropic API key',
  'apiKeys.openai': 'OpenAI API key',
  'integrations.linearApiKey': 'Linear API key',
  'notifications.telegramBotToken': 'Telegram bot token',
}

/** Every known security command has words of its own, including refused attempts. */
export function auditEventSentence(event: SecurityEvent): string {
  const actor =
    event.onBehalfOf && event.onBehalfOf.id !== event.actor.id
      ? `${event.actor.name} for ${event.onBehalfOf.name}`
      : event.actor.name
  const target = event.target?.name
  const person = event.target?.kind === 'member' ? target! : 'a member'
  const machine = event.target?.kind === 'machine' ? target! : 'a machine'
  const action = (past: string, infinitive: string) =>
    event.result === 'refused' ? `tried to ${infinitive}` : past
  const sentence = (past: string, infinitive: string) => `${actor} ${action(past, infinitive)}`
  const role = event.facts.to ?? event.facts.role
  const roleName = role === 'admin' ? 'an admin' : 'a member'
  switch (event.command) {
    case 'members.invite':
      return sentence(
        `invited ${event.target?.kind === 'member' ? `${person} as ${roleName}` : roleName}`,
        `invite ${event.target?.kind === 'member' ? `${person} as ${roleName}` : roleName}`,
      )
    case 'members.inviteRevoked':
      return sentence('revoked an invitation', 'revoke an invitation')
    case 'members.join':
      return sentence('joined this workspace', 'join this workspace')
    case 'members.setRole':
      return role
        ? sentence(`made ${person} ${roleName}`, `make ${person} ${roleName}`)
        : sentence(`changed ${person}’s role`, `change ${person}’s role`)
    case 'members.disable':
      return sentence(`disabled ${person}`, `disable ${person}`)
    case 'members.enable':
      return sentence(`re-enabled ${person}`, `re-enable ${person}`)
    case 'members.remove': {
      const member = event.facts.member ?? person
      // A machine target on an applied removal is a recorded custody release.
      const release =
        event.result === 'applied' && event.target?.kind === 'machine'
          ? `, releasing ${machine}`
          : ''
      return sentence(`removed ${member}${release}`, `remove ${member}`)
    }
    case 'members.signOut':
      return sentence(`signed ${person} out everywhere`, `sign ${person} out everywhere`)
    case 'members.revokeSignIn':
      return sentence(`signed ${person} out of one device`, `sign ${person} out of one device`)
    case 'members.recoveryIssued':
      return sentence(`created a recovery link for ${person}`, `create a recovery link for ${person}`)
    case 'members.resetMailed':
      return sentence(`emailed ${person} a password reset`, `email ${person} a password reset`)
    case 'members.recover': {
      const password = event.target?.id === event.actor.id ? 'their password' : `${person}’s password`
      return sentence(`reset ${password}`, `reset ${password}`)
    }
    case 'takeover':
      return sentence(`took over ${machine}`, `take over ${machine}`)
    case 'machines.adopt': {
      const recipient = event.facts.newOwner
      const other = recipient && recipient !== event.onBehalfOf?.name && recipient !== 'Nobody'
      return other
        ? sentence(`gave ${machine} to ${recipient}`, `give ${machine} to ${recipient}`)
        : sentence(`adopted ${machine}`, `adopt ${machine}`)
    }
    case 'machines.transferOwnership': {
      const recipient = event.facts.newOwner
      if (recipient === 'Nobody') return sentence(`released ${machine}`, `release ${machine}`)
      const to = recipient ? ` to ${recipient}` : ' to another person'
      return sentence(`handed ${machine} over${to}`, `hand ${machine} over${to}`)
    }
    case 'machines.share':
    case 'machines.unshare': {
      const grantee = event.facts.grantee ?? 'another person'
      const access =
        event.facts.verb === 'use'
          ? `run agents on ${machine}`
          : event.facts.verb === 'manage'
            ? `manage ${machine}`
            : event.facts.verb === 'see'
              ? `see ${machine}`
              : `access ${machine}`
      return event.command === 'machines.share'
        ? sentence(`let ${grantee} ${access}`, `let ${grantee} ${access}`)
        : sentence(`removed ${grantee}’s permission to ${access}`, `remove ${grantee}’s permission to ${access}`)
    }
    case 'machines.revoke':
      return sentence(`removed ${machine}`, `remove ${machine}`)
    case 'machines.supersede':
      return sentence(`replaced ${machine}`, `replace ${machine}`)
    case 'machines.replace':
      return sentence(`re-enrolled ${machine}`, `re-enroll ${machine}`)
    case 'machines.enrollSetup':
      return sentence(`added ${machine} to this workspace`, `add ${machine} to this workspace`)
    case 'machines.adoptLegacyHost':
      return sentence(`adopted ${target ?? 'the host machine'}`, `adopt ${target ?? 'the host machine'}`)
    case 'machines.rename':
      return sentence(`renamed ${machine}`, `rename ${machine}`)
    case 'machines.setAssignment':
      return sentence(`changed the services on ${machine}`, `change the services on ${machine}`)
    case 'machines.applyUpdate':
      return sentence(`requested an update for ${machine}`, `request an update for ${machine}`)
    case 'machines.moveServer':
      return sentence(`requested moving the server to ${machine}`, `request moving the server to ${machine}`)
    case 'machines.pairingCode':
      return sentence('created a machine pairing code', 'create a machine pairing code')
    case 'settings.setSecret':
    case 'settings.clearSecret': {
      const secret = target && SECRET_NAMES[target] ? `the ${SECRET_NAMES[target]}` : 'a workspace secret'
      return event.command === 'settings.setSecret'
        ? sentence(`set ${secret}`, `set ${secret}`)
        : sentence(`cleared ${secret}`, `clear ${secret}`)
    }
    case 'accounts.unsend':
      return sentence(`took a key back from ${machine}`, `take a key back from ${machine}`)
    case 'issues.editComment':
    case 'issues.deleteComment': {
      const task = target && target !== 'A comment' ? ` on ${target}` : ''
      return event.command === 'issues.editComment'
        ? sentence(`edited another person’s comment${task}`, `edit another person’s comment${task}`)
        : sentence(`deleted another person’s comment${task}`, `delete another person’s comment${task}`)
    }
    default:
      // A future server may add a kind before this client updates. Keep it readable.
      return sentence('made a security-related change', 'make a security-related change')
  }
}

function calendarDay(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

export function auditDayLabel(at: string, currentTime: number): string {
  const date = new Date(at)
  const today = new Date(currentTime)
  if (calendarDay(date) === calendarDay(today)) return 'Today'
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (calendarDay(date) === calendarDay(yesterday)) return 'Yesterday'
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  })
}

/** Group the loaded pages together, including days split across page boundaries. */
export function groupAuditEvents(events: readonly SecurityEvent[]) {
  const days = new Map<string, { key: string; at: string; events: SecurityEvent[] }>()
  for (const event of events) {
    const key = calendarDay(new Date(event.at))
    let day = days.get(key)
    if (!day) {
      day = { key, at: event.at, events: [] }
      days.set(key, day)
    }
    day.events.push(event)
  }
  return [...days.values()]
}
