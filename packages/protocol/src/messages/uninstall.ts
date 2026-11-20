/**
 * UNINSTALLING PODIUM FROM A MACHINE (managed installs, section 12 item 14).
 *
 * `podium uninstall` on the machine, and "Uninstall Podium" in the machine
 * menu, do the same thing: stop Podium's services, undo the edits Podium made
 * in the person's harness folders, remove Podium's service units, and remove
 * Podium's own files. The person's own harness installs and folders are never
 * removed.
 *
 * The menu asks the machine's daemon with {@link MachineUninstallRequestMessage}.
 * The daemon undoes the home edits, answers with each edit's outcome, and then
 * starts `podium uninstall` outside its own service, which stops the services
 * (the daemon with them) and removes the rest. The server removes the machine
 * once the daemon has answered.
 */

import { z } from 'zod'

/** A daemon that offers this answers `machineUninstallRequest`. An older
 *  daemon is not asked; the person runs `podium uninstall` there instead. */
export const CAP_MACHINE_UNINSTALL = 'machine.uninstall.v1'

/**
 * What became of one edit Podium made in a harness folder:
 * - `restored`: the prior value is back (or the file Podium owned is gone);
 * - `changed`: the file changed since Podium's edit, so it was left alone;
 * - `failed`: the undo could not be done (`reason` says why).
 */
export const UninstallEditStatus = z.enum(['restored', 'changed', 'failed'])
export type UninstallEditStatus = z.infer<typeof UninstallEditStatus>

export const UninstallEditOutcome = z.object({
  harness: z.string(),
  /** The file Podium had edited. */
  file: z.string(),
  status: UninstallEditStatus,
  reason: z.string().optional(),
})
export type UninstallEditOutcome = z.infer<typeof UninstallEditOutcome>

/** True when nothing stands in the way of removing Podium's state folder. */
export function everyEditRestored(outcomes: readonly UninstallEditOutcome[]): boolean {
  return outcomes.every((outcome) => outcome.status === 'restored')
}

/**
 * Server → daemon: uninstall Podium from this machine. With `force`, Podium's
 * state folder is removed even when an edit could not be undone.
 */
export const MachineUninstallRequestMessage = z.object({
  type: z.literal('machineUninstallRequest'),
  requestId: z.string(),
  force: z.boolean().optional(),
})
export type MachineUninstallRequestMessage = z.infer<typeof MachineUninstallRequestMessage>

/**
 * `ok` once the edits were undone and the removal was started; `outcomes` is
 * each edit's result. Not `ok` with `error` when the machine refused (it hosts
 * the server, or the desktop app supervises it) or the removal could not start.
 */
export const MachineUninstallResultMessage = z.object({
  type: z.literal('machineUninstallResult'),
  requestId: z.string(),
  ok: z.boolean(),
  outcomes: z.array(UninstallEditOutcome).optional(),
  /** False when an edit was not restored and `force` was not given: the
   *  services are removed but Podium's state folder stays on the machine. */
  removesState: z.boolean().optional(),
  error: z.string().optional(),
})
export type MachineUninstallResultMessage = z.infer<typeof MachineUninstallResultMessage>
