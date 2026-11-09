import { asIssueId, asMachineId, asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { CommandDeps } from './context'
import { createFilesCommands } from './files'

function fixture() {
  const read = vi.fn(async () => ({ content: 'read' }))
  const write = vi.fn(async () => ({ hash: 'written' }))
  const list = vi.fn(async () => [])
  const status = vi.fn(async () => 'status')
  const log = vi.fn(async () => 'log')
  const diff = vi.fn(async () => 'diff')
  const commitFiles = vi.fn(async () => 'commit files')
  const commitDiffFile = vi.fn(async () => 'commit diff')
  const api = {
    files: { read: { query: read }, write: { mutate: write }, list: { query: list } },
    git: {
      status: { query: status }, log: { query: log }, diffFile: { query: diff },
      commitFiles: { query: commitFiles }, commitDiffFile: { query: commitDiffFile },
    },
  } as unknown as PodiumClientApi
  return { commands: createFilesCommands({ api } as CommandDeps<PodiumClientApi>), read, write, list, status, log, diff, commitFiles, commitDiffFile }
}

describe('file commands retain their scoped request calls', () => {
  it('reads session, checkout and immutable artifact scopes without changing the payload', async () => {
    const f = fixture()
    const sessionId = asSessionId('s-file')
    const machineId = asMachineId('m-file')
    const issueId = asIssueId('i-file')
    await f.commands.read({ kind: 'session', sessionId }, 'a.txt')
    await f.commands.read({ kind: 'worktree', machineId, root: '/repo' }, 'b.txt')
    await f.commands.read({ kind: 'artifact', issueId, artifactId: 'artifact' as never }, 'c.txt')
    expect(f.read.mock.calls).toEqual([
      [{ sessionId, path: 'a.txt' }],
      [{ machineId, root: '/repo', path: 'b.txt' }],
      [{ issueId, artifactId: 'artifact', path: 'c.txt' }],
    ])
  })

  it('keeps the write base hash and rejects an artifact write before making a request', async () => {
    const f = fixture()
    const sessionId = asSessionId('s-file')
    await f.commands.write({ scope: { kind: 'session', sessionId }, path: 'a.txt', content: 'new', baseHash: 'old' })
    expect(f.write).toHaveBeenCalledExactlyOnceWith({ sessionId, path: 'a.txt', content: 'new', baseHash: 'old' })
    await expect(f.commands.write({ scope: { kind: 'artifact', issueId: asIssueId('i-file'), artifactId: 'a' as never }, path: 'a.txt', content: 'new' })).rejects.toThrow('artifact snapshots are read-only')
    expect(f.write).toHaveBeenCalledTimes(1)
  })

  it('keeps directory, status, log, working diff and existing commit inspection as queries', async () => {
    const f = fixture()
    const scope = { machineId: asMachineId('m-file'), root: '/repo' }
    await f.commands.list({ ...scope, path: 'src' })
    await f.commands.status(scope)
    await f.commands.log(scope)
    await f.commands.diff({ ...scope, path: 'a.txt' })
    await f.commands.commitFiles({ ...scope, sha: 'abc' })
    await f.commands.commitDiffFile({ ...scope, sha: 'abc', path: 'a.txt' })
    expect(f.list).toHaveBeenCalledExactlyOnceWith({ ...scope, path: 'src' })
    expect(f.status).toHaveBeenCalledExactlyOnceWith(scope)
    expect(f.log).toHaveBeenCalledExactlyOnceWith(scope)
    expect(f.diff).toHaveBeenCalledExactlyOnceWith({ ...scope, path: 'a.txt' })
    expect(f.commitFiles).toHaveBeenCalledExactlyOnceWith({ ...scope, sha: 'abc' })
    expect(f.commitDiffFile).toHaveBeenCalledExactlyOnceWith({ ...scope, sha: 'abc', path: 'a.txt' })
  })
})
