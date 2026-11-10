/**
 * Shared row primitives and account/provider labels for settings pages.
 */
import { SETTINGS_PATH_TIERS, settingsTierForPath } from '@podium/model/browser'
import type { HarnessDescriptorWire } from '@podium/protocol'
import type { ApiProvider, HarnessAgent, PodiumSettings } from '@podium/runtime'
import { observer } from 'mobx-react-lite'
import {
  type ChangeEvent,
  type ComponentProps,
  createContext,
  type JSX,
  type ReactNode,
  useContext,
  useId,
  useRef,
  useState,
} from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { issueAgentDescriptors } from '@/lib/issue-agents'
import { useSettingsRowId } from '../settings-anchors'
import { useSettingsFrame } from '../settings-frame'

export function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: React.ReactNode
}): JSX.Element {
  // The separating rule and its spacing live in `.settings-measure > section`
  // (styles.css): the `first:` guard that used to be here could never fire,
  // because the class banner — not this section — is the pane's first child.
  return (
    <section>
      <h3 className="settings-h mb-1.5">{title}</h3>
      {hint && <p className="settings-prose mb-4">{hint}</p>}
      {children}
    </section>
  )
}

/** A named group INSIDE a section (Terminal, Reset settings, …). One step below
 *  `Section`'s heading — it used to be a step ABOVE it at 13px, so a subgroup
 *  outranked the section that contained it. */
export function Subsection({
  title,
  hint,
  children,
}: {
  title: string
  hint?: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="mt-6 border-hairline-soft/70 border-t pt-5">
      <h4 className="settings-h2 mb-1">{title}</h4>
      {hint && <p className="settings-prose mb-3.5">{hint}</p>}
      {children}
    </div>
  )
}

/** Supply the existing synced settings object, never a copy of its values.
 * `setting` binds a row to its command permission, pending write and refusal.
 * Page tasks should pass the dotted leaf (or list of leaves) they edit. */
export interface SettingsControlsState {
  settings?: PodiumSettings
  permitted?: Readonly<Record<string, boolean>>
  feedback?: Readonly<Record<string, { pending?: boolean; error?: string }>>
  readOnly?: boolean
}
export const SettingsControlsContext = createContext<SettingsControlsState>({})
/** Header actions and custom controls use the same default-closed answer. */
export function useSettingsPermitted(command: string): boolean {
  return useContext(SettingsControlsContext).permitted?.[command] === true
}

type Setting = string | readonly string[]
interface RowProps {
  label: string
  description?: ReactNode
  setting?: Setting
  readOnly?: boolean
  readOnlyValue?: ReactNode
  device?: boolean
  error?: string | null
  pending?: boolean
  children?: ReactNode
}

function useRowState({ setting, readOnly, pending, error }: RowProps) {
  const state = useContext(SettingsControlsContext)
  const paths = setting ? (typeof setting === 'string' ? [setting] : setting) : []
  const fields = SETTINGS_PATH_TIERS.filter((field) =>
    paths.some(
      (path) =>
        field.path === path ||
        field.path.startsWith(`${path}.`) ||
        path.startsWith(`${field.path}.`),
    ),
  )
  const denied =
    state.permitted !== undefined &&
    fields.some((field) => {
      const tier = settingsTierForPath(field.path)
      const command =
        tier === 'personal-preference'
          ? 'records.userPreferences.edit'
          : tier === 'instance-preference'
            ? 'records.instancePreferences.edit'
            : 'settings.setSecret'
      return state.permitted?.[command] !== true
    })
  const feedback = Object.entries(state.feedback ?? {}).filter(([path]) =>
    paths.some((prefix) => path === prefix || path.startsWith(`${prefix}.`)),
  )
  return {
    readOnly: Boolean(readOnly || state.readOnly || denied),
    pending: Boolean(pending || feedback.some(([, status]) => status.pending)),
    error: error || feedback.find(([, status]) => status.error)?.[1].error,
    value: state.settings && paths[0] ? rowValue(state.settings, paths[0]) : undefined,
  }
}
function rowValue(settings: PodiumSettings, path: string): unknown {
  let value: unknown = settings
  for (const key of path.split('.'))
    value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
  return value
}
function displayValue(value: unknown): ReactNode {
  return typeof value === 'boolean'
    ? value
      ? 'On'
      : 'Off'
    : typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : '—'
}

export function ThisDeviceTag() {
  return (
    <span className="settings-micro rounded border border-hairline-soft px-1.5 py-0.5 whitespace-nowrap">
      This device
    </span>
  )
}

export const Row = observer(function Row(props: RowProps): JSX.Element {
  const { label, description, children, device, readOnlyValue } = props
  const searchId = useSettingsRowId(label)
  const id = useId()
  const state = useRowState(props)
  return (
    <div
      id={searchId}
      className="settings-row"
      tabIndex={searchId ? -1 : undefined}
      data-readonly={state.readOnly || undefined}
      aria-busy={state.pending || undefined}
    >
      <div className="min-w-0">
        <span id={`${id}-label`} className="settings-label inline-flex items-center gap-2">
          {label}
          {device && <ThisDeviceTag />}
        </span>
        {description && <p className="settings-prose mt-1">{description}</p>}
        {state.error && (
          <p id={`${id}-error`} className="settings-prose mt-1 text-destructive" role="alert">
            {state.error}
          </p>
        )}
      </div>
      {state.readOnly ? (
        <div className="settings-control">
          <span className="settings-label text-muted-foreground">
            {readOnlyValue ?? displayValue(state.value)}
          </span>
        </div>
      ) : (
        <fieldset
          className="settings-control m-0 min-w-0 border-0 p-0"
          disabled={state.pending}
          aria-labelledby={`${id}-label`}
          aria-describedby={state.error ? `${id}-error` : undefined}
        >
          {children}
        </fieldset>
      )}
    </div>
  )
})

/** Input-compatible field whose local text is committed on Enter or blur.
 * Existing clamp callbacks run only then; each keystroke stays untouched.
 * Escape drops only the text in this field. */
export function CommitInput({
  value,
  onChange,
  onBlur,
  onKeyDown,
  ...props
}: ComponentProps<typeof Input>) {
  const [text, setText] = useState<string | null>(null)
  const committed = useRef(false)
  const commit = (event: { target: EventTarget; currentTarget: HTMLInputElement }) => {
    if (committed.current) return
    committed.current = true
    if (text !== null && text !== String(value ?? ''))
      onChange?.(event as ChangeEvent<HTMLInputElement>)
    setText(null)
  }
  return (
    <Input
      {...props}
      value={text ?? value ?? ''}
      onChange={(event) => {
        committed.current = false
        setText(event.target.value)
      }}
      onBlur={(event) => {
        commit(event)
        onBlur?.(event)
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.defaultPrevented || event.nativeEvent.isComposing) return
        if (event.key === 'Enter') {
          event.preventDefault()
          commit(event)
          event.currentTarget.blur()
        }
        if (event.key === 'Escape' && text !== null) {
          event.preventDefault()
          event.stopPropagation()
          committed.current = true
          setText(null)
        }
      }}
    />
  )
}

type Change<T> = (value: T) => unknown
function useControlChange<T>(onChange: Change<T>, setting?: Setting) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (next: T, previous: T) => {
    if (Object.is(next, previous) || pending) return
    setError(null)
    setPending(true)
    try {
      await onChange(next)
      // Record-backed rows get their Undo from SettingsView.patch. Other row
      // writers (including this-device preferences) get it here.
      if (!setting)
        toast('Saved', {
          action: {
            label: 'Undo',
            onClick: () => {
              void Promise.resolve()
                .then(() => onChange(previous))
                .catch((error: unknown) => {
                  const reason = error instanceof Error ? error.message : String(error)
                  setError(reason)
                  toast.error(reason)
                })
            },
          },
        })
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }
  return { pending, error, run }
}

export function SwitchRow({
  value,
  onChange,
  disabled,
  ...props
}: RowProps & {
  value: boolean
  onChange: Change<boolean>
  disabled?: boolean
}) {
  const change = useControlChange(onChange, props.setting)
  return (
    <Row {...props} {...change} readOnlyValue={value ? 'On' : 'Off'}>
      <Switch
        aria-label={props.label}
        checked={value}
        disabled={disabled || change.pending}
        onCheckedChange={(next) => void change.run(next, value)}
      />
    </Row>
  )
}
export interface RowOption<T extends string = string> {
  value: T
  label: string
  hint?: string
  disabled?: boolean
}
export function SegmentedRow<T extends string>({
  value,
  onChange,
  options,
  ...props
}: RowProps & {
  value: T
  onChange: Change<T>
  options: readonly RowOption<T>[]
}) {
  const change = useControlChange(onChange, props.setting)
  return (
    <Row
      {...props}
      {...change}
      error={change.error ?? props.error}
      pending={change.pending || props.pending}
      readOnlyValue={options.find((o) => o.value === value)?.label ?? value}
    >
      <fieldset
        aria-label={props.label}
        className="m-0 flex min-w-0 rounded-lg border border-hairline-soft bg-muted/40 p-0.5"
      >
        {options.map((option) => (
          <Button
            key={option.value}
            type="button"
            size="sm"
            variant="ghost"
            aria-pressed={value === option.value}
            disabled={option.disabled || change.pending}
            className={
              value === option.value ? 'bg-secondary text-foreground' : 'text-muted-foreground'
            }
            onClick={() => void change.run(option.value, value)}
          >
            {option.label}
          </Button>
        ))}
      </fieldset>
    </Row>
  )
}
export interface RowOptionGroup<T extends string = string> {
  label: string
  options: readonly RowOption<T>[]
}
export function SelectRow<T extends string>({
  value,
  onChange,
  options = [],
  groups = [],
  placeholder,
  ...props
}: RowProps & {
  value: T
  onChange: Change<T>
  options?: readonly RowOption<T>[]
  groups?: readonly RowOptionGroup<T>[]
  placeholder?: string
}) {
  const change = useControlChange(onChange, props.setting)
  const selected = [...options, ...groups.flatMap((g) => g.options)].find((o) => o.value === value)
  const items = (options: readonly RowOption<T>[]) =>
    options.map((option) => (
      <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
        <span className="flex min-w-0 flex-col">
          <span>{option.label}</span>
          {option.hint && (
            <span className="settings-micro text-muted-foreground">{option.hint}</span>
          )}
        </span>
      </SelectItem>
    ))
  return (
    <Row {...props} {...change} readOnlyValue={selected?.label ?? value}>
      <Select
        value={value}
        disabled={change.pending}
        onValueChange={(next) => {
          if (next !== null) void change.run(next as T, value)
        }}
      >
        <SelectTrigger aria-label={props.label} className="w-full">
          <SelectValue placeholder={placeholder}>
            {selected ? (
              <span className="flex min-w-0 gap-1.5">
                <span>{selected.label}</span>
                {selected.hint && (
                  <span className="truncate text-muted-foreground">{selected.hint}</span>
                )}
              </span>
            ) : (
              value || placeholder
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {items(options)}
          {groups.map((group) => (
            <SelectGroup key={group.label}>
              <SelectLabel>{group.label}</SelectLabel>
              {items(group.options)}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </Row>
  )
}
export function TextRow({
  value,
  onChange,
  placeholder,
  ...props
}: RowProps & {
  value: string
  onChange: Change<string>
  placeholder?: string
}) {
  const change = useControlChange(onChange, props.setting)
  return (
    <Row {...props} {...change} readOnlyValue={value || placeholder || '—'}>
      <CommitInput
        aria-label={props.label}
        value={value}
        placeholder={placeholder}
        onChange={(event) => void change.run(event.target.value, value)}
      />
    </Row>
  )
}
export function NumberRow({
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  unit,
  emptyValue = null,
  placeholder,
  ...props
}: RowProps & {
  value: number | null | undefined
  onChange: Change<number | null | undefined>
  min?: number
  max?: number
  step?: number
  unit?: string
  emptyValue?: null | undefined
  placeholder?: string
}) {
  const change = useControlChange(onChange, props.setting)
  return (
    <Row
      {...props}
      {...change}
      error={change.error ?? props.error}
      pending={change.pending || props.pending}
      readOnlyValue={value == null ? placeholder || '—' : `${value}${unit ? ` ${unit}` : ''}`}
    >
      <div className="flex items-center gap-2">
        <CommitInput
          aria-label={props.label}
          className="w-24"
          type="number"
          value={value ?? ''}
          min={Number.isFinite(min) ? min : undefined}
          max={Number.isFinite(max) ? max : undefined}
          step={step}
          placeholder={placeholder}
          onChange={(event) => {
            const raw = event.target.value
            const parsed = Number(raw)
            const next =
              raw === ''
                ? emptyValue
                : Number.isFinite(parsed)
                  ? Math.min(max, Math.max(min, parsed))
                  : value
            void change.run(next, value)
          }}
        />
        {unit && <span className="settings-micro text-muted-foreground">{unit}</span>}
      </div>
    </Row>
  )
}
export function ValueRow({ value, ...props }: RowProps & { value: ReactNode }) {
  return <Row {...props} readOnly readOnlyValue={value} />
}

/** A secret flow receives only presence and the last four characters. For
 * Remove, its owner must supply an undo command; no secret material is read. */
export function SecretRow({
  present,
  last4,
  onSave,
  onRemove,
  hasPassword = false,
  ...props
}: RowProps & {
  present: boolean
  hasPassword?: boolean
  last4?: string | null
  onSave: (value: string) => Promise<unknown>
  onRemove?: () => Promise<() => Promise<unknown>>
}) {
  const { openTakeover, closeTakeover } = useSettingsFrame()
  const [confirming, setConfirming] = useState(false)
  const row = useRowState(props)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const remove = async () => {
    if (!onRemove) return
    setError(null)
    setPending(true)
    try {
      const undo = await onRemove()
      setConfirming(false)
      toast(
        'Removed',
        undo
          ? {
              action: {
                label: 'Undo',
                onClick: () => {
                  void undo().catch((error: unknown) => {
                    setError(error instanceof Error ? error.message : String(error))
                  })
                },
              },
            }
          : undefined,
      )
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <>
      <Row
        {...props}
        error={error}
        pending={pending}
        readOnlyValue={present ? `•••• ${last4?.slice(-4) ?? 'Set'}` : 'Not set'}
      >
        {present && (
          <span className="settings-micro font-mono">•••• {last4?.slice(-4) ?? 'Set'}</span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            openTakeover({
              title: `${present ? 'Replace' : 'Add'} ${props.label}`,
              content: <SecretEntry label={props.label} onSave={onSave} onDone={closeTakeover} />,
            })
          }
        >
          {present ? 'Replace' : 'Add'}
        </Button>
        {present && onRemove && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            Remove
          </Button>
        )}
      </Row>
      {confirming && !row.readOnly && (
        <ConfirmInline
          sentence={`Remove ${props.label}?`}
          actionLabel="Remove"
          hasPassword={hasPassword}
          destructive
          pending={pending}
          error={error}
          onConfirm={remove}
          onCancel={() => {
            setConfirming(false)
            setError(null)
          }}
        />
      )}
    </>
  )
}
function SecretEntry({
  label,
  onSave,
  onDone,
}: {
  label: string
  onSave: (value: string) => Promise<unknown>
  onDone: () => void
}) {
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (!value.trim() || pending) return
        setPending(true)
        setError(null)
        void onSave(value)
          .then(() => {
            toast('Saved')
            onDone()
          })
          .catch((error: unknown) => {
            setError(error instanceof Error ? error.message : String(error))
          })
          .finally(() => setPending(false))
      }}
    >
      <Row label={label} error={error}>
        <Input
          autoFocus
          aria-label={label}
          type="password"
          autoComplete="off"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </Row>
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!value.trim()} pending={pending} pendingLabel="Saving…">
          Save
        </Button>
      </div>
    </form>
  )
}

/** The one confirmation block: render immediately under the triggering row.
 * Only ask for a password when the viewer has one AND the action requires it.
 * onConfirm may reject; the block keeps its input and displays the reason. */
export function ConfirmInline({
  sentence,
  actionLabel,
  onConfirm,
  onCancel,
  hasPassword = false,
  acknowledgement,
  pending = false,
  error,
  destructive = false,
}: {
  sentence: ReactNode
  actionLabel: string
  onConfirm: (password: string) => unknown
  onCancel: () => void
  hasPassword?: boolean
  acknowledgement?: ReactNode
  pending?: boolean
  error?: string | null
  destructive?: boolean
}) {
  const id = useId()
  const [password, setPassword] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const busy = pending || submitting
  const ready = (!hasPassword || password.length > 0) && (!acknowledgement || acknowledged)
  return (
    <form
      className="mt-2 mb-4 border-l-2 border-border-strong py-2 pl-4"
      aria-label={actionLabel}
      onSubmit={(event) => {
        event.preventDefault()
        if (!ready || busy) return
        setSubmitting(true)
        setFailure(null)
        void Promise.resolve()
          .then(() => onConfirm(hasPassword ? password : ''))
          .catch((error: unknown) => {
            setFailure(error instanceof Error ? error.message : String(error))
          })
          .finally(() => setSubmitting(false))
      }}
    >
      <p className="settings-prose">{sentence}</p>
      {hasPassword && (
        <label className="settings-label mt-3 block" htmlFor={`${id}-password`}>
          Your password
          <Input
            id={`${id}-password`}
            type="password"
            autoComplete="current-password"
            className="mt-1 max-w-72"
            value={password}
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
      )}
      {acknowledgement && (
        <label className="settings-prose mt-3 flex items-start gap-2" htmlFor={`${id}-ack`}>
          <Checkbox
            id={`${id}-ack`}
            checked={acknowledged}
            disabled={busy}
            onCheckedChange={(value) => setAcknowledged(value === true)}
          />
          <span>{acknowledgement}</span>
        </label>
      )}
      {(failure || error) && (
        <p className="settings-prose mt-2 text-destructive" role="alert">
          {failure || error}
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          variant={destructive ? 'destructive' : 'default'}
          disabled={!ready || busy}
          pending={busy}
          pendingLabel="Working…"
        >
          {actionLabel}
        </Button>
      </div>
    </form>
  )
}

/** One row from `accounts.list` — a native CLI login or a managed API key. */
export type { AccountView } from '@podium/model'

export function providerLabel(p: ApiProvider): string {
  switch (p) {
    case 'openrouter':
      return 'OpenRouter'
    case 'anthropic':
      return 'Anthropic'
    case 'openai':
      return 'OpenAI'
    // The remaining provider namespace is the ChatGPT Responses API
    // (ApiProvider codex): a provider name, not a harness kind. A default
    // keeps the harness literal out of this client (POD-4541).
    default:
      return 'Codex (ChatGPT)'
  }
}

/**
 * Native-harness label, read off descriptors (POD-4475). Unknown ids render
 * verbatim rather than borrowing another harness's name.
 */
export function harnessAgentLabel(
  agent: HarnessAgent | string,
  descriptors?: readonly HarnessDescriptorWire[],
): string {
  return issueAgentDescriptors(descriptors).find((d) => d.kind === agent)?.label ?? String(agent)
}

export function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function clampNumber(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseFloat(raw)
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
