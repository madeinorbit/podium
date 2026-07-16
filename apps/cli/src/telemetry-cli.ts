/**
 * `podium telemetry` [spec:SP-f933] — the standing audit surface.
 *
 * Design: docs/internal/superpowers/specs/2026-07-16-telemetry-design.md
 *
 *   podium telemetry                    status: per-tier state + endpoint + installId
 *   podium telemetry on  [--usage] [--crash]    no flag = both
 *   podium telemetry off [--usage] [--crash]    no flag = both
 *   podium telemetry show               the exact pending + last-sent payloads
 *   podium telemetry reset-id           a new installId
 *
 * `show` is the point of this command: whatever we say in the docs, a user can
 * read the literal bytes that are queued and the literal bytes we last sent.
 * That is worth more trust than any amount of prose (Syncthing's lesson), so it
 * prints the real queue file — never a re-derived example.
 *
 * Every path here is read/write against config.json only: `podium telemetry
 * off` must work whether or not the server is running (D8), which is precisely
 * why the state does not live in the settings blob.
 */
import { loadConfig, stateDir } from '@podium/runtime/config'
import {
  indentExample,
  readLastSent,
  readQueue,
  readTelemetryState,
  resetInstallId,
  setConsent,
  type TelemetryState,
  type TelemetryTier,
} from '@podium/telemetry'

export const TELEMETRY_USAGE = [
  'usage: podium telemetry [command]',
  '',
  'Commands:',
  '  (none)                Show what is on, where it would go, and your install id',
  '  on  [--usage] [--crash]   Turn tiers on  (no flag = both)',
  '  off [--usage] [--crash]   Turn tiers off (no flag = both)',
  '  show                  Print the exact pending + last-sent payloads',
  '  reset-id              Mint a new random install id',
  '',
  'Nothing is ever sent unless a tier is explicitly on. DO_NOT_TRACK=1 or',
  'PODIUM_TELEMETRY=off disable everything regardless of these settings.',
  'Details: docs/TELEMETRY.md · https://podium.dev/telemetry',
].join('\n')

/** Which tiers a `on`/`off` invocation targets. No flag = both (documented). */
export function tiersFromFlags(args: string[]): TelemetryTier[] | { error: string } {
  const unknown = args.find((a) => a !== '--usage' && a !== '--crash')
  if (unknown) return { error: `podium telemetry: unknown option ${unknown}` }
  const tiers: TelemetryTier[] = []
  if (args.includes('--usage')) tiers.push('usage')
  if (args.includes('--crash')) tiers.push('crash')
  return tiers.length ? tiers : ['usage', 'crash']
}

function tierLabel(state: TelemetryState, tier: TelemetryTier): string {
  const value = state[tier]
  const shown = value === 'absent' ? 'off (never asked)' : value
  // A kill switch masks the stored value rather than erasing it — say so, so
  // "I set it to on and it says off" is never a mystery.
  return state.suppressedBy && value === 'on'
    ? `${shown} — forced off by ${state.suppressedBy}`
    : shown
}

export function statusText(state: TelemetryState): string {
  const lines = [
    'Telemetry (opt-in, off unless you turned it on)',
    '',
    `  usage      ${tierLabel(state, 'usage')}`,
    `  crash      ${tierLabel(state, 'crash')}`,
    `  endpoint   ${state.endpoint}`,
    `  installId  ${state.installId ?? '(none — minted only when you opt in)'}`,
  ]
  if (state.suppressedBy) {
    lines.push('', `  ${state.suppressedBy} is set — nothing is collected or sent.`)
  }
  lines.push('', 'Change it:  podium telemetry on|off [--usage] [--crash]')
  lines.push('See it:     podium telemetry show')
  return lines.join('\n')
}

/** `podium telemetry show` — the literal pending + last-sent bytes.
 *
 *  When there is nothing real yet — the common case, since the setup prompt
 *  points here and telemetry is off by default — it falls back to the example.
 *  Answering "what would you send me?" is the whole reason this command exists,
 *  and "(nothing queued)" answers it for nobody. The example is labelled as an
 *  example every time it appears: a preview must never be mistakable for a
 *  record of something actually sent. */
export function showText(dir: string = stateDir()): string {
  const pending = readQueue(dir)
  const lastSent = readLastSent(dir)
  const lines = ['Pending (queued, not yet sent):']
  lines.push(
    pending.length
      ? pending.map((r) => JSON.stringify(r, null, 2)).join('\n')
      : '  (nothing queued)',
  )
  lines.push('', 'Last sent:')
  lines.push(
    lastSent
      ? `  at ${lastSent.at}\n${JSON.stringify(lastSent.report, null, 2)}`
      : '  (nothing has ever been sent)',
  )
  if (!pending.length && !lastSent) {
    lines.push(
      '',
      'EXAMPLE — not real data, nothing has been collected. If you turned',
      'usage reporting on, one report a day would look like this:',
      '',
      indentExample(),
    )
  }
  lines.push('', `Queue file: ${dir}/telemetry/queue.jsonl`)
  return lines.join('\n')
}

export interface TelemetryCliIO {
  print(s: string): void
  printErr(s: string): void
}

const realIO: TelemetryCliIO = {
  print: (s) => console.log(s),
  printErr: (s) => console.error(s),
}

/** Returns the process exit code (0 ok, 2 usage error). */
export function telemetryCliMain(argv: string[], io: TelemetryCliIO = realIO): number {
  const [command, ...rest] = argv

  if (command === '--help' || command === '-h' || command === 'help') {
    io.print(TELEMETRY_USAGE)
    return 0
  }

  if (command === undefined) {
    io.print(statusText(readTelemetryState(loadConfig())))
    return 0
  }

  if (command === 'show') {
    io.print(showText())
    return 0
  }

  if (command === 'reset-id') {
    const state = resetInstallId()
    io.print(`New install id: ${state.installId}`)
    io.print('The previous id is gone; reports from before are not linkable to this one.')
    return 0
  }

  if (command === 'on' || command === 'off') {
    const tiers = tiersFromFlags(rest)
    if ('error' in tiers) {
      io.printErr(tiers.error)
      io.printErr(TELEMETRY_USAGE)
      return 2
    }
    const updates = Object.fromEntries(tiers.map((t) => [t, command])) as Partial<
      Record<TelemetryTier, 'on' | 'off'>
    >
    const state = setConsent(updates)
    io.print(statusText(state))
    // Turning a tier on while a kill switch is set would otherwise look like it
    // silently did nothing — the config DID change; the env still wins.
    if (command === 'on' && state.suppressedBy) {
      io.print('')
      io.print(
        `Note: ${state.suppressedBy} is set in this environment, so nothing will be sent until it is unset.`,
      )
    }
    return 0
  }

  io.printErr(`podium telemetry: unknown command '${command}'`)
  io.printErr(TELEMETRY_USAGE)
  return 2
}
