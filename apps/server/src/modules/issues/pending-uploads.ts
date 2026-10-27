import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { ArtifactId, IssueId, UserId } from '@podium/model'
import type { PortableStateWriteFence } from '../server-transfer/portable-fence'

/**
 * FILES PICKED IN A CHAT OR NEW-TASK COMPOSER, HELD ON THE SERVER UNTIL THE
 * MESSAGE THAT CARRIES THEM IS SENT (POD-2148).
 *
 * Picking a file stores it here, owned by the person who picked it, and answers
 * a small ref (`id`, name, type). Nothing touches the agent's machine yet, so a
 * file can be attached for a hibernated agent, or before the new task's session
 * and issue exist. Sending the message (or creating the task) CLAIMS the upload:
 * its bytes are renamed into the issue's artifact store, and the server stages
 * them on the agent's machine when the message is delivered.
 *
 * Layout: `<base>/<id>/meta.json` and `<base>/<id>/file/<entry>`. A claim
 * records the issue in the meta before it moves the file, so a claim retried
 * after a crash finishes the same move and a different issue is refused. An
 * upload nobody claimed, and a claimed one's leftover meta, go after a day.
 */

export const PENDING_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const PENDING_UPLOAD_SWEEP_MS = 60 * 60 * 1000

/** Upload ids name directories here and staged files on the agent's machine,
 *  which accepts only UUIDs, so nothing else is ever looked up. */
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isPendingUploadId(id: string): boolean {
  return UPLOAD_ID.test(id)
}

export interface PendingUploadMeta {
  id: string
  ownerUserId: UserId
  /** The name the person's file had. */
  filename: string
  /** The stored file's name: `filename` when that is a plain name. */
  entry: string
  mediaType: string
  size: number
  createdAt: number
  /** Set by the first claim, before the file moves. */
  claimed?: { issueId: IssueId; artifactId: ArtifactId }
}

function plainFilename(name: string): string {
  return name &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
    ? name
    : 'attachment'
}

export class PendingUploadStore {
  constructor(
    private readonly baseDir: string,
    private readonly writeFence?: PortableStateWriteFence,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private dir(id: string): string {
    if (!isPendingUploadId(id)) throw new Error('bad upload id')
    return join(this.baseDir, id)
  }

  /** Where a claim moves the file from: the dir holding only the file. */
  fileDir(id: string): string {
    return join(this.dir(id), 'file')
  }

  private async write<T>(writer: () => Promise<T>): Promise<T> {
    return this.writeFence ? await this.writeFence.runWriter(writer) : await writer()
  }

  async put(input: {
    ownerUserId: UserId
    filename: string
    mediaType: string
    bytes: Uint8Array
  }): Promise<PendingUploadMeta> {
    const meta: PendingUploadMeta = {
      id: randomUUID(),
      ownerUserId: input.ownerUserId,
      filename: input.filename,
      entry: plainFilename(input.filename.split(/[/\\]/).filter(Boolean).pop() ?? ''),
      mediaType: input.mediaType,
      size: input.bytes.length,
      createdAt: this.now(),
    }
    const dir = this.dir(meta.id)
    const target = join(this.fileDir(meta.id), meta.entry)
    if (!resolve(target).startsWith(resolve(this.baseDir) + sep))
      throw new Error('path escapes store')
    await this.write(async () => {
      try {
        await mkdir(this.fileDir(meta.id), { recursive: true })
        const fh = await open(target, 'w')
        try {
          await fh.writeFile(input.bytes)
          await fh.sync()
        } finally {
          await fh.close()
        }
        await this.writeMeta(meta)
      } catch (error) {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
        throw error
      }
    })
    return meta
  }

  async meta(id: string): Promise<PendingUploadMeta | undefined> {
    if (!isPendingUploadId(id)) return undefined
    try {
      return JSON.parse(
        await readFile(join(this.dir(id), 'meta.json'), 'utf8'),
      ) as PendingUploadMeta
    } catch {
      return undefined
    }
  }

  /** Record the claim before the file moves (see the class note). */
  async markClaimed(id: string, claimed: NonNullable<PendingUploadMeta['claimed']>): Promise<void> {
    const meta = await this.meta(id)
    if (!meta) throw new Error(`no pending upload ${id}`)
    await this.write(async () => await this.writeMeta({ ...meta, claimed }))
  }

  /** Forget a claim whose file was moved back (a task that failed to launch). */
  async markUnclaimed(id: string): Promise<void> {
    const meta = await this.meta(id)
    if (!meta?.claimed) return
    const { claimed: _claimed, ...rest } = meta
    await this.write(async () => await this.writeMeta(rest))
  }

  /** Drop an upload the composer no longer carries. A claimed one stays: its
   *  meta is what refuses a second issue. */
  async discard(id: string, ownerUserId: UserId): Promise<boolean> {
    const meta = await this.meta(id)
    if (!meta || meta.ownerUserId !== ownerUserId || meta.claimed) return false
    await this.write(async () => await rm(this.dir(id), { recursive: true, force: true }))
    return true
  }

  /** Delete everything older than `maxAgeMs`. A server-transfer fence skips the
   *  pass rather than failing it: the next one picks up the rest. */
  async sweep(maxAgeMs = PENDING_UPLOAD_MAX_AGE_MS): Promise<number> {
    let names: string[]
    try {
      names = await readdir(this.baseDir)
    } catch {
      return 0
    }
    const cutoff = this.now() - maxAgeMs
    let removed = 0
    for (const name of names) {
      if (!isPendingUploadId(name)) continue
      const meta = await this.meta(name)
      const createdAt =
        meta?.createdAt ?? (await stat(join(this.baseDir, name)).catch(() => undefined))?.mtimeMs
      if (createdAt === undefined || createdAt > cutoff) continue
      try {
        await this.write(async () => await rm(this.dir(name), { recursive: true, force: true }))
        removed += 1
      } catch {
        return removed
      }
    }
    return removed
  }

  private async writeMeta(meta: PendingUploadMeta): Promise<void> {
    const path = join(this.dir(meta.id), 'meta.json')
    const tmp = `${path}.${randomUUID()}.tmp`
    const fh = await open(tmp, 'w')
    try {
      await fh.writeFile(JSON.stringify(meta))
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, path)
  }
}
