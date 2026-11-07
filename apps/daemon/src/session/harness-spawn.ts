/**
 * THE DAEMON'S HARNESS SPAWN SITES TAKE ONLY A BOUND COMMAND (POD-6536, design
 * docs/design/harness-access-contract.md §3.4).
 *
 * `DurableSpawnOptions` is the terminal layer's generic shape (any program,
 * any argv). The session layer narrows it here: a harness session's PTY, its
 * attach client and its engines spawn a `BoundCommand` — argv[0] is the
 * executable the session's harness context pinned — and the operator's shell
 * spawns a `ShellCommand`. A plain `{ cmd: 'codex', args }` does not compile
 * at any of them.
 */
import type { BoundCommand, ShellCommand } from '@podium/harness'
import type {
  DurableAttachment,
  DurableProcess,
  DurableSpawnOptions,
} from '@podium/process/durable'

/** A harness process's spawn: the generic options with a bound command. */
export type HarnessSpawnOptions = Omit<DurableSpawnOptions, 'cmd' | 'args'> & {
  command: BoundCommand
}

/** A session PTY's spawn: a harness bound to its context, or the shell. */
export type SessionSpawnOptions = Omit<DurableSpawnOptions, 'cmd' | 'args'> & {
  command: BoundCommand | ShellCommand
}

/** Flatten a bound spawn back to the terminal layer's shape. */
export function durableSpawnOptions(
  opts: HarnessSpawnOptions | SessionSpawnOptions,
): DurableSpawnOptions {
  const { command, ...rest } = opts
  return { ...rest, cmd: command.cmd, args: [...command.args] }
}

/** The session PTY spawn (terminal sessions, native login panes, the shell). */
export function spawnSessionProcess(
  durable: Pick<DurableProcess, 'spawn'>,
  opts: SessionSpawnOptions,
): Promise<DurableAttachment> {
  return durable.spawn(durableSpawnOptions(opts))
}
