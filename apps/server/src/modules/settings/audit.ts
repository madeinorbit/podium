/**
 * RECORDING A SETTINGS COMMAND (POD-421, 3.7d) — the join between the contract's
 * `redaction` metadata, the transport principal, and the append-only trail.
 *
 * This is the one place a settings audit row is built, so the three properties
 * the brief names hold for every command rather than per handler:
 *
 *   * the pair is UNCOLLAPSED and comes from the principal (ADR 9 D5 A3);
 *   * a system write is attributed as `system` with no human (ADR 9 D8 S5);
 *   * the detail is redacted through the COMMAND'S OWN declaration, and the
 *     redaction is named rather than merely performed.
 *
 * ---------------------------------------------------------------------------
 * A REFUSAL IS RECORDED, AND ITS MESSAGE IS CHECKED
 * ---------------------------------------------------------------------------
 *
 * Two things about the error path, which is the half the brief singles out as
 * *"the place redaction is usually forgotten"*:
 *
 * 1. **The refused input is redacted by the same rule as the applied one.** The
 *    obvious mistake is to redact the success path (where you are thinking about
 *    what you store) and log the raw input on the failure path (where you are
 *    thinking about what went wrong). `settings.setSecret` refused for being
 *    below the floor still carries the material in its input; a trail that logs
 *    it has leaked the credential precisely when nobody was watching.
 *
 * 2. **The error MESSAGE is checked against the redacted paths.** A path list
 *    cannot address a substring, so nothing in the declaration can stop
 *    `Invalid value "sk-ant-…"` from being recorded. {@link recordSettingsCommand}
 *    therefore asks `messageMentionsRedactedValue`, and replaces the whole
 *    message when it says yes. That is a backstop, not the mechanism — the
 *    mechanism is that no message is BUILT from a redacted path — but a backstop
 *    on the one thing a declaration structurally cannot cover is worth its cost.
 */

import {
  type AnyCommandContract,
  messageMentionsRedactedValue,
  REDACTED,
  redactReport,
  redactUnknownForLog,
  SETTINGS_CONTRACTS,
} from '@podium/commands'
import type { CommandPrincipal } from '../../command-principal'
import {
  type SettingsAuditOutcome,
  type SettingsAuditRepository,
  settingsAuditRow,
} from '../../store/settings-audit'

/** What a message becomes when it was found to contain redacted material. The
 *  command name is kept — a record naming nothing is not a record. */
export const REDACTED_MESSAGE = `${REDACTED} (the error text named a redacted value)`

export interface SettingsAuditPort {
  readonly repo: Pick<SettingsAuditRepository, 'append'>
  readonly now: () => string
}

/**
 * Record one settings command, applied or refused.
 *
 * `input` is the PARSED input as the transport received it. It is redacted here
 * and nowhere else, so a caller cannot accidentally hand a pre-redacted payload
 * to the redactor twice (harmless) or an un-redacted one to the store (not).
 */
export function recordSettingsCommand(
  port: SettingsAuditPort,
  args: {
    command: string
    outcome: SettingsAuditOutcome
    principal: CommandPrincipal
    input: unknown
    /** Present on a refusal. Recorded under `error`, after the substring check. */
    error?: string
  },
): void {
  const contract = (SETTINGS_CONTRACTS as Record<string, AnyCommandContract | undefined>)[
    args.command
  ]

  // FAIL CLOSED ON AN UNKNOWN COMMAND. The derived router cannot reach here with
  // one — the table IS its key set — but a refusal can be recorded before the
  // name is resolved, and "no contract found" must never be spelled the same way
  // as "the contract declared nothing sensitive".
  if (!contract) {
    port.repo.append(
      settingsAuditRow({
        command: args.command,
        outcome: args.outcome,
        principal: args.principal,
        report: { value: { input: redactUnknownForLog() }, redactedPaths: ['*'] },
        now: port.now(),
      }),
    )
    return
  }

  const report = redactReport(contract, 'input', args.input)
  const detail: Record<string, unknown> = { input: report.value }

  if (args.error !== undefined) {
    detail.error = messageMentionsRedactedValue(args.error, contract, 'input', args.input)
      ? REDACTED_MESSAGE
      : args.error
  }

  port.repo.append(
    settingsAuditRow({
      command: args.command,
      outcome: args.outcome,
      principal: args.principal,
      report: { value: detail, redactedPaths: report.redactedPaths },
      now: port.now(),
    }),
  )
}

/**
 * Redact an error before it leaves the server for a CLIENT.
 *
 * Same substring backstop as the trail, applied to the wire rather than to the
 * store. The two are separate calls on purpose: a message safe to persist in a
 * server-only table is not automatically safe to hand to a browser, and folding
 * them into one helper would make the weaker of the two answer for both.
 */
export function redactErrorMessage(command: string, input: unknown, message: string): string {
  const contract = (SETTINGS_CONTRACTS as Record<string, AnyCommandContract | undefined>)[command]
  if (!contract) return REDACTED_MESSAGE
  return messageMentionsRedactedValue(message, contract, 'input', input)
    ? REDACTED_MESSAGE
    : message
}
