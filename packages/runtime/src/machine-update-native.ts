import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateGrantMessage } from '@podium/protocol'
import type { MachineUpdateAdapter, PreparedUpdate } from './machine-update'

export interface NativeUpdateCommand {
  id: string
  kind: 'prepare' | 'activate' | 'restart'
  grant: UpdateGrantMessage
}
/** The shell is an installer primitive. Only the supervisor advances durable phases. */
export class NativeMachineUpdateAdapter implements MachineUpdateAdapter {
  private progressReport: ((percent?: number) => void) | undefined
  private command: NativeUpdateCommand | undefined
  private result: { resolve(): void; reject(error: Error): void } | undefined
  constructor(private readonly deps: { runtimeDir: string; version: string; digest?: string }) {}
  runningVersion(): string {
    return this.deps.version
  }
  runningDigest(): string | undefined {
    return this.deps.digest
  }
  next(): NativeUpdateCommand | undefined {
    return this.command
  }
  progress(id: string, percent?: number): boolean {
    if (this.command?.id !== id || this.command.kind !== 'prepare') return false
    if (percent !== undefined && (!Number.isInteger(percent) || percent < 0 || percent > 100))
      return false
    this.progressReport?.(percent)
    return true
  }
  finish(id: string, error?: string): boolean {
    if (this.command?.id !== id || !this.result) return false
    const result = this.result
    this.command = undefined
    this.result = undefined
    if (error) result.reject(new Error(error))
    else result.resolve()
    return true
  }
  private invoke(
    kind: NativeUpdateCommand['kind'],
    grant: UpdateGrantMessage,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.command) throw new Error('native installer already owns a command')
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const timeout = setTimeout(
        () => this.finish(id, 'Native installer did not answer within its execution budget.'),
        10 * 60_000,
      )
      const cancel = () => this.finish(id, 'Native update canceled before activation.')
      const clean = () => {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', cancel)
      }
      this.result = {
        resolve: () => {
          clean()
          resolve()
        },
        reject: (error) => {
          clean()
          reject(error)
        },
      }
      this.command = { id, kind, grant }
      signal?.addEventListener('abort', cancel, { once: true })
    })
  }
  artifactPath(): string {
    return join(this.deps.runtimeDir, 'native-update-artifact')
  }
  async prepare(
    grant: UpdateGrantMessage,
    signal: AbortSignal,
    progress?: (percent?: number) => void,
  ): Promise<PreparedUpdate> {
    if (!grant.target.artifacts.desktop)
      throw new Error('This native installation requires an authorized desktop artifact.')
    this.progressReport = progress
    try {
      await this.invoke('prepare', grant, signal)
    } finally {
      this.progressReport = undefined
    }
    signal.throwIfAborted()
    // The native plugin verifies its pinned minisign signature before returning bytes.
    const digest = `sha256-${createHash('sha256').update(readFileSync(this.artifactPath())).digest('base64')}`
    return { digest }
  }
  async activate(grant: UpdateGrantMessage, prepared: PreparedUpdate): Promise<void> {
    const digest = `sha256-${createHash('sha256').update(readFileSync(this.artifactPath())).digest('base64')}`
    if (digest !== prepared.digest)
      throw new Error('Native staged artifact changed before activation.')
    await this.invoke('activate', grant)
  }
  async restart(grant: UpdateGrantMessage): Promise<void> {
    await this.invoke('restart', grant)
  }
  async discard(): Promise<void> {
    if (existsSync(this.artifactPath())) rmSync(this.artifactPath())
  }
}

/** External desktop payloads and the shell share one journal and one admission lock. */
export function withNativeMachineUpdates(
  payload: MachineUpdateAdapter,
  native: NativeMachineUpdateAdapter,
): MachineUpdateAdapter {
  let selected: MachineUpdateAdapter = payload
  return {
    select: (grant) => {
      selected = grant.target.native !== undefined ? native : payload
    },
    runningVersion: () => selected.runningVersion(),
    runningDigest: () => selected.runningDigest?.(),
    prepare: (grant, signal, progress) => selected.prepare(grant, signal, progress),
    activate: (grant, prepared) => selected.activate(grant, prepared),
    restart: (grant, prepared) => selected.restart(grant, prepared),
    discard: () => selected.discard(),
    recoverActivation: async (grant, prepared) => {
      await selected.recoverActivation?.(grant, prepared)
    },
  }
}
