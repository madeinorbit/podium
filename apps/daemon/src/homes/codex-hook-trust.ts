/**
 * CODEX HOOK TRUST FOR PODIUM HOMES, CACHED (credential management §10).
 *
 * In a home Podium created, Codex gets Podium's handlers and their trust as
 * launch flags. The trust is Codex's own hash for those exact flags, read
 * from a throwaway `codex app-server` (`probeCodexLaunchHookTrust`). Reading
 * it is not free: Codex 0.169 installs a copy of itself (about 400 MB) into
 * the home it runs in and leaves a daemon there. So the answer is read once
 * per Codex version and flag text, kept in memory and in a small file next
 * to the homes, and the throwaway home is stopped and deleted every time.
 *
 * Nothing secret is cached: hook keys and hashes of Podium's own handlers.
 */

import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { HarnessInstallation } from '@podium/harness'
import { createLogger } from '@podium/logger'

const log = createLogger('daemon:codex-hook-trust')

type Trust = Readonly<Record<string, string>>

export interface CodexHookTrustOptions {
  /** The homes directory; the cache file and the throwaway home live here. */
  root: string
  /** Read the hashes from a Codex running in `probeHome` with `flags`. */
  probe(input: {
    installation: HarnessInstallation
    flags: readonly string[]
    probeHome: string
  }): Promise<Record<string, string>>
  /** Stop whatever Codex left running from `probeHome` (with the
   *  installation the probe ran), then delete it. */
  cleanProbeHome(probeHome: string, installation: HarnessInstallation): Promise<void>
}

export class CodexHookTrust {
  private readonly memory = new Map<string, Trust>()
  private readonly inFlight = new Map<string, Promise<Trust | undefined>>()

  constructor(private readonly options: CodexHookTrustOptions) {}

  private get file(): string {
    return join(this.options.root, '.codex-hook-trust.json')
  }

  /** Codex's trust for `flags` on `installation`, or undefined if unreadable. */
  async trustFor(
    installation: HarnessInstallation,
    flags: readonly string[],
  ): Promise<Trust | undefined> {
    const key = createHash('sha256')
      .update([installation.version, ...flags].join('\0'))
      .digest('hex')
    const known = this.memory.get(key) ?? this.readFile()[key]
    if (known) {
      this.memory.set(key, known)
      return known
    }
    const running = this.inFlight.get(key)
    if (running) return await running
    const work = this.read(installation, flags, key).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, work)
    return await work
  }

  private async read(
    installation: HarnessInstallation,
    flags: readonly string[],
    key: string,
  ): Promise<Trust | undefined> {
    const probeHome = join(this.options.root, `.probe-codex-${key.slice(0, 12)}`)
    try {
      await mkdir(probeHome, { recursive: true, mode: 0o700 })
      await chmod(this.options.root, 0o700)
      const trust = await this.options.probe({ installation, flags, probeHome })
      if (Object.keys(trust).length === 0) {
        log.warn('codex listed none of Podium’s launch hooks; no trust to give', {
          version: installation.version,
        })
        return undefined
      }
      this.memory.set(key, trust)
      this.writeFile({ ...this.readFile(), [key]: trust })
      return trust
    } catch (err) {
      log.warn('could not read codex hook trust; sessions in Podium homes run poll-only', {
        err,
        version: installation.version,
      })
      return undefined
    } finally {
      await this.options.cleanProbeHome(probeHome, installation).catch((err: unknown) => {
        log.warn('could not clear the codex probe home', { err, probeHome })
        return rm(probeHome, { recursive: true, force: true })
      })
    }
  }

  private readFile(): Record<string, Trust> {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, Trust>) : {}
    } catch {
      return {}
    }
  }

  private writeFile(content: Record<string, Trust>): void {
    const temporary = `${this.file}.${process.pid}`
    writeFileSync(temporary, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.file)
  }
}
