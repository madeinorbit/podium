import { RequestAnswer } from '@podium/client-graph/request-answer'
import { observer } from 'mobx-react-lite'
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { serverConfig, type Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useSettingsClient } from '@/features/settings/stable-access'
import { authRequest } from '@/features/setup/member-api'
import { forcedNotice, useForcedSetting } from '../use-forced-setting'
import { ConfirmInline, Row, Section } from './shared'

type AuthStatus = Awaited<ReturnType<Trpc['auth']['status']['query']>>

/** Instance policy has one reversible control, separate from personal passwords. */
export const InstanceLoginSection = observer(function InstanceLoginSection({
  trpc,
  onChanged,
}: {
  trpc: Trpc
  onChanged?: () => void
}): JSX.Element | null {
  const client = useSettingsClient()
  const forced = useForcedSetting('authOpenMode')
  const status = useMemo(() => new RequestAnswer<AuthStatus>(), [])
  const reload = useCallback(() => status.load(() => trpc.auth.status.query()), [status, trpc])
  useEffect(() => {
    void reload()
    return () => status.close()
  }, [reload, status])
  const [confirmRequired, setConfirmRequired] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saving = useRef(false)
  const data = status.answer
  const setRequired = async (required: boolean, current: string) => {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    setError(null)
    try {
      // Open mode can be a synthetic host sign-in. Take a real cookie BEFORE
      // requiring sign-in, so this device keeps access to the change it made.
      if (required && data?.hasOwnCredential) {
        const profile = await trpc.auth.profile.query()
        await authRequest(serverConfig(window.location).httpOrigin, 'login', {
          email: profile.email ?? 'user:sole',
          password: current,
        })
      }
      const next = await trpc.auth.setLoginRequired.mutate({
        required,
        current,
        ...(!required ? { acknowledgeNoPassword: true as const } : {}),
      })
      await reload()
      onChanged?.()
      if (next.loginRequired !== required) {
        setError('Set your password in Account before requiring sign-in.')
        return
      }
      setConfirmRequired(null)
      toast.success(required ? 'Sign-in is required.' : 'Sign-in is turned off.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t change the sign-in requirement.')
    } finally {
      saving.current = false
      setBusy(false)
    }
  }
  if (!data)
    return (
      <Section title="Joining and signing in">
        {status.error ? (
          <>
            <p role="alert" className="settings-prose text-destructive">
              Couldn’t load the sign-in requirement.
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>
              Try again
            </Button>
          </>
        ) : (
          <p role="status" className="settings-prose">
            Loading sign-in settings…
          </p>
        )}
      </Section>
    )
  if (!data.canManageInstance) return null
  const source = forced.forced
    ? forcedNotice(forced)
    : data.loginPolicySource === 'file'
      ? forcedNotice({ forced: true, source: 'file' })
      : null
  return (
    <Section title="Joining and signing in">
      <Row
        label="Require sign-in"
        description={
          <>
            {data.loginRequired ? (
              'Everyone signs in with their own account.'
            ) : (
              <>
                <strong>Anyone who can reach the address can use Podium as any account.</strong>{' '}
                Only safe on a private network.
              </>
            )}
            {source && <span className="mt-1 block">{source}</span>}
          </>
        }
        readOnly={source !== null}
        readOnlyValue={data.loginRequired ? 'On' : 'Off'}
        pending={busy}
        error={error ?? status.error}
      >
        <Switch
          aria-label="Require sign-in"
          checked={data.loginRequired}
          disabled={busy}
          onCheckedChange={(required) => {
            setError(null)
            setConfirmRequired(required)
          }}
        />
      </Row>
      {confirmRequired !== null && source === null && (
        <ConfirmInline
          key={String(confirmRequired)}
          sentence={
            confirmRequired
              ? 'Require everyone to sign in? Existing account passwords will be used.'
              : 'Turn off sign-in for everyone? Existing passwords will be kept so you can turn it back on.'
          }
          actionLabel={confirmRequired ? 'Require sign-in' : 'Turn off sign-in'}
          hasPassword={data.hasOwnCredential}
          acknowledgement={
            confirmRequired
              ? undefined
              : 'I understand that anyone who can reach this Podium can use it as any account.'
          }
          destructive={!confirmRequired}
          pending={busy}
          onConfirm={(password) => setRequired(confirmRequired, password)}
          onCancel={() => {
            setConfirmRequired(null)
            setError(null)
          }}
        />
      )}
      <Row label="New people join" description="Each link works once and expires after 7 days.">
        <span className="settings-prose">With an invite link</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => client.setSettingsTab('members')}
        >
          Invite
        </Button>
      </Row>
    </Section>
  )
})
