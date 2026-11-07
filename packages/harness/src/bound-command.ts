/**
 * THE ONLY LAUNCHABLE HARNESS COMMAND (POD-6536, design
 * docs/design/harness-access-contract.md §3.4).
 *
 * Adapters declare argv WITHOUT a command: they say what to pass, never which
 * binary runs it. {@link harnessCommand} is the one constructor that pairs an
 * argv with an executable, and the executable it uses is the installation the
 * harness context pinned. The result is branded, and every harness spawn site
 * (the session PTY spawn, the engine owner's `startEngine`, buffered exec, the
 * attach client's `spawnClient`) accepts only a {@link BoundCommand}. A plain
 * `{ cmd: 'codex', args }` does not type-check there, so a path that forgets
 * the context cannot compile, let alone run the daemon's PATH lookup.
 *
 * The operator's shell is not a harness and keeps its own path:
 * {@link shellCommand} brands it separately, and only the PTY spawn takes
 * either kind.
 */
import type { HarnessContext } from './harness-context-types.js'

declare const boundCommandBrand: unique symbol
declare const shellCommandBrand: unique symbol

/** An argv the adapter declared: everything but the command. */
export interface HarnessArgv {
  readonly args: readonly string[]
}

/** An argv bound to the executable of one harness context. */
export type BoundCommand<I extends HarnessArgv = HarnessArgv> = Omit<I, 'cmd' | 'args'> & {
  readonly cmd: string
  readonly args: string[]
  readonly [boundCommandBrand]: true
}

/** The operator's shell: no harness, no context. */
export type ShellCommand<I extends HarnessArgv = HarnessArgv> = Omit<I, 'cmd' | 'args'> & {
  readonly cmd: string
  readonly args: string[]
  readonly [shellCommandBrand]: true
}

/**
 * Bind an adapter's argv to ONE harness context: argv[0] is the executable the
 * context's installation names. Nothing here asks the inventory again — a
 * session whose context was built before an inventory refresh launches the
 * installation it was built from — and nothing here resolves the path: if the
 * verified file disappeared, the spawn fails against this exact path instead of
 * silently selecting another installation.
 *
 * `env` on the invocation stays the adapter's OWN env (its wiring layer); the
 * child's whole environment is `harnessChildEnv`'s to build.
 */
export function harnessCommand<I extends HarnessArgv>(
  context: Pick<HarnessContext, 'installation'>,
  invocation: I,
): BoundCommand<I> {
  const { cmd: _ignored, ...rest } = invocation as I & { cmd?: unknown }
  return {
    ...rest,
    cmd: context.installation.executable,
    args: [...invocation.args],
  } as unknown as BoundCommand<I>
}

/**
 * The same bound command with more arguments after the declared ones (the
 * instrumentation's launch flags, an engine's listener flag). The executable
 * cannot change: it is still the context's.
 */
export function withTrailingArgs<C extends BoundCommand>(command: C, extra: readonly string[]): C {
  return { ...command, args: [...command.args, ...extra] }
}

/** {@link withTrailingArgs} with the argv replaced outright (the instrumented
 *  launch argv, which may insert flags before the declared positional args).
 *  The command, and so the brand, is unchanged; a shell stays a shell. */
export function withArgs<C extends BoundCommand | ShellCommand>(
  command: C,
  args: readonly string[],
): C {
  return { ...command, args: [...args] }
}

/**
 * Run a bound command through an absolute launcher (the headless turn's
 * `/bin/sh` wrapper). The launcher is an OS tool named by absolute path; the
 * harness executable is still the context's, now as the launcher's argument.
 */
export function throughLauncher<C extends BoundCommand>(
  command: C,
  launcher: { cmd: string; args: readonly string[] },
): C {
  if (!launcher.cmd.startsWith('/')) {
    throw new Error(`a harness launcher must be an absolute path, got ${launcher.cmd}`)
  }
  return { ...command, cmd: launcher.cmd, args: [...launcher.args, command.cmd, ...command.args] }
}

/**
 * The operator's shell. Not harness access: the shell is whatever the user's
 * own `SHELL` names, run in the command environment, and it is the one PTY
 * spawn that has no harness context.
 */
export function shellCommand<I extends HarnessArgv & { readonly cmd: string }>(
  invocation: I,
): ShellCommand<I> {
  return { ...invocation, args: [...invocation.args] } as unknown as ShellCommand<I>
}
