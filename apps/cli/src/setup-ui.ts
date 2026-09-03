/**
 * THE presentation seam for every terminal setup surface: `podium setup`,
 * `podium setup --vps`, and `podium install-finish`.
 *
 * It exists because the old contract — `{ prompt(q): Promise<string>; print(s): void }` — made
 * the shape of the interface the shape of `readline`. Every choice became a numbered list read
 * back as a string (`Choose 1-4:`, `[Y/n]`, `Type "open" to run without a password`), and every
 * loop needed a MAX_ATTEMPTS counter because readline resolves '' forever at EOF rather than
 * telling you the operator left.
 *
 * The intents here map onto @clack/prompts, which answers both: a `select` is a select, and a
 * cancelled prompt returns CANCEL instead of an empty string that looks like an answer.
 */
import * as p from '@clack/prompts'

/** A cancelled prompt — Ctrl-C, EOF, or a scripted run that ran out of answers. */
export const CANCEL: unique symbol = Symbol.for('podium.setup-ui.cancel') as never
export type Cancellable<T> = T | typeof CANCEL

export function isCancel(v: unknown): v is typeof CANCEL {
  return v === CANCEL
}

export interface SelectOptions<T> {
  message: string
  options: { value: T; label: string; hint?: string }[]
  initialValue?: T
}
export interface TextOptions {
  message: string
  placeholder?: string
  defaultValue?: string
  validate?: (value: string) => string | undefined
}
export interface PasswordOptions {
  message: string
  validate?: (value: string) => string | undefined
}
export interface ConfirmOptions {
  message: string
  initialValue?: boolean
}
export interface Spinner {
  start(message: string): void
  stop(message?: string): void
  /** Stop in a failure state — clack draws a different sigil for this than for `stop`. */
  error(message?: string): void
}

export interface SetupIO {
  intro(title: string): void
  outro(message: string): void
  note(body: string, title?: string): void
  /**
   * THE copy-paste primitive. Renders `command` in a box of its own with nothing else on its
   * line, so that what an operator drag-selects is exactly what they should run. Pass several
   * commands as separate lines; each keeps its own line.
   */
  command(command: string, caption?: string): void
  step(message: string): void
  success(message: string): void
  warn(message: string): void
  error(message: string): void
  select<T>(o: SelectOptions<T>): Promise<Cancellable<T>>
  text(o: TextOptions): Promise<Cancellable<string>>
  password(o: PasswordOptions): Promise<Cancellable<string>>
  confirm(o: ConfirmOptions): Promise<Cancellable<boolean>>
  spinner(): Spinner
}

/** clack signals cancellation with its own symbol; translate at the boundary so no caller
 *  outside this file has to know which prompt library is underneath. */
function fromClack<T>(v: T | symbol): Cancellable<T> {
  return p.isCancel(v) ? CANCEL : (v as T)
}

export function clackIO(): SetupIO {
  return {
    intro: (title) => p.intro(title),
    outro: (message) => p.outro(message),
    note: (body, title) => p.note(body, title),
    command: (command, caption) => p.note(command, caption),
    step: (message) => p.log.step(message),
    success: (message) => p.log.success(message),
    warn: (message) => p.log.warn(message),
    error: (message) => p.log.error(message),
    select: async <T>(o: SelectOptions<T>) =>
      fromClack(
        await p.select({
          message: o.message,
          options: o.options.map((x) => ({
            value: x.value,
            label: x.label,
            ...(x.hint ? { hint: x.hint } : {}),
          })),
          ...(o.initialValue === undefined ? {} : { initialValue: o.initialValue }),
        } as Parameters<typeof p.select>[0]),
      ) as Cancellable<T>,
    text: async (o) =>
      fromClack(
        await p.text({
          message: o.message,
          ...(o.placeholder ? { placeholder: o.placeholder } : {}),
          ...(o.defaultValue ? { defaultValue: o.defaultValue } : {}),
          ...(o.validate ? { validate: (v: string | undefined) => o.validate?.(v ?? '') } : {}),
        }),
      ),
    password: async (o) =>
      fromClack(
        await p.password({
          message: o.message,
          ...(o.validate ? { validate: (v: string | undefined) => o.validate?.(v ?? '') } : {}),
        }),
      ),
    confirm: async (o) =>
      fromClack(
        await p.confirm({
          message: o.message,
          ...(o.initialValue === undefined ? {} : { initialValue: o.initialValue }),
        }),
      ),
    spinner: () => {
      const s = p.spinner()
      return {
        start: (message) => s.start(message),
        stop: (message) => s.stop(message),
        error: (message) => s.error(message),
      }
    },
  }
}

/**
 * The test double. ONE ordered queue serves every widget kind, so a test can list answers in
 * the order an operator would give them without tracking which prompt each belongs to. An
 * exhausted queue yields CANCEL — the same terminating condition as a real Ctrl-C, which is
 * what keeps a flow from spinning when a test under-supplies answers.
 */
export function scriptedIO(answers: unknown[]): { io: SetupIO; output: string[] } {
  const queue = [...answers]
  const output: string[] = []
  // `output` is LINE-oriented: a multi-line note or command block contributes one entry per
  // line, so a test can assert that a command sits alone on its own line (R9) rather than
  // merely appearing somewhere inside a blob.
  const say = (s: string) => {
    output.push(...s.split('\n'))
  }
  /** Shift answers until one passes `validate`; CANCEL when the queue runs dry. */
  const take = <T>(validate?: (value: string) => string | undefined): Cancellable<T> => {
    while (queue.length > 0) {
      const next = queue.shift()
      if (!validate) return next as T
      if (validate(String(next ?? '')) === undefined) return next as T
    }
    return CANCEL
  }
  return {
    io: {
      intro: say,
      outro: say,
      note: (body, title) => say(title ? `${title}\n${body}` : body),
      command: (command, caption) => say(caption ? `${caption}\n${command}` : command),
      step: say,
      success: say,
      warn: say,
      error: say,
      select: async <T>(_o: SelectOptions<T>) => take<T>(),
      text: async (o) => {
        const v = take<string>(o.validate)
        if (isCancel(v)) return v
        return v === '' || v === undefined ? (o.defaultValue ?? '') : v
      },
      password: async (o) => take<string>(o.validate),
      confirm: async (o) => {
        const v = take<boolean>()
        if (isCancel(v)) return v
        return v === undefined ? (o.initialValue ?? false) : v
      },
      spinner: () => ({
        start: (message) => say(message),
        stop: (message) => {
          if (message) say(message)
        },
        error: (message) => {
          if (message) say(message)
        },
      }),
    },
    output,
  }
}
