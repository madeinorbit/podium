/**
 * WHY THIS SERVER HAS NO UPDATE PARTICIPANT OF ITS OWN (POD-3759).
 *
 * Declining the participant is not only "no updates here": the participant is
 * what reports this machine's build and what makes it count as `online`, so the
 * line this produces is the only explanation anybody gets from the fleet table.
 *
 * It has to name the reason that ACTUALLY fired. The chain used to fall through
 * to "no supervising parent is discoverable" for a supervisor-owned coordinator
 * — a documented, healthy shape reported as a mystery, which is what cost the
 * investigation time on ludovico.
 */
export interface UpdateParticipantSkip {
  /** Human reason, the tail of the log line. */
  why: string
  /** `info` for declared shapes, `debug` for source checkouts, `warn` otherwise. */
  level: 'info' | 'debug' | 'warn'
}

export interface UpdateParticipantSkipInputs {
  /** This deployment has DECLARED it owns the server binary (updateScope=fleet-only). */
  fleetOnly: boolean
  /** `PODIUM_MACHINE_UPDATE_OWNER === 'supervisor'`: the daemon applies our grants. */
  supervisorOwnsUpdates: boolean
  runningFromSource: boolean
  recoveryOnly: boolean
  /** `PODIUM_E2E_DISABLE_LOCAL_UPDATE_PARTICIPANT === '1'`. */
  participantDisabledForRun: boolean
}

/**
 * Ordered by which condition actually suppressed the participant, declared
 * shapes first. The final arm is the genuinely unknown case and stays a warning.
 */
export function updateParticipantSkip(inputs: UpdateParticipantSkipInputs): UpdateParticipantSkip {
  if (inputs.fleetOnly)
    return { why: 'this deployment owns the server binary (updateScope=fleet-only)', level: 'info' }
  if (inputs.supervisorOwnsUpdates)
    return {
      why: 'the supervising daemon owns updates for this machine (PODIUM_MACHINE_UPDATE_OWNER=supervisor)',
      level: 'info',
    }
  if (inputs.runningFromSource) return { why: 'this coordinator runs from source', level: 'debug' }
  if (inputs.recoveryOnly)
    return { why: 'the coordinator is fenced in recovery-only mode', level: 'warn' }
  if (inputs.participantDisabledForRun)
    return { why: 'the local participant is disabled for this run', level: 'warn' }
  return { why: 'no supervising parent is discoverable in the run registry', level: 'warn' }
}

export function updateParticipantSkipNote(why: string): string {
  return `this machine will not report its build or appear online in its own fleet: ${why}`
}
