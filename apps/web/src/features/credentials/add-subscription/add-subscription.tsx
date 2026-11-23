/**
 * ADD A SUBSCRIPTION BY SIGNING IN ON A MACHINE (credential management §6 way
 * 2; epic Task 9).
 *
 * The person picks which subscription and the machine; Podium opens the
 * vendor's own sign-in in a terminal there, inside a home made for this login.
 * The person finishes it in their browser and the terminal. This screen only
 * starts it, waits, and says who signed in: the login never leaves the machine.
 *
 * States: choose → waiting for sign-in → signed in as a named account, or failed.
 */

import { BUNDLED_DESCRIPTORS } from '@podium/harness/browser'
import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { settingsReceipt } from '@/features/settings/settings-receipt'
import { type CredentialDeps, errorText } from '../credentials-deps'

const POLL_MS = 2_000

/** Resolve presentation from the same descriptor that declares home-login acceptance. */
function withProgram<const T extends { type: string }>(choice: T) {
  const descriptor = BUNDLED_DESCRIPTORS.find((entry) =>
    entry.accepts?.some(
      (accepted) => accepted.type === choice.type && accepted.deliver.kind === 'home',
    ),
  )
  if (!descriptor) throw new Error(`No home-login program descriptor for ${choice.type}`)
  return { ...choice, program: descriptor.label }
}

/** Subscriptions a person signs in to in an agent program. */
export const SUBSCRIPTION_KINDS = [
  withProgram({
    type: 'anthropic.claude-login',
    title: 'Claude subscription',
    hint: 'In the terminal, open the link Claude Code shows and sign in with the account you want to add. Then paste the code the page gives you into the terminal.',
  }),
  withProgram({
    type: 'openai.chatgpt-login',
    title: 'ChatGPT subscription',
    hint: 'In the terminal, open the link Codex shows and enter the one-time code it prints. If ChatGPT asks you to allow device codes, turn that on under Settings › Security first, then enter the code.',
  }),
  withProgram({
    type: 'xai.grok-login',
    title: 'Grok subscription',
    hint: 'In the terminal, open the link Grok shows and sign in with the account you want to add.',
  }),
  withProgram({
    type: 'google.antigravity-login',
    title: 'Google AI subscription',
    hint: 'Open the Google sign-in link in the terminal and sign in with your Google AI account. Paste the authorization code back into the terminal. Free, Pro, Ultra, and eligible enterprise accounts use Antigravity’s native sign-in.',
  }),
] as const

export type SubscriptionType = (typeof SUBSCRIPTION_KINDS)[number]['type']

export type SignInOutcome = 'new' | 'same' | 'attached' | 'identity-changed'

export type SubscriptionSignInStatus =
  | { state: 'waiting'; machineId: string; terminalSessionId: string }
  | {
      state: 'signed-in'
      credentialId: string
      label: string
      email?: string
      outcome: SignInOutcome
      previousEmail?: string
    }
  | { state: 'failed'; reason: string }

/** The three calls this screen makes, as the tRPC client shapes them. */
export interface SubscriptionSignInCommands {
  signInStart: {
    mutate(input: {
      type: SubscriptionType
      machineId: string
      label?: string
      credentialId?: string
    }): Promise<{ credentialId: string; terminalSessionId: string }>
  }
  signInCancel: { mutate(input: { credentialId: string }): Promise<unknown> }
  signInStatus: { query(input: { credentialId: string }): Promise<SubscriptionSignInStatus> }
}

export interface SignInMachine {
  id: string
  name: string
}

type Phase =
  | { kind: 'choose' }
  | { kind: 'waiting'; credentialId: string; terminalSessionId: string }
  | { kind: 'done'; status: Exclude<SubscriptionSignInStatus, { state: 'waiting' }> }

/** The sentence that says who signed in, and what that did. */
export function signedInSentence(
  status: Extract<SubscriptionSignInStatus, { state: 'signed-in' }>,
): string {
  const who = status.email ?? status.label
  switch (status.outcome) {
    case 'same':
      return `Signed in again as ${who}.`
    case 'attached':
      return `Signed in as ${who}. You already had “${status.label}” for this account, so this sign-in was added to it.`
    case 'identity-changed':
      return status.previousEmail
        ? `Signed in as ${who}, not ${status.previousEmail}. “${status.label}” now uses ${who}, the account that signed in.`
        : `Signed in as ${who}. “${status.label}” now uses this account.`
    default:
      return status.label === who
        ? `Signed in as ${who}.`
        : `Signed in as ${who}. Added as “${status.label}”.`
  }
}

export function AddSubscription({
  commands,
  deps,
  machines,
  openTerminal,
  type: initialType,
  credentialId,
  pollMs = POLL_MS,
  onDone,
}: {
  commands: SubscriptionSignInCommands
  deps: Pick<CredentialDeps, 'reload'>
  /** The person's own machines that are online. */
  machines: readonly SignInMachine[]
  /** Show the sign-in terminal. */
  openTerminal: (sessionId: string) => void
  type?: SubscriptionType
  /** Sign this credential in again, on a machine. */
  credentialId?: string
  pollMs?: number
  onDone: () => void
}) {
  const id = useId()
  const [type, setType] = useState<SubscriptionType>(initialType ?? SUBSCRIPTION_KINDS[0].type)
  const [machineId, setMachineId] = useState(machines[0]?.id ?? '')
  const [label, setLabel] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reloaded = useRef(false)
  const kind = SUBSCRIPTION_KINDS.find((k) => k.type === type) ?? SUBSCRIPTION_KINDS[0]
  const machineName = machines.find((m) => m.id === machineId)?.name ?? 'your machine'

  const finish = (status: Exclude<SubscriptionSignInStatus, { state: 'waiting' }>) => {
    setPhase({ kind: 'done', status })
    if (status.state === 'signed-in' && !reloaded.current) {
      reloaded.current = true
      deps.reload()
    }
  }

  // Ask the server where the sign-in stands. The latest calls are read
  // through a ref, so one sign-in is one poll.
  const latest = useRef({ query: commands.signInStatus, finish })
  latest.current = { query: commands.signInStatus, finish }
  const waitingId = phase.kind === 'waiting' ? phase.credentialId : undefined
  useEffect(() => {
    if (!waitingId) return
    let stopped = false
    const timer = setInterval(() => {
      void latest.current.query
        .query({ credentialId: waitingId })
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
    if (pending || !machineId) return
    setPending(true)
    setError(null)
    try {
      const started = await commands.signInStart.mutate({
        type,
        machineId,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(credentialId ? { credentialId } : {}),
      })
      setPhase({ kind: 'waiting', ...started })
      openTerminal(started.terminalSessionId)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setPending(false)
    }
  }

  const cancel = async () => {
    if (phase.kind !== 'waiting') return onDone()
    setPending(true)
    try {
      await commands.signInCancel.mutate({ credentialId: phase.credentialId })
    } catch {
      // Abandoned sign-ins end on the server by themselves.
    } finally {
      setPending(false)
      onDone()
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
          {signedInSentence(status)}
        </p>
        <p className="settings-micro text-muted-foreground">
          The login stays on {machineName}. Sessions there can run on it; to use it on another
          machine, sign in there too.
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
    return (
      <div className="settings-measure flex flex-col gap-4">
        <p className="settings-prose" role="status">
          Waiting for you to sign in to your {kind.title} in the terminal on {machineName}.
        </p>
        <p className="settings-prose">{kind.hint}</p>
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => openTerminal(phase.terminalSessionId)}
          >
            Open the sign-in terminal
          </Button>
        </div>
        <div className="flex justify-end">
          <Button type="button" variant="ghost" pending={pending} onClick={() => void cancel()}>
            Cancel sign-in
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form className="settings-measure flex flex-col gap-4" onSubmit={(e) => void start(e)}>
      <p className="settings-prose">
        Sign in to a subscription in {kind.program} on one of your machines. The login stays on that
        machine, next to any you already have there.
      </p>
      {!initialType && (
        <fieldset className="flex flex-col gap-2">
          <legend className="settings-label mb-1">Subscription</legend>
          {SUBSCRIPTION_KINDS.map((k) => (
            <label key={k.type} className="settings-prose flex items-center gap-2">
              <input
                type="radio"
                name={`${id}-type`}
                value={k.type}
                checked={type === k.type}
                onChange={() => setType(k.type)}
              />
              {k.title}, signed in through {k.program}
            </label>
          ))}
        </fieldset>
      )}
      {machines.length === 0 ? (
        <p className="settings-prose text-destructive" role="alert">
          None of your machines is connected. Start Podium on a machine you look after, then try
          again.
        </p>
      ) : (
        <label className="settings-label flex flex-col gap-1" htmlFor={`${id}-machine`}>
          Machine
          <select
            id={`${id}-machine`}
            className="settings-prose rounded-md border bg-background px-2 py-1.5"
            value={machineId}
            disabled={pending}
            onChange={(event) => setMachineId(event.target.value)}
          >
            {machines.map((machine) => (
              <option key={machine.id} value={machine.id}>
                {machine.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {!credentialId && (
        <label className="settings-label flex flex-col gap-1" htmlFor={`${id}-label`}>
          Name
          <Input
            id={`${id}-label`}
            value={label}
            maxLength={80}
            placeholder="The account’s email, if you leave this empty"
            disabled={pending}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
      )}
      {error && (
        <p className="settings-prose text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={pending} onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={!machineId}
          pending={pending}
          pendingLabel="Opening the terminal…"
        >
          Sign in on {machineName}
        </Button>
      </div>
    </form>
  )
}
