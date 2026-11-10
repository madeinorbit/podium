import { MemberDirectory, type MemberDirectoryAnswer } from '@podium/client-graph/member-directory'
import type { MobxPool } from '@podium/client-graph/pool'
import { useOpeningView } from '@podium/client-graph/react'
import { RequestAnswer } from '@podium/client-graph/request-answer'
import { now } from '@podium/mobx-helpers'
import { History, KeyRound, MessageSquare, Server, Users } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { type JSX, useCallback, useEffect, useMemo, useState } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { serverConfig } from '@/app/trpc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { authRequest, memberRequest } from '@/features/setup/member-api'
import {
  auditDayLabel,
  auditEventSentence,
  groupAuditEvents,
  type SecurityEvent,
} from './audit-events'
import { EntityRow, Section } from './shared'

export type { SecurityEvent } from './audit-events'

interface AuditPage {
  events: SecurityEvent[]
  nextBefore: number | null
}

const EVENT_KINDS = [
  { value: '', label: 'All events' },
  { value: 'people', label: 'People' },
  { value: 'machines', label: 'Machines' },
  { value: 'credentials', label: 'Credentials' },
  { value: 'comments', label: 'Comments' },
  { value: 'refused', label: 'Refused only' },
]

const createDirectory = (pool: MobxPool) => new MemberDirectory(pool)

/** The existing admin-only, cursor-filtered request answer owns these pages. */
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
  const filtered = Boolean(actor || kind)
  const people = [
    { value: '', label: 'Anyone' },
    ...(directory?.members.map((member) => ({ value: member.id, label: member.displayName })) ??
      []),
  ]
  const filters = (
    <div className="flex w-37.5 flex-wrap gap-2 sm:w-auto">
      <Select items={people} value={actor} onValueChange={(value) => setActor(value ?? '')}>
        <SelectTrigger className="min-w-37.5" aria-label="Person">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {people.map((person) => (
            <SelectItem key={person.value} value={person.value}>
              {person.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select items={EVENT_KINDS} value={kind} onValueChange={(value) => setKind(value ?? '')}>
        <SelectTrigger className="min-w-37.5" aria-label="Event kind">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {EVENT_KINDS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
  return (
    <Section list={false} action={filters}>
      {directory?.error && (
        <p className="settings-prose mb-3 text-destructive" role="alert">
          {directory.error}
        </p>
      )}
      {answer.error && (
        <div className="mb-3 flex flex-wrap items-center gap-2" role="alert">
          <p className="settings-prose text-destructive">{answer.error}</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadPage(events && nextBefore !== null ? nextBefore : undefined)}
          >
            Try again
          </Button>
        </div>
      )}
      <div role="region" aria-label="Security events" aria-busy={answer.loading}>
        {events === undefined && !answer.error && <AuditSkeleton />}
        {events?.length === 0 && (
          <Section list>
            <div className="settings-list-note py-8 text-center" role="status">
              <p className="settings-label">{filtered ? 'Nothing matches' : 'No events yet'}</p>
              <p className="settings-prose mx-auto mt-1">
                {filtered
                  ? 'Try another person or kind.'
                  : 'Security-relevant changes will appear here.'}
              </p>
            </div>
          </Section>
        )}
        {events &&
          groupAuditEvents(events).map((day) => (
            <AuditDay key={day.key} at={day.at} events={day.events} />
          ))}
        {answer.loading && events !== undefined && <AuditSkeleton />}
      </div>
      {nextBefore !== null && (
        <div className="mt-3.5 text-center">
          <Button
            variant="ghost"
            size="sm"
            disabled={answer.loading}
            onClick={() => void loadPage(nextBefore)}
          >
            Show older events
          </Button>
        </div>
      )}
    </Section>
  )
})

const AuditDay = observer(function AuditDay({
  at,
  events,
}: {
  at: string
  events: SecurityEvent[]
}): JSX.Element {
  return (
    <div className="mt-5">
      <Section
        title={<span className="settings-micro font-medium">{auditDayLabel(at, now(60_000))}</span>}
        list
      >
        {events.map((event) => (
          <EntityRow
            key={event.id}
            leading={<EventIcon command={event.command} />}
            title={
              <span className="block font-normal whitespace-normal break-words">
                {auditEventSentence(event)}
              </span>
            }
            pills={
              event.result === 'refused' ? <Badge variant="destructive">Refused</Badge> : undefined
            }
            trailing={
              <time
                dateTime={event.at}
                title={new Date(event.at).toLocaleString()}
                className="settings-micro font-mono whitespace-nowrap tabular-nums"
              >
                {new Date(event.at).toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })}
              </time>
            }
          />
        ))}
      </Section>
    </div>
  )
})

function EventIcon({ command }: { command: string }): JSX.Element {
  const Icon = command.startsWith('members.')
    ? Users
    : command.startsWith('machines.') || command === 'takeover'
      ? Server
      : command.startsWith('issues.')
        ? MessageSquare
        : command.startsWith('settings.') || command === 'accounts.unsend'
          ? KeyRound
          : History
  return <Icon size={15} aria-hidden="true" />
}

/** Still placeholders in the same shared rows as the loaded events. */
function AuditSkeleton(): JSX.Element {
  return (
    <div className="mt-5" role="status" aria-label="Loading security events">
      <Section list>
        {[0, 1, 2].map((index) => (
          <EntityRow
            key={index}
            leading={<span className="block size-full rounded-lg bg-muted" aria-hidden="true" />}
            title={
              <span className="block h-3 w-48 max-w-full rounded bg-muted" aria-hidden="true" />
            }
            trailing={<span className="block h-3 w-10 rounded bg-muted" aria-hidden="true" />}
          />
        ))}
      </Section>
    </div>
  )
}
