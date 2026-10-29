import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IssueTrpc } from '@podium/issue-client'
import { ARTIFACT_UPLOAD_CHUNK_BYTES, type ArtifactUploadPacket } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readArtifactSource } from './artifact-source'
import { runIssueCli } from './issue-cli'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), 'artifact-source-'))
  dirs.push(dir)
  return dir
}

describe('CLI artifact sources', () => {
  it('accepts piped content without creating an intermediate source file', async () => {
    const source = await readArtifactSource(
      '-',
      'findings.md',
      Readable.from([Buffer.from('# Findings')]),
    )
    const chunks: Uint8Array[] = []
    for await (const chunk of source.files[0]!.chunks()) chunks.push(chunk)
    expect(source).toMatchObject({ path: 'findings.md', entry: 'findings.md' })
    expect(Buffer.concat(chunks).toString()).toBe('# Findings')
    await expect(readArtifactSource('-', undefined, Readable.from([]))).rejects.toThrow('--name')
  })
  it('reads a file outside any worktree and sends bounded packets through the command table', async () => {
    const dir = await temp()
    const file = join(dir, 'shot.png')
    const bytes = Buffer.alloc(ARTIFACT_UPLOAD_CHUNK_BYTES * 3 + 3, 7)
    await writeFile(file, bytes)
    const mutate = vi.fn(async (_input: { upload: ArtifactUploadPacket }) => ({
      seq: 1,
      panel: { artifacts: [{ path: 'shot.png' }] },
    }))
    await runIssueCli(['artifact', '1', '--add', file, '--title', 'Screenshot'], {
      issues: { panelApply: { mutate } },
    } as unknown as IssueTrpc)
    const packets = mutate.mock.calls.map(([input]) => input.upload)
    expect(packets[0]).toMatchObject({
      action: 'begin',
      path: 'shot.png',
      title: 'Screenshot',
      files: [{ path: 'shot.png', size: bytes.length }],
    })
    expect(packets.at(-1)?.action).toBe('commit')
    expect(
      Buffer.concat(
        packets
          .filter((packet) => packet.action === 'chunk')
          .map((packet) => Buffer.from(packet.dataBase64, 'base64')),
      ),
    ).toEqual(bytes)
    for (const packet of packets)
      expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThan(1024 * 1024)
  })

  it('preserves bundle paths and refuses symlinks, including links outside the bundle', async () => {
    const dir = await temp()
    await mkdir(join(dir, 'assets'))
    await writeFile(join(dir, 'index.html'), '<img src="assets/a.png">')
    await writeFile(join(dir, 'assets', 'a.png'), 'png')
    const source = await readArtifactSource(dir, 'mockup')
    expect(source.path).toBe('mockup')
    expect(source.entry).toBe('index.html')
    expect(source.files.map((file) => file.path)).toEqual(['assets/a.png', 'index.html'])
    await symlink(join(dir, 'index.html'), join(dir, 'link.html'))
    await expect(readArtifactSource(dir)).rejects.toThrow('symbolic links')
  })

  it('detects a changed source and aborts the unpublished upload', async () => {
    const dir = await temp()
    const file = join(dir, 'report.md')
    await writeFile(file, 'old')
    const source = await readArtifactSource(file)
    await writeFile(file, 'changed')
    const { uploadArtifact } = await import('@podium/issue-client')
    const mutate = vi.fn(async (_input: { upload: ArtifactUploadPacket }) => ({}))
    await expect(
      uploadArtifact({ issues: { panelApply: { mutate } } } as unknown as IssueTrpc, '1', source),
    ).rejects.toThrow('changed')
    expect(mutate.mock.calls.map(([input]) => input.upload.action)).toEqual(['begin', 'abort'])
  })
})
