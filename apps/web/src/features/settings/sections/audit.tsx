import { MemberDirectory, type MemberDirectoryAnswer } from '@podium/client-graph/member-directory'
import type { MobxPool } from '@podium/client-graph/pool'
import { useOpeningView } from '@podium/client-graph/react'
import { RequestAnswer } from '@podium/client-graph/request-answer'
import { observer } from 'mobx-react-lite'
import { type JSX, useCallback, useEffect, useMemo, useState } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { serverConfig } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { authRequest, memberRequest } from '@/features/setup/member-api'
import { Section } from './shared'

interface Party {
  kind: string
  id: string | null
  name: string
}

/** One security event as `/auth/admin/audit` projects it (POD-6299). */
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

interface AuditPage {
  events: SecurityEvent[]
  nextBefore: number | null
}

/** What happened, in words. An unknown command shows as stored. */
const EVENT_LABEL: Record<string, string> = {
  'members.invite': 'Invited',
  'members.inviteRevoked': 'Revoked an invitation',
  'members.join': 'Joined',
  'members.setRole': 'Changed role',
  'members.disable': 'Disabled',
  'members.enable': 'Enabled',
  'members.remove': 'Removed',
  'members.signOut': 'Signed out everywhere',
  'members.revokeSignIn': 'Signed out one device',
  'members.recoveryIssued': 'Created a recovery link',
  'members.resetMailed': 'Mailed a password reset',
  'members.recover': 'Reset their password',
  takeover: 'Took custody',
  'machines.adopt': 'Gave an unowned machine to',
  'machines.transferOwnership': 'Transferred custody',
  'machines.revoke': 'Revoked machine',
  'machines.supersede': 'Replaced machine',
  'machines.replace': 'Re-enrolled machine',
  'machines.enrollSetup': 'Enrolled machine',
  'machines.adoptLegacyHost': 'Adopted the host machine',
  'settings.setSecret': 'Set secret',
  'settings.clearSecret': 'Cleared secret',
  'issues.editComment': 'Edited another member’s comment',
  'issues.deleteComment': 'Deleted another member’s comment',
}

function factsText(facts: Record<string, string>): string {
  const parts: string[] = []
  if (facts.from && facts.to) parts.push(`${facts.from} → ${facts.to}`)
  else if (facts.role) parts.push(`as ${facts.role}`)
  if (facts.previousOwner || facts.newOwner)
    parts.push(`custody ${facts.previousOwner ?? '—'} → ${facts.newOwner ?? '—'}`)
  return parts.join(' · ')
}

function actorText(event: SecurityEvent): string {
  // An agent acts for one human; say who (design §2.3).
  if (event.onBehalfOf && event.onBehalfOf.id !== event.actor.id)
    return `${event.actor.name} for ${event.onBehalfOf.name}`
  return event.actor.name
}

const createDirectory = (pool: MobxPool) => new MemberDirectory(pool)

/**
 * AUDIT (POD-6299; design §2.6): member, role, admission and custody events,
 * secret writes and comment moderation, newest first. The server sends only
 * who, for whom, on what, the result and when; never a secret, a token, an
 * email or any task or session text.
 */
export const AuditSection = observer(function AuditSection(): JSX.Element {
  const answer = useMemo(() => new RequestAnswer<SecurityEvent[]>(), [])
  const directory = useOpeningView(useWorklistPool(), createDirectory)
  const [actor, setActor] = useState('')
  const [kind, setKind] = useState('')
  const [nextBefore, setNextBefore] = useState<number | null>(null)
  const origin = serverConfig(window.location).httpOrigin
  useEffect(() => {
    if (directory) void directory.read(() => memberRequest<MemberDirectoryAnswer>(origin, 'list'))
  }, [directory, origin])
  const loadPage = useCallback(
    (before?: number) => {
      const query = new URLSearchParams({ limit: '100' })
      if (actor) query.set('actor', actor)
      if (kind === 'refused') query.set('refusedOnly', 'true')
      else if (kind) query.set('kind', kind)
      if (before !== undefined) query.set('before', String(before))
      return answer.load(
        () => authRequest<AuditPage>(origin, `admin/audit?${query}`),
        before === undefined,
        (page) => {
          setNextBefore(page.nextBefore)
          return [...(before !== undefined ? (answer.answer ?? []) : []), ...page.events]
        },
      )
    },
    [answer, origin, actor, kind],
  )
  useEffect(() => {
    setNextBefore(null)
    void loadPage()
    return () => answer.close()
  }, [answer, loadPage])
  const events = answer.answer
  return (
    <Section
      title="Audit"
      hint="Security events on this instance: members, roles, invitations, machine custody, secrets and comment moderation. Values, transcripts and task text are never recorded here."
    >
      <div className="mb-4 flex flex-wrap gap-3 text-[13px]">
        <label>
          Person
          <select
            className="mt-1 block min-w-40 rounded border border-input bg-background p-2"
            value={actor}
            onChange={(event) => setActor(event.target.value)}
          >
            <option value="">Anyone</option>
            {directory?.members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Event kind
          <select
            className="mt-1 block min-w-40 rounded border border-input bg-background p-2"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            <option value="">All events</option>
            <option value="people">People</option>
            <option value="machines">Machines</option>
            <option value="credentials">Credentials</option>
            <option value="comments">Comments</option>
            <option value="refused">Refused only</option>
          </select>
        </label>
      </div>
      {directory?.error && <p role="alert">{directory.error}</p>}
      {answer.error && <p role="alert">{answer.error}</p>}
      {events && events.length === 0 && (
        <p className="settings-prose">{actor || kind ? 'No matching events.' : 'No events yet.'}</p>
      )}
      {events && events.length > 0 && (
        <table className="w-full text-[13px]" aria-label="Security events">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1 font-normal">When</th>
              <th className="py-1 font-normal">Who</th>
              <th className="py-1 font-normal">What</th>
              <th className="py-1 font-normal">Target</th>
              <th className="py-1 font-normal">Result</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id} className="border-hairline-soft/50 border-t align-top">
                <td className="py-1.5 pr-2 whitespace-nowrap">
                  {new Date(event.at).toLocaleString()}
                </td>
                <td className="py-1.5 pr-2">{actorText(event)}</td>
                <td className="py-1.5 pr-2">
                  {EVENT_LABEL[event.command] ?? event.command}
                  {factsText(event.facts) && (
                    <span className="settings-prose block">{factsText(event.facts)}</span>
                  )}
                </td>
                <td className="py-1.5 pr-2">{event.target?.name ?? '—'}</td>
                <td className={event.result === 'refused' ? 'py-1.5 text-destructive' : 'py-1.5'}>
                  {event.result === 'refused' ? 'Refused' : 'Done'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {nextBefore !== null && (
        <Button
          variant="ghost"
          className="mt-3"
          disabled={answer.loading}
          onClick={() => void loadPage(nextBefore)}
        >
          Show older events
        </Button>
      )}
    </Section>
  )
})
