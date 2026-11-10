/**
 * SETTINGS → ADMINISTRATION, REAL, IN A BROWSER (POD-6299).
 *
 * Mounts the shipping rail filter and the admin area's sections (People,
 * Access, Machines' custody control, Audit) against a stubbed server that
 * answers as Alice, an admin, or `?as=bob`, a member. `?tab=` picks the
 * section; `?theme=light` opens the Paper appearance.
 */
import { type JSX, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { AdminViewerError } from '@/features/settings/AdminViewerError'
import { useAdminSections } from '@/features/settings/admin-viewer'
import { MachineCustody } from '@/features/settings/machine-custody'
import { AccessSection } from '@/features/settings/sections/access'
import { AuditSection } from '@/features/settings/sections/audit'
import { MembersSection } from '@/features/settings/sections/members'
import {
  SETTINGS_SURFACES,
  SURFACE_COPY,
  tabsOnSurface,
  visibleSettingsGroups,
} from '@/features/settings/surfaces'
import '@/index.css'
import '@/styles.css'

const params = new URLSearchParams(location.search)
const viewer = params.get('as') === 'bob' ? 'bob' : 'alice'
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 4, 9, minutes)).toISOString()
const alice = { kind: 'member', id: 'alice', name: 'Alice' }
const members = [
  { id: 'alice', displayName: 'Alice', email: 'alice@example.com', role: 'admin' },
  { id: 'bob', displayName: 'Bob', email: 'bob@example.com', role: 'member' },
  {
    id: 'carol',
    displayName: 'Carol',
    email: 'carol@example.com',
    role: 'member',
    disabledAt: at(1),
  },
]
const calls: string[] = []
;(window as unknown as { adminCalls: string[] }).adminCalls = calls

const answers: Record<string, () => [number, unknown]> = {
  '/auth/admin/viewer': () => [
    200,
    { sections: viewer === 'alice' ? ['people', 'access', 'machines', 'instance', 'audit'] : [] },
  ],
  '/auth/members/list': () =>
    viewer === 'alice'
      ? [
          200,
          {
            members,
            invites: [
              {
                id: 'inv_1',
                email: 'dana@example.com',
                role: 'member',
                expiresAt: '2099-01-01T00:00:00.000Z',
              },
            ],
            mailAvailable: false,
            currentMemberId: 'alice',
            hasOwnCredential: true,
            actions: {
              alice: ['signOutEverywhere'],
              bob: ['setRole', 'disable', 'remove', 'recovery', 'signOutEverywhere'],
              carol: ['enable', 'remove'],
            },
          },
        ]
      : [403, { error: 'Administrator required' }],
  '/auth/members/directory': () => [200, { members, currentMemberId: viewer }],
  '/auth/members/role': () => [
    409,
    { error: 'The last active admin cannot be demoted', code: 'last-admin' },
  ],
  '/auth/admin/access': () =>
    viewer === 'alice'
      ? [
          200,
          {
            admission: {
              mode: 'invitation',
              signInRequired: true,
              openInvites: 1,
              expiredInvites: 0,
              activeMembers: 2,
              disabledMembers: 1,
            },
            signIns: [
              {
                memberId: 'alice',
                memberName: 'Alice',
                kind: 'login',
                deviceName: null,
                platform: null,
                createdAt: at(5),
                lastSeenAt: at(50),
                expiresAt: '2026-12-04T09:05:00.000Z',
              },
              {
                memberId: 'bob',
                memberName: 'Bob',
                kind: 'mobile',
                deviceName: 'Bob’s phone',
                platform: 'ios',
                createdAt: at(10),
                lastSeenAt: at(40),
                expiresAt: '2026-12-04T09:10:00.000Z',
              },
            ],
          },
        ]
      : [403, { error: 'Administrator required' }],
  '/auth/admin/audit?limit=100': () =>
    viewer === 'alice'
      ? [
          200,
          {
            events: [
              {
                id: 6,
                at: at(30),
                command: 'takeover',
                result: 'applied',
                actor: alice,
                onBehalfOf: alice,
                target: { kind: 'machine', id: 'm-2', name: 'Spare build box' },
                facts: { previousOwner: 'Nobody', newOwner: 'Alice' },
              },
              {
                id: 5,
                at: at(25),
                command: 'members.setRole',
                result: 'refused',
                actor: alice,
                onBehalfOf: alice,
                target: { kind: 'member', id: 'alice', name: 'Alice' },
                facts: {},
              },
              {
                id: 4,
                at: at(20),
                command: 'members.setRole',
                result: 'applied',
                actor: { kind: 'agent', id: 'session:s1', name: 'An agent' },
                onBehalfOf: alice,
                target: { kind: 'member', id: 'bob', name: 'Bob' },
                facts: { from: 'member', to: 'admin' },
              },
              {
                id: 3,
                at: at(15),
                command: 'members.invite',
                result: 'applied',
                actor: alice,
                onBehalfOf: alice,
                target: { kind: 'invite', id: 'inv_1', name: 'An invitation' },
                facts: { role: 'member' },
              },
              {
                id: 2,
                at: at(12),
                command: 'settings.setSecret',
                result: 'applied',
                actor: alice,
                onBehalfOf: alice,
                target: { kind: 'secret', id: null, name: 'apiKeys.openrouter' },
                facts: {},
              },
              {
                id: 1,
                at: at(1),
                command: 'members.disable',
                result: 'applied',
                actor: alice,
                onBehalfOf: alice,
                target: { kind: 'member', id: 'carol', name: 'Carol' },
                facts: {},
              },
            ],
            nextBefore: null,
          },
        ]
      : [403, { error: 'Administrator required' }],
}

window.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input), location.href)
  const path = url.pathname + url.search
  calls.push(path)
  if (path === '/auth/admin/viewer') {
    if (params.get('viewer') === 'slow') await new Promise((resolve) => setTimeout(resolve, 4000))
    if (params.get('viewer') === 'error' && calls.filter((call) => call === path).length === 1) {
      return Response.json({ error: 'Unavailable' }, { status: 503 })
    }
  }
  const [status, body] = answers[path]?.() ?? [404, { error: 'not stubbed' }]
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}) as typeof fetch

const LABEL: Record<string, string> = {
  members: 'People',
  access: 'Access',
  machines: 'Machines',
  audit: 'Audit',
  security: 'Profile & security',
}
const groups = SETTINGS_SURFACES.map((surface) => ({
  surface,
  label: SURFACE_COPY[surface].label,
  tabs: tabsOnSurface(surface).map((key) => ({ key, label: LABEL[key] ?? key })),
}))

function MachinesStub(): JSX.Element {
  const pool = useWorklistPool()
  pool?.apply({
    type: 'replace',
    rows: [
      {
        kind: 'machine',
        id: 'm-1',
        value: {
          id: 'm-1',
          name: 'alice-desk',
          custodian: 'alice',
          loggedOutHarnesses: [],
          grants: [
            {
              grantee: 'bob',
              verb: 'use',
              grantedAt: '2026-11-08T10:00:00.000Z',
              grantedBy: 'alice',
            },
          ],
        },
      },
    ],
  })
  return (
    <section>
      <h3 className="settings-h mb-1.5">Machines</h3>
      <div className="settings-row">
        <span className="settings-label">alice-desk</span>
        <div className="settings-control">
          <MachineCustody
            machineId="m-1"
            transferable
            trpc={{
              machines: {
                share: {
                  mutate: async (input) => {
                    calls.push(`machines.share ${JSON.stringify(input)}`)
                    return []
                  },
                },
                unshare: {
                  mutate: async (input) => {
                    calls.push(`machines.unshare ${JSON.stringify(input)}`)
                    return []
                  },
                },
              },
            }}
          />
        </div>
      </div>
    </section>
  )
}

function Shell(): JSX.Element {
  const viewer = useAdminSections()
  const rail = visibleSettingsGroups(groups, viewer.sections)
  const [tab, setTab] = useState(params.get('tab') ?? 'members')
  const allowed = rail.some((g) => g.tabs.some((t) => t.key === tab))
  const pending = !allowed && viewer.status !== 'ready'
  const shown = allowed || pending ? tab : 'sessions'
  return (
    <div
      className="app-sheet-settings settings-panes"
      style={{ minHeight: '100vh', background: 'var(--card)', color: 'var(--text)' }}
      data-testid="admin-harness"
    >
      <nav className="settings-rail" aria-label="Settings sections">
        {rail.map((g) => (
          <div className="settings-rail-section" key={g.surface}>
            <div className="settings-eyebrow settings-rail-group">{g.label}</div>
            {g.tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                className="settings-rail-item"
                aria-current={t.key === shown ? 'page' : undefined}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
        ))}
        <AdminViewerError viewer={viewer} />
      </nav>
      <div className="settings-pane">
        <div className="settings-pane-scroll">
          <div className="settings-measure settings-section-enter" key={shown}>
            {pending ? (
              <p role="status" className="settings-prose text-muted-foreground">
                {viewer.status === 'loading'
                  ? 'Checking administrator access…'
                  : 'Administrator access is unavailable.'}
              </p>
            ) : (
              <>
                {shown === 'members' && <MembersSection />}
                {shown === 'access' && <AccessSection />}
                {shown === 'audit' && <AuditSection />}
                {shown === 'machines' && <MachinesStub />}
                {!['members', 'access', 'audit', 'machines'].includes(shown) && (
                  <p className="settings-prose">({shown})</p>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

document.documentElement.setAttribute('data-theme', 'podium')
document.documentElement.classList.toggle('dark', params.get('theme') !== 'light')
createRoot(document.getElementById('root') as HTMLElement).render(<Shell />)
