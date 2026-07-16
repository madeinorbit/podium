import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { link, readdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { DaemonMessage, ResumeRef } from '@podium/protocol'

const RECEIPT_NAME = /^([\w.-]+)\.json$/
const CLAIM_NAME = /^([\w.-]+?)\.json\.\d+\.[0-9a-f-]+\.ack$/

export interface CodexIdentityBinding {
  sessionId: string
  nativeId: string
}

/** One hook payload retained for a stable Podium pane until the server acks it. */
export class CodexIdentityReceipts {
  constructor(readonly dir: string) {}

  pathFor(sessionId: string): string | undefined {
    return /^[\w.-]+$/.test(sessionId) ? join(this.dir, `${sessionId}.json`) : undefined
  }

  private async read(path: string, sessionId: string): Promise<CodexIdentityBinding | undefined> {
    try {
      const payload = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      const nativeId = payload.session_id
      if (typeof nativeId !== 'string' || nativeId.length === 0) return undefined
      return { sessionId, nativeId }
    } catch {
      return undefined
    }
  }

  private async restoreClaim(claim: string, path: string): Promise<void> {
    // link() restores only when path is absent. If a newer hook already created
    // path, EEXIST proves the old claimed version is safe to discard.
    let canDropClaim = false
    try {
      await link(claim, path)
      canDropClaim = true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') canDropClaim = true
      else throw err
    } finally {
      if (canDropClaim) await rm(claim, { force: true })
    }
  }

  async pending(): Promise<CodexIdentityBinding[]> {
    let entries: Dirent<string>[]
    try {
      entries = await readdir(this.dir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    // Recover a daemon crash between acknowledge()'s atomic claim and its
    // compare/delete step. The regular receipt may be absent or a newer hook may
    // already have replaced it; restoreClaim handles both without overwriting.
    let recoveredClaim = false
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const match = CLAIM_NAME.exec(entry.name)
      if (!match) continue
      const path = this.pathFor(match[1] as string)
      if (!path) continue
      await this.restoreClaim(join(this.dir, entry.name), path)
      recoveredClaim = true
    }
    if (recoveredClaim) entries = await readdir(this.dir, { withFileTypes: true })

    const bindings: CodexIdentityBinding[] = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile()) continue
      const match = RECEIPT_NAME.exec(entry.name)
      if (!match) continue
      const binding = await this.read(join(this.dir, entry.name), match[1] as string)
      if (binding) bindings.push(binding)
    }
    return bindings
  }

  /**
   * Replay is at-least-once. The server persists idempotently and responds with
   * sessionResumeRefAck; only that acknowledgement removes the receipt.
   */
  async replay(send: (msg: DaemonMessage) => void): Promise<number> {
    const bindings = await this.pending()
    for (const binding of bindings) {
      send({
        type: 'sessionResumeRef',
        sessionId: binding.sessionId,
        resume: { kind: 'codex-thread', value: binding.nativeId },
        confidence: 'exact',
        ackRequested: true,
      })
    }
    return bindings.length
  }

  /**
   * Delete only if the acknowledgement still names the payload currently on
   * disk. A newer hook may have replaced the file while an older ack was in
   * flight; that newer native id must remain pending.
   */
  async acknowledge(sessionId: string, resume: ResumeRef): Promise<boolean> {
    if (resume.kind !== 'codex-thread') return false
    const path = this.pathFor(sessionId)
    if (!path) return false
    const claim = `${path}.${process.pid}.${randomUUID()}.ack`
    try {
      // Claim exactly the version being acknowledged. A hook arriving after
      // this rename creates a fresh path that this acknowledgement never sees.
      await rename(path, claim)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }

    const current = await this.read(claim, sessionId)
    if (current?.nativeId === resume.value) {
      await rm(claim, { force: true })
      return true
    }

    // The ack was stale. Restore the claimed version only if no newer hook has
    // already recreated path. link() is an atomic create-if-absent operation;
    // unlike rename(), it can never overwrite that newer receipt.
    await this.restoreClaim(claim, path)
    return false
  }
}
