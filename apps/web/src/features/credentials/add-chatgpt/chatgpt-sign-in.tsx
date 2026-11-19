/**
 * SIGN IN WITH CHATGPT (credential management §11; epic Task 14).
 *
 * The person picks where their browser is: a machine of theirs whose Podium
 * listens for the browser's return, or nowhere, in which case they paste the
 * address the browser ended on. The server keeps the sign-in's secrets; this
 * screen only opens OpenAI's page, waits, and shows the outcome. The tokens
 * never reach the browser.
 *
 * States: choose → waiting (listening, or paste instead) → signed in as an
 * account, or failed.
 */

import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { settingsReceipt } from '@/features/settings/settings-receipt'
import { type CredentialDeps, errorText } from '../credentials-deps'

/** Where a person reviews what each app used of their ChatGPT plan, and its limits. */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage'
const POLL_MS = 2_000

export type ChatgptStatus =
  | { state: 'waiting' }
  | {
      state: 'signed-in'
      credentialId: string
      label: string
      email?: string
      planEnabled: boolean
      updated: boolean
    }
  | { state: 'failed'; reason: string }

/** The three calls this screen makes, as the tRPC client shapes them. */
export interface ChatgptSignInCommands {
  chatgptSignInStart: {
    mutate(input: {
      label?: string
      machineId?: string
      credentialId?: string
    }): Promise<{ attemptId: string; authorizeUrl: string; via: 'machine' | 'paste' }>
  }
  chatgptSignInComplete: {
    mutate(input: { attemptId: string; pastedUrl: string }): Promise<ChatgptStatus>
  }
  chatgptSignInStatus: { query(input: { attemptId: string }): Promise<ChatgptStatus> }
}

export interface ListeningMachine {
  id: string
  name: string
}

type Phase =
  | { kind: 'choose' }
  | { kind: 'waiting'; attemptId: string; authorizeUrl: string; via: 'machine' | 'paste' }
  | { kind: 'done'; status: Exclude<ChatgptStatus, { state: 'waiting' }> }

const PASTE = 'paste'

export function ChatgptSignIn({
  commands,
  deps,
  machines,
  credentialId,
  label: initialLabel,
  openUrl = (url) => window.open(url, '_blank', 'noopener'),
  pollMs = POLL_MS,
  onDone,
}: {
  commands: ChatgptSignInCommands
  deps: Pick<CredentialDeps, 'reload'>
  /** The person's own machines that are online and can listen. */
  machines: readonly ListeningMachine[]
  /** Sign in again to this ChatGPT credential. */
  credentialId?: string
  label?: string
  openUrl?: (url: string) => void
  /** How often a listening attempt is asked where it stands. */
  pollMs?: number
  onDone: () => void
}) {
  const id = useId()
  const [label, setLabel] = useState(initialLabel ?? '')
  const [where, setWhere] = useState<string>(machines[0]?.id ?? PASTE)
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pasting, setPasting] = useState(false)
  const [pasted, setPasted] = useState('')
  const reloaded = useRef(false)

  const finish = (status: Exclude<ChatgptStatus, { state: 'waiting' }>) => {
    setPhase({ kind: 'done', status })
    if (status.state === 'signed-in' && !reloaded.current) {
      reloaded.current = true
      deps.reload()
    }
  }

  // While a machine listens, ask the server where the attempt stands. The
  // latest calls are read through a ref, so one attempt is one poll.
  const latest = useRef({ query: commands.chatgptSignInStatus, finish })
  latest.current = { query: commands.chatgptSignInStatus, finish }
  const waitingId = phase.kind === 'waiting' ? phase.attemptId : undefined
  useEffect(() => {
    if (!waitingId) return
    let stopped = false
    const timer = setInterval(() => {
      void latest.current.query
        .query({ attemptId: waitingId })
        .then((status) => {
          if (!stopped && status.state !== 'waiting') latest.current.finish(status)
        })
        .catch(() => {})
    }, pollMs)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [waitingId, pollMs])

  const start = async (event: FormEvent) => {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const started = await commands.chatgptSignInStart.mutate({
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(where !== PASTE ? { machineId: where } : {}),
        ...(credentialId ? { credentialId } : {}),
      })
      setPasting(started.via === 'paste')
      setPhase({ kind: 'waiting', ...started })
      openUrl(started.authorizeUrl)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setPending(false)
    }
  }

  const complete = async (event: FormEvent) => {
    event.preventDefault()
    if (phase.kind !== 'waiting' || pending || !pasted.trim()) return
    setPending(true)
    setError(null)
    try {
      const status = await commands.chatgptSignInComplete.mutate({
        attemptId: phase.attemptId,
        pastedUrl: pasted.trim(),
      })
      setPasted('')
      if (status.state !== 'waiting') finish(status)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setPending(false)
    }
  }

  if (phase.kind === 'done') {
    const status = phase.status
    if (status.state === 'failed') {
      return (
        <div className="settings-measure flex flex-col gap-4">
          <p className="settings-prose text-destructive" role="alert">
            {status.reason}
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onDone}>
              Close
            </Button>
            <Button
              type="button"
              onClick={() => {
                setError(null)
                setPhase({ kind: 'choose' })
              }}
            >
              Try again
            </Button>
          </div>
        </div>
      )
    }
    return (
      <div className="settings-measure flex flex-col gap-4">
        <p className="settings-prose" role="status">
          {status.updated ? 'Signed in again as ' : 'Signed in as '}
          <strong>{status.email ?? status.label}</strong>. Podium keeps this sign-in fresh and can
          use your ChatGPT plan for its own model calls.
        </p>
        {!status.planEnabled && (
          <p className="settings-prose text-destructive" role="alert">
            You did not allow Podium to use your ChatGPT plan, so it cannot make model calls on it.
            Sign in again and allow it.
          </p>
        )}
        <p className="settings-micro text-muted-foreground">
          What Podium uses of your plan, and its limits, are in{' '}
          <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer" className="underline">
            ChatGPT’s usage settings
          </a>
          .
        </p>
        <div className="flex justify-end">
          <Button
            type="button"
            onClick={() => {
              settingsReceipt('Saved')
              onDone()
            }}
          >
            Done
          </Button>
        </div>
      </div>
    )
  }

  if (phase.kind === 'waiting') {
    const machineName = machines.find((m) => m.id === where)?.name
    return (
      <div className="settings-measure flex flex-col gap-4">
        {phase.via === 'machine' && (
          <p className="settings-prose" role="status">
            Waiting for you to finish signing in to ChatGPT in your browser. Podium on{' '}
            {machineName ?? 'your machine'} receives the answer when the browser returns.
          </p>
        )}
        <p className="settings-micro">
          <a href={phase.authorizeUrl} target="_blank" rel="noreferrer" className="underline">
            Open the ChatGPT sign-in page
          </a>
        </p>
        {pasting ? (
          <form className="flex flex-col gap-2" onSubmit={(e) => void complete(e)}>
            <p className="settings-prose">
              After you sign in, your browser goes to an address that starts with http://127.0.0.1
              and may show an error page. Copy that whole address from the address bar and paste it
              here.
            </p>
            <label className="settings-label flex flex-col gap-1" htmlFor={`${id}-pasted`}>
              Address from the browser
              <Input
                id={`${id}-pasted`}
                autoComplete="off"
                spellCheck={false}
                autoFocus
                value={pasted}
                disabled={pending}
                placeholder="http://127.0.0.1:1455/auth/callback?code=…"
                onChange={(event) => setPasted(event.target.value)}
              />
            </label>
            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={!pasted.trim()}
                pending={pending}
                pendingLabel="Signing in…"
              >
                Finish sign-in
              </Button>
            </div>
          </form>
        ) : (
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => setPasting(true)}>
              Paste the address instead
            </Button>
          </div>
        )}
        {error && (
          <p className="settings-prose text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form className="settings-measure flex flex-col gap-4" onSubmit={(e) => void start(e)}>
      <p className="settings-prose">
        Sign in with your ChatGPT account so Podium can use your ChatGPT plan. Podium keeps the
        sign-in on this server and renews it; nothing is stored in your browser.
      </p>
      {!credentialId && (
        <label className="settings-label flex flex-col gap-1" htmlFor={`${id}-label`}>
          Name
          <Input
            id={`${id}-label`}
            value={label}
            maxLength={80}
            placeholder="ChatGPT (your email)"
            disabled={pending}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
      )}
      <fieldset className="flex flex-col gap-2">
        <legend className="settings-label mb-1">Where is the browser you sign in with?</legend>
        {machines.map((machine) => (
          <label key={machine.id} className="settings-prose flex items-center gap-2">
            <input
              type="radio"
              name={`${id}-where`}
              value={machine.id}
              checked={where === machine.id}
              onChange={() => setWhere(machine.id)}
            />
            On {machine.name}: Podium there receives the sign-in
          </label>
        ))}
        <label className="settings-prose flex items-center gap-2">
          <input
            type="radio"
            name={`${id}-where`}
            value={PASTE}
            checked={where === PASTE}
            onChange={() => setWhere(PASTE)}
          />
          Elsewhere: I will paste the address my browser ends on
        </label>
      </fieldset>
      {error && (
        <p className="settings-prose text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={pending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" pending={pending} pendingLabel="Starting…">
          Continue with ChatGPT
        </Button>
      </div>
    </form>
  )
}
