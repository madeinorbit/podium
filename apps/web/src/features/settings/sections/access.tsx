import { RequestAnswer } from '@podium/client-graph/request-answer'
import { observer } from 'mobx-react-lite'
import { type JSX, useCallback, useEffect, useMemo, useState } from 'react'
import { serverConfig } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { authRequest } from '@/features/setup/member-api'
import { Row, Section, Subsection } from './shared'

/** `/auth/admin/access` as the server answers it (POD-6299). No token or hash. */
export interface AccessAnswer {
  admission: {
    mode: 'invitation'
    signInRequired: boolean
    openInvites: number
    expiredInvites: number
    activeMembers: number
    disabledMembers: number
  }
  /** How many unexpired sign-ins exist in all; the list carries at most 200. */
  signInsTotal?: number
  signIns: {
    /** The public id `POST /auth/admin/sign-ins/revoke` takes; null on a row an older binary wrote. */
    id?: string | null
    memberId: string
    memberName: string
    kind: string
    deviceName: string | null
    platform: string | null
    createdAt: string
    lastSeenAt: string | null
    expiresAt: string
  }[]
}

const KIND_LABEL: Record<string, string> = {
  login: 'Browser or desktop',
  mobile: 'Phone',
  upstream: 'Upstream link',
  'break-glass': 'Host recovery',
}

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—')

/**
 * ACCESS (POD-6299; design §2.1, §2.6): how people get in, and who is signed
 * in where. Admission is by invitation only. Each sign-in is a member and a
 * device; People ends a member's sign-ins.
 */
export const AccessSection = observer(function AccessSection(): JSX.Element {
  const answer = useMemo(() => new RequestAnswer<AccessAnswer>(), [])
  const origin = serverConfig(window.location).httpOrigin
  const reload = useCallback(
    () => void answer.load(async () => await authRequest<AccessAnswer>(origin, 'admin/access')),
    [answer, origin],
  )
  useEffect(() => {
    reload()
    return () => answer.close()
  }, [answer, reload])
  const [revoking, setRevoking] = useState<string | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  // Ends that one sign-in (POD-6701): the device is signed out at once.
  const revoke = useCallback(
    async (id: string) => {
      setRevoking(id)
      setRevokeError(null)
      try {
        await authRequest(origin, 'admin/sign-ins/revoke', { id })
        reload()
      } catch (error) {
        setRevokeError(error instanceof Error ? error.message : 'Couldn’t sign out this device.')
      } finally {
        setRevoking(null)
      }
    },
    [origin, reload],
  )
  const data = answer.answer
  const total = data?.signInsTotal ?? data?.signIns.length ?? 0
  return (
    <Section title="Access" hint="How people join this instance, and where each one is signed in.">
      {answer.error && <p role="alert">{answer.error}</p>}
      {data && (
        <>
          <Row
            label="Admission"
            description="People join only with an invitation an admin creates under People. Each link works once and expires."
          >
            <span>Invitation only</span>
          </Row>
          <Row
            label="Sign-in"
            description={
              data.admission.signInRequired
                ? 'Everyone signs in with their own account.'
                : 'This host opens without signing in until someone sets a password.'
            }
          >
            <span>{data.admission.signInRequired ? 'Required' : 'Not yet required'}</span>
          </Row>
          <Row
            label="Invitations"
            description="Open invitations, and expired ones not yet revoked."
          >
            <span>
              {data.admission.openInvites} open · {data.admission.expiredInvites} expired
            </span>
          </Row>
          <Row label="Members" description="Disabled members cannot sign in.">
            <span>
              {data.admission.activeMembers} active · {data.admission.disabledMembers} disabled
            </span>
          </Row>
          <Subsection
            title="Sign-ins"
            hint="Every sign-in that has not expired. Sign out ends that one device; to end all of a member’s sign-ins, use Sign out everywhere under People."
          >
            {revokeError && (
              <p role="alert" className="settings-prose text-destructive">
                {revokeError}
              </p>
            )}
            {data.signIns.length > 0 && total > data.signIns.length && (
              <p className="settings-prose">
                Showing {data.signIns.length} of {total} sign-ins, latest expiry first.
              </p>
            )}
            {data.signIns.length === 0 ? (
              <p className="settings-prose">Nobody is signed in.</p>
            ) : (
              <table className="w-full text-[13px]">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-1 font-normal">Member</th>
                    <th className="py-1 font-normal">Device</th>
                    <th className="py-1 font-normal">Signed in</th>
                    <th className="py-1 font-normal">Last seen</th>
                    <th className="py-1 font-normal">Expires</th>
                    <th className="py-1 font-normal">
                      <span className="sr-only">Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.signIns.map((signIn) => (
                    <tr
                      key={
                        signIn.id ??
                        `${signIn.memberId}-${signIn.kind}-${signIn.createdAt}-${signIn.expiresAt}`
                      }
                      className="border-hairline-soft/50 border-t"
                    >
                      <td className="py-1.5">{signIn.memberName}</td>
                      <td className="py-1.5">
                        {signIn.deviceName ?? KIND_LABEL[signIn.kind] ?? signIn.kind}
                      </td>
                      <td className="py-1.5">{day(signIn.createdAt)}</td>
                      <td className="py-1.5">{day(signIn.lastSeenAt)}</td>
                      <td className="py-1.5">{day(signIn.expiresAt)}</td>
                      <td className="py-1.5 text-right">
                        {signIn.id && (
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            aria-label={`Sign out ${signIn.memberName}’s ${
                              signIn.deviceName ?? KIND_LABEL[signIn.kind] ?? signIn.kind
                            }`}
                            disabled={revoking !== null}
                            pending={revoking === signIn.id}
                            pendingLabel="Signing out…"
                            onClick={() => void revoke(signIn.id!)}
                          >
                            Sign out
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Subsection>
        </>
      )}
    </Section>
  )
})
