import { closeSync, existsSync, fsyncSync, openSync } from 'node:fs'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function fsyncDirectory(path: string): void {
  const handle = openSync(path, 'r')
  try {
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
}

export class TransferLock {
  private handle: Awaited<ReturnType<typeof open>> | undefined

  constructor(
    readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async acquire(): Promise<void> {
    if (this.handle) throw new Error('server transfer lock is already held')
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    for (;;) {
      try {
        const handle = await open(this.path, 'wx', 0o600)
        try {
          await handle.writeFile(
            `${JSON.stringify({ pid: process.pid, acquiredAt: this.now().toISOString() })}\n`,
          )
          await handle.sync()
          fsyncDirectory(dirname(this.path))
          this.handle = handle
          return
        } catch (error) {
          await handle.close()
          await rm(this.path, { force: true })
          throw error
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        let owner: { pid?: unknown }
        try {
          owner = JSON.parse(await readFile(this.path, 'utf8')) as { pid?: unknown }
        } catch {
          throw new Error('another server transfer owns an unreadable lock')
        }
        if (typeof owner.pid !== 'number' || processIsAlive(owner.pid)) {
          throw new Error('another server transfer is active')
        }
        await rm(this.path, { force: true })
        fsyncDirectory(dirname(this.path))
      }
    }
  }

  async release(): Promise<void> {
    const handle = this.handle
    if (!handle) return
    this.handle = undefined
    await handle.close()
    if (existsSync(this.path)) {
      await rm(this.path, { force: true })
      fsyncDirectory(dirname(this.path))
    }
  }
}
