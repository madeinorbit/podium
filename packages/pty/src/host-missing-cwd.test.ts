import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execCreate = vi.fn<(file: string, args: string[], options: unknown) => Promise<void>>()

vi.mock('./host-bin.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./host-bin.js')>()),
  resolveHostBin: () => '/opt/podium/podium-host',
}))
vi.mock('./scope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./scope.js')>()),
  canScopeMaster: () => Promise.resolve(true),
  execCreate: (file: string, args: string[], options: unknown) => execCreate(file, args, options),
  // No real systemctl from a unit test.
  scopeReclaimArgvs: () => [],
}))

const { spawnHostAgent } = await import('./host.js')

/**
 * POD-6942: posix_spawn with a missing cwd fails ENOENT naming the executable,
 * so a session whose folder was deleted reported a missing podium-host (and a
 * systemd scope warning naming systemd-run). The launch names the directory and
 * tries no create at all.
 */
describe('spawnHostAgent with a missing working directory', () => {
  let root = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'phc-'))
    execCreate.mockReset()
    execCreate.mockRejectedValue(new Error('create attempted'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const spawn = (cwd: string) =>
    spawnHostAgent({
      label: 'podium-missing-cwd',
      cmd: '/bin/true',
      cwd,
      cols: 80,
      rows: 24,
      env: { PODIUM_HOST_SOCKET_DIR: join(root, 'hosts') },
    })

  it('names the directory and tries neither the scope nor the plain create', async () => {
    const gone = join(root, 'deleted-worktree')
    await expect(spawn(gone)).rejects.toThrow(`working directory does not exist: ${gone}`)
    expect(execCreate).not.toHaveBeenCalled()
  })

  it('refuses a cwd that is a file, not a directory', async () => {
    const plain = join(root, 'plain')
    writeFileSync(plain, '')
    await expect(spawn(plain)).rejects.toThrow(`working directory does not exist: ${plain}`)
    expect(execCreate).not.toHaveBeenCalled()
  })

  it('launches an existing directory as before: the scope first, then the plain create', async () => {
    await expect(spawn(root)).rejects.toThrow('create attempted')
    expect(execCreate.mock.calls.map(([file]) => file)).toEqual([
      'systemd-run',
      '/opt/podium/podium-host',
    ])
    expect(execCreate.mock.calls[1]?.[2]).toMatchObject({ cwd: root })
  })
})
