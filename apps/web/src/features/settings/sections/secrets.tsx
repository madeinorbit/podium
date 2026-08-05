/**
 * THE SECRETS SURFACE — PRESENCE AND FINGERPRINT, NEVER A VALUE (POD-421, 3.7d).
 *
 * What this replaces: `keys.tsx` and `integrations.tsx` rendered
 * `<Input type="password" value={settings.apiKeys[k]} />` — the blob member
 * bound straight into a form control. That is the exact failure the brief says
 * this issue exists to catch: *"a settings surface that type-checks and still
 * renders a value"*. `type="password"` hides it from a shoulder, not from the
 * DOM, not from the React tree, and not from the blob the form posts back.
 *
 * ---------------------------------------------------------------------------
 * NO FIELD HERE CAN ROUND-TRIP A REAL VALUE, AND IT IS STRUCTURAL
 * ---------------------------------------------------------------------------
 *
 * The input below is a WRITE-ONLY box: it is bound to local component state that
 * starts empty, it is never seeded from any server response, and it is cleared
 * on submit. That is not a discipline about what we remember to do — the data
 * needed to seed it does not exist on this screen. `settings.secretPresence`
 * answers `SecretPresenceWire[]`, which POD-418 built INDEPENDENTLY of
 * `ServerSecret` precisely so it has no value key, so there is nothing to bind
 * even if someone tried.
 *
 * ---------------------------------------------------------------------------
 * A MEMBER SEES THE SAME THING AN INSTANCE WITH NO SECRETS SEES
 * ---------------------------------------------------------------------------
 *
 * Whether a non-admin may see secret presence and fingerprint is an OPEN
 * question (`docs/multi-user-readiness.md` §3.1.2's existence-leak class), held
 * for a human on POD-352. Until it is answered this fails closed, and failing
 * closed has a UI obligation as well as a server one: readiness §3.1.5 says an
 * unauthorized read must fail IDENTICALLY to a nonexistent one, *"and that is as
 * true of an error toast as of an API status code."*
 *
 * So there is exactly ONE unavailable state in this component ({@link Unavailable}),
 * reached by both paths, with one string. Not a red error for the member and a
 * grey empty state for the empty instance — those are distinguishable, and the
 * difference tells a member whether this instance has a key configured, which is
 * the fact the floor is withholding. There is also no separate loading path: a
 * refusal that resolved faster than a success would be an oracle with a
 * stopwatch, so both land in the same state through the same effect.
 */

import type { SecretPresenceWire, ServerSecretKey } from '@podium/model'
import type { JSX } from 'react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Row, Section } from './shared'

/** How the five closed-vocabulary keys read to a human. A label table, not a
 *  second vocabulary: the KEYS come from the server's presence rows, so a key
 *  with no label here still renders (under its dotted name) rather than
 *  vanishing — a secret missing from the screen is worse than an ugly one. */
const SECRET_LABEL: Readonly<Record<string, string>> = {
  'apiKeys.openrouter': 'OpenRouter API key',
  'apiKeys.anthropic': 'Anthropic API key',
  'apiKeys.openai': 'OpenAI API key',
  'integrations.linearApiKey': 'Linear API key',
  'notifications.telegramBotToken': 'Telegram bot token',
}

/**
 * What the screen knows about the secret surface.
 *
 * `unavailable` is ONE state and carries no reason. A `{ reason: 'forbidden' |
 * 'empty' }` discriminant would be the oracle rebuilt inside the client: the
 * component would then be one `{reason === 'forbidden' && …}` away from
 * rendering the distinction, and that edit reviews as a helpful error message.
 */
export type SecretSurfaceState =
  | { status: 'loading' }
  | { status: 'available'; rows: readonly SecretPresenceWire[] }
  | { status: 'unavailable' }

export const SECRET_SURFACE_UNAVAILABLE =
  'Secret management is not available on this account. Ask an admin of this Podium instance.'

function Unavailable(): JSX.Element {
  return (
    <Section title="Managed credentials" hint={undefined}>
      <p className="settings-prose py-2" data-testid="secrets-unavailable">
        {SECRET_SURFACE_UNAVAILABLE}
      </p>
    </Section>
  )
}

/** The fingerprint, rendered as what it is: an opaque tag for telling one key
 *  from another across a rotation. Never presented as a prefix of the value —
 *  it is a truncated HMAC under a server-held key and shares no characters with
 *  the material (POD-420's producer, `SECRET_FINGERPRINT_CONTRACT`). */
function Fingerprint({ value }: { value: string }): JSX.Element {
  return (
    <span
      className="rounded bg-chip px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
      title="An opaque tag derived on the server. It tells two keys apart; it reveals nothing about either."
      data-testid="secret-fingerprint"
    >
      {value}
    </span>
  )
}

function SecretRow({
  row,
  canManage,
  onSet,
  onClear,
  busy,
}: {
  row: SecretPresenceWire
  canManage: boolean
  onSet: (key: ServerSecretKey, value: string) => void
  onClear: (key: ServerSecretKey) => void
  busy: boolean
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const label = SECRET_LABEL[row.key] ?? row.key
  const inputId = `secret-${row.key.replaceAll('.', '-')}`

  return (
    <Row
      label={label}
      description={
        <span className="flex flex-wrap items-center gap-1.5">
          <span data-testid={`secret-presence-${row.key}`}>
            {row.present ? 'Configured' : 'Not configured'}
          </span>
          {row.present && row.fingerprint && <Fingerprint value={row.fingerprint} />}
          {row.present && row.updatedAt && (
            <span className="text-text-dim">
              set {new Date(row.updatedAt).toLocaleDateString()}
            </span>
          )}
          {!canManage && (
            // DISABLED WITH A STATED REASON, never editable-then-refused. The
            // reason is on the row rather than only in a tooltip, because a
            // disabled control whose explanation requires hovering is a control
            // that reads as broken.
            <span className="text-text-dim">· admin only</span>
          )}
        </span>
      }
    >
      <div className="flex w-full min-w-0 items-center gap-1.5">
        <Input
          id={inputId}
          type="password"
          autoComplete="off"
          aria-label={`${label} — new value`}
          // WRITE-ONLY. Bound to local state that starts empty and is never
          // seeded from a server response; there is no value on this screen to
          // seed it FROM. `placeholder` reflects presence, which is a fact the
          // server does publish.
          placeholder={row.present ? 'Replace…' : 'Not set'}
          value={draft}
          disabled={!canManage || busy}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          // Keyed, not positional. A `getByRole('button', { name: 'Save' })
          // .first()` in a spec picks whichever row renders first — which is a
          // different secret from the one the test filled, and it fails as a
          // disabled button rather than as a wrong target. Five identical
          // controls need addressable ids.
          data-testid={`secret-save-${row.key}`}
          disabled={!canManage || busy || draft.trim() === ''}
          onClick={() => {
            onSet(row.key, draft)
            // Cleared IMMEDIATELY, not in a `.then()`: on a failed write the
            // typed material would otherwise sit in a live React state tree for
            // as long as the tab stays open.
            setDraft('')
          }}
        >
          Save
        </Button>
        {row.present && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid={`secret-clear-${row.key}`}
            disabled={!canManage || busy}
            onClick={() => onClear(row.key)}
          >
            Clear
          </Button>
        )}
      </div>
    </Row>
  )
}

export function SecretsSection({
  state,
  canManage,
  onSet,
  onClear,
  busy,
  error,
}: {
  state: SecretSurfaceState
  /** Whether `settings.setSecret` / `clearSecret` may be ATTEMPTED — read from
   *  `settings.viewer`, which is derived from the same gate the server enforces
   *  so the disabled state and the refusal cannot disagree. */
  canManage: boolean
  onSet: (key: ServerSecretKey, value: string) => void
  onClear: (key: ServerSecretKey) => void
  busy: boolean
  error: string | null
}): JSX.Element {
  if (state.status === 'unavailable') return <Unavailable />
  if (state.status === 'loading') {
    return (
      <Section title="Managed credentials">
        <div className="animate-pulse py-3" aria-hidden="true">
          <div className="h-3 w-40 rounded bg-chip" />
        </div>
      </Section>
    )
  }

  return (
    // No `hint`, and the title is the CONTENT rather than the class: the
    // surface banner above already reads "Secrets" with the class sentence, and
    // repeating both rendered the same heading and the same paragraph twice.
    <Section title="Managed credentials">
      {error && (
        <p className="py-1 text-[12px] text-destructive" role="alert">
          {error}
        </p>
      )}
      {state.rows.map((row) => (
        <SecretRow
          key={row.key}
          row={row}
          canManage={canManage}
          onSet={onSet}
          onClear={onClear}
          busy={busy}
        />
      ))}
      <p className="settings-prose mt-3">
        Replacing a key takes effect immediately and cannot be undone — the previous value is
        overwritten on the server. These writes are never queued offline.
      </p>
    </Section>
  )
}
