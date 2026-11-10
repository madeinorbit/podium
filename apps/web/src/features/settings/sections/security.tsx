import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { serverConfig, type Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { workspaceFetch } from '@/lib/workspace-request'
import { memberKey, useSettingsRecords } from '../record-readers'
import { useSettingsFrame } from '../settings-frame'
import { CommitInput, ConfirmInline, Row, Section } from './shared'

type AuthStatus = Awaited<ReturnType<Trpc['auth']['status']['query']>>
const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback

/** Personal identity uses the same member model as Members, never a second profile copy. */
export const AccountProfileSection = observer(function AccountProfileSection({
  trpc,
}: {
  trpc: Trpc
}) {
  const frame = useSettingsFrame()
  const readProfile = useCallback(async () => [await trpc.auth.profile.query()], [trpc])
  const { request, reload } = useSettingsRecords('member', readProfile, memberKey)
  const profile = request?.models[0]
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [statusError, setStatusError] = useState(false)
  const statusRequest = useRef(0)
  const [nameError, setNameError] = useState<string | null>(null)
  const [nameBusy, setNameBusy] = useState(false)
  const [emailDraft, setEmailDraft] = useState<string | null>(null)
  const [emailChange, setEmailChange] = useState<string | null>(null)
  const [emailError, setEmailError] = useState<string | null>(null)
  const [emailBusy, setEmailBusy] = useState(false)
  const nameSaving = useRef(false)
  const emailSaving = useRef(false)

  const loadStatus = useCallback(() => {
    const generation = ++statusRequest.current
    setStatusError(false)
    void trpc.auth.status
      .query()
      .then((answer) => {
        if (generation === statusRequest.current) setStatus(answer)
      })
      .catch(() => {
        if (generation === statusRequest.current) setStatusError(true)
      })
  }, [trpc])
  useEffect(() => {
    loadStatus()
    return () => {
      statusRequest.current += 1
    }
  }, [loadStatus])

  const retry = () => {
    void reload()
    loadStatus()
  }
  if (request?.error || statusError)
    return (
      <Section title="Profile">
        <p role="alert" className="settings-prose text-destructive">
          Couldn’t load your profile and sign-in settings.
        </p>
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={retry}>
          Try again
        </Button>
      </Section>
    )
  if (!profile || !status)
    return (
      <Section title="Profile">
        <p className="settings-prose" role="status">
          Loading your profile…
        </p>
      </Section>
    )

  const saveName = async (name: string) => {
    const displayName = name.trim()
    if (nameSaving.current || displayName === profile.displayName) return
    if (!displayName) {
      setNameError('Enter your name.')
      return
    }
    const previous = profile.displayName
    nameSaving.current = true
    setNameBusy(true)
    setNameError(null)
    try {
      await trpc.auth.setDisplayName.mutate({ displayName })
      await reload()
      toast.success('Saved', {
        action: {
          label: 'Undo',
          onClick: () => {
            void trpc.auth.setDisplayName
              .mutate({ displayName: previous })
              .then(() => reload())
              .catch((error: unknown) =>
                setNameError(message(error, 'Couldn’t restore your name.')),
              )
          },
        },
      })
    } catch (error) {
      setNameError(message(error, 'Couldn’t save your name.'))
    } finally {
      nameSaving.current = false
      setNameBusy(false)
    }
  }
  const saveEmail = async (email: string, current?: string) => {
    if (emailSaving.current) return
    emailSaving.current = true
    setEmailBusy(true)
    setEmailError(null)
    try {
      await trpc.auth.setEmail.mutate({ email, current })
      await reload()
      setEmailDraft(null)
      setEmailChange(null)
      toast.success('Email saved. Use it the next time you sign in.')
    } catch (error) {
      setEmailError(message(error, 'Couldn’t save your email.'))
    } finally {
      emailSaving.current = false
      setEmailBusy(false)
    }
  }
  const submitEmail = () => {
    const email = (emailDraft ?? profile.email ?? '').trim().toLowerCase()
    if (email === (profile.email ?? '')) {
      setEmailDraft(null)
      setEmailChange(null)
      setEmailError(null)
      return
    }
    if (!email) {
      setEmailError('Enter an email address.')
      return
    }
    setEmailError(null)
    if (status.hasOwnCredential) setEmailChange(email)
    else void saveEmail(email)
  }

  return (
    <Section title="Profile">
      <Row
        label="Name"
        description="Shown on tasks and sessions you start."
        pending={nameBusy}
        error={nameError}
      >
        <CommitInput
          aria-label="Name"
          autoComplete="name"
          maxLength={200}
          value={profile.displayName}
          onChange={(event) => void saveName(event.target.value)}
        />
      </Row>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          submitEmail()
        }}
      >
        <Row
          label="Email"
          description="You sign in with it. Changing it asks for your password."
          pending={emailBusy}
          error={emailError}
        >
          <Input
            aria-label="Email"
            type="email"
            autoComplete="username"
            required
            maxLength={254}
            value={emailDraft ?? profile.email ?? ''}
            onChange={(event) => {
              setEmailDraft(event.target.value)
              setEmailChange(null)
              setEmailError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                setEmailDraft(null)
                setEmailChange(null)
                setEmailError(null)
              }
            }}
          />
        </Row>
      </form>
      {emailChange !== null && (
        <ConfirmInline
          key={emailChange}
          sentence={
            <>
              Change your email to <strong>{emailChange}</strong>?
            </>
          }
          hasPassword
          actionLabel="Save email"
          pending={emailBusy}
          onCancel={() => {
            setEmailChange(null)
            setEmailError(null)
          }}
          onConfirm={(password) => saveEmail(emailChange, password)}
        />
      )}
      <Row
        label="Password"
        description={
          status.hasOwnCredential
            ? 'Your password signs you in to this Podium.'
            : 'You don’t have a password yet.'
        }
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            frame.openTakeover({
              title: status.hasOwnCredential ? 'Change password' : 'Set password',
              content: (
                <PasswordTakeover
                  trpc={trpc}
                  email={profile.email ?? null}
                  hasOwnCredential={status.hasOwnCredential}
                  onCancel={frame.closeTakeover}
                  onSaved={(active) => {
                    loadStatus()
                    if (active) frame.closeTakeover()
                    toast.success('Password saved.')
                  }}
                />
              ),
            })
          }
        >
          {status.hasOwnCredential ? 'Change password' : 'Set password'}
        </Button>
      </Row>
      <Row
        label="Role"
        description={
          profile.role === 'admin'
            ? 'You can change workspace settings and manage members.'
            : 'An admin manages workspace settings and members.'
        }
        readOnly
        readOnlyValue={profile.role === 'admin' ? 'Admin' : 'Member'}
      />
    </Section>
  )
})

function PasswordTakeover({
  trpc,
  email,
  hasOwnCredential,
  onSaved,
  onCancel,
}: {
  trpc: Trpc
  email: string | null
  hasOwnCredential: boolean
  onSaved: (active: boolean) => void
  onCancel: () => void
}) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // If refreshing the cookie fails, retry only that step: the password already changed.
  const [passwordSaved, setPasswordSaved] = useState(false)
  const loginRequired = useRef(true)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const saving = useRef(false)
  const save = async () => {
    if (saving.current) return
    setError(null)
    if (!next) {
      setError('Enter a password.')
      return
    }
    if (next !== confirm) {
      setError('Passwords don’t match.')
      return
    }
    saving.current = true
    setBusy(true)
    let credentialChanged = passwordSaved
    try {
      if (!passwordSaved) {
        const result = await trpc.auth.setPassword.mutate({ current: current || undefined, next })
        loginRequired.current = result.loginRequired
        setPasswordSaved(true)
        credentialChanged = true
      }
      if (loginRequired.current) {
        const response = await workspaceFetch(
          `${serverConfig(window.location).httpOrigin}/auth/login`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ email: email ?? 'user:sole', password: next }),
          },
        )
        if (!response.ok)
          throw new Error(
            'Your password changed, but this device couldn’t refresh its sign-in. Try again to finish signing in.',
          )
      }
      setCurrent('')
      setNext('')
      setConfirm('')
      onSaved(active.current)
    } catch (error) {
      setError(
        credentialChanged
          ? 'Your password changed, but this device couldn’t refresh its sign-in. Try again to finish signing in.'
          : message(error, 'Couldn’t change your password.'),
      )
    } finally {
      saving.current = false
      setBusy(false)
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      {hasOwnCredential && (
        <Row label="Current password">
          <Input
            aria-label="Current password"
            type="password"
            autoComplete="current-password"
            required
            value={current}
            disabled={busy || passwordSaved}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </Row>
      )}
      <Row label="New password">
        <Input
          aria-label="New password"
          type="password"
          autoComplete="new-password"
          required
          value={next}
          disabled={busy || passwordSaved}
          onChange={(event) => setNext(event.target.value)}
        />
      </Row>
      <Row label="Confirm new password">
        <Input
          aria-label="Confirm new password"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          disabled={busy || passwordSaved}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </Row>
      {error && (
        <p role="alert" className="settings-prose mt-3 text-destructive">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" pending={busy} pendingLabel="Saving password…">
          {passwordSaved ? 'Try again' : hasOwnCredential ? 'Change password' : 'Set password'}
        </Button>
      </div>
    </form>
  )
}
