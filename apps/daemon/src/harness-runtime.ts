import {
  agentLaunchCommand,
  buildResolvedInventory,
  type HarnessContext,
  type LaunchOptions,
  type LaunchSpec,
  type LoginProbeExec,
  type ProbeExec,
  type ResolvedHarnessInventory,
} from '@podium/harness'
import { createCommandEnvironment } from '@podium/runtime/command-environment'

export interface HarnessRuntimeOptions {
  machineHome?: string
  credentialHome?: string
  env?: NodeJS.ProcessEnv
  exec?: ProbeExec
  loginExec?: LoginProbeExec
  launch?: typeof agentLaunchCommand
  /** Hermetic generation builder used by lifecycle tests. */
  buildSnapshot?: (generation: number) => Promise<ResolvedHarnessInventory>
}

/** Owns the immutable command/inventory snapshot used by a daemon generation. [spec:SP-58fa] */
export class DaemonHarnessRuntime {
  private generation = 0
  private revision = 0
  private authoritative: Promise<ResolvedHarnessInventory>
  private authoritativeValue: ResolvedHarnessInventory | undefined
  private authoritativePending = false

  constructor(private readonly options: HarnessRuntimeOptions = {}) {
    this.authoritative = this.install(this.build(this.generation), this.revision)
  }

  current(): Promise<ResolvedHarnessInventory> {
    return this.authoritative
  }

  /**
   * The last snapshot a wave installed, without waiting for one in flight
   * (POD-6534). A reprobe holds `current()` open for a whole version/login
   * wave; latency-sensitive account reads (transcripts) take the settled
   * command environment instead. `undefined` before the first wave settles.
   */
  settled(): ResolvedHarnessInventory | undefined {
    return this.authoritativeValue
  }

  refresh(): Promise<ResolvedHarnessInventory> {
    this.generation += 1
    this.revision += 1
    this.authoritative = this.install(this.build(this.generation), this.revision)
    return this.authoritative
  }

  /** Re-run version/login probes without starting another login shell. */
  reprobe(): Promise<ResolvedHarnessInventory> {
    // Inventory is one Promise.all wave across every harness. A slow unrelated
    // CLI can therefore keep the wave open until the next periodic/server
    // request arrives. Superseding it here made reportInventory discard every
    // completed wave as non-current, so the server retained its persisted old
    // answer indefinitely. Join the live wave; the next tick can start a fresh
    // one after this observation has had a chance to publish.
    if (this.authoritativePending) return this.authoritative
    this.revision += 1
    const revision = this.revision
    const previous = this.authoritative
    const next = previous.then((snapshot) =>
      buildResolvedInventory({
        commandEnvironment: snapshot.commandEnvironment,
        ...(this.options.loginExec ? { loginExec: this.options.loginExec } : {}),
        ...(this.options.machineHome ? { machineHome: this.options.machineHome } : {}),
        ...(this.options.credentialHome ? { credentialHome: this.options.credentialHome } : {}),
        ...(this.options.exec ? { exec: this.options.exec } : {}),
      }),
    )
    this.authoritative = this.install(next, revision)
    return this.authoritative
  }

  isCurrent(snapshot: ResolvedHarnessInventory): boolean {
    return this.authoritativeValue === snapshot
  }

  /**
   * The launch spec for one session. A harness session launches from ITS
   * context (POD-6533): the installation and account environment pinned when
   * the session was spawned, never the inventory as it stands now, so a
   * refresh between spawn and launch cannot move the session to another
   * executable. A plain shell has no harness and runs in the current command
   * environment.
   */
  async launch(
    target: HarnessContext | 'shell',
    options: Omit<LaunchOptions, 'harnessContext'>,
  ): Promise<LaunchSpec> {
    const build = this.options.launch ?? agentLaunchCommand
    if (target === 'shell') {
      const invocation = build('shell', options)
      const snapshot = await this.current()
      return {
        ...invocation,
        env: { ...snapshot.commandEnvironment.env, ...invocation.env },
      }
    }
    return build(target.installation.kind, { ...options, harnessContext: target })
  }

  private install(
    pending: Promise<ResolvedHarnessInventory>,
    revision: number,
  ): Promise<ResolvedHarnessInventory> {
    this.authoritativePending = true
    const installed = pending.then((snapshot) => {
      if (this.revision === revision) this.authoritativeValue = snapshot
      return snapshot
    })
    const tracked = installed.finally(() => {
      if (this.authoritative === tracked) this.authoritativePending = false
    })
    return tracked
  }

  private async build(generation: number): Promise<ResolvedHarnessInventory> {
    if (this.options.buildSnapshot) return this.options.buildSnapshot(generation)
    const commandEnvironment = await createCommandEnvironment({
      ...(this.options.machineHome ? { machineHome: this.options.machineHome } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
      generation,
    })
    return buildResolvedInventory({
      commandEnvironment,
      ...(this.options.machineHome ? { machineHome: this.options.machineHome } : {}),
      ...(this.options.credentialHome ? { credentialHome: this.options.credentialHome } : {}),
      ...(this.options.exec ? { exec: this.options.exec } : {}),
      ...(this.options.loginExec ? { loginExec: this.options.loginExec } : {}),
    })
  }
}
