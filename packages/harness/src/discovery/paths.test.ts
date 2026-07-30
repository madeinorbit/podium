import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { canonicalPath, expandHome, isDirectory, listFilesRecursive, pathExists } from './paths.js'

describe('expandHome', () => {
  test('expands tilde against the supplied home directory', () => {
    expect(expandHome('~/.codex', '/home/tester')).toBe('/home/tester/.codex')
    expect(expandHome('~', '/home/tester')).toBe('/home/tester')
    expect(expandHome('/var/data', '/home/tester')).toBe('/var/data')
  })
})

describe('pathExists and isDirectory', () => {
  test('return false for missing paths', async () => {
    expect(await pathExists('/definitely/not/here')).toBe(false)
    expect(await isDirectory('/definitely/not/here')).toBe(false)
  })

  test('return false when an intermediate path segment is a file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'podium-paths-'))
    const file = join(root, 'file')
    const child = join(file, 'child')
    await writeFile(file, '{}\n')

    expect(await pathExists(child)).toBe(false)
    expect(await isDirectory(child)).toBe(false)
  })
})

describe('canonicalPath', () => {
  test('resolves symlinks when possible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'podium-paths-'))
    const target = join(root, 'target.jsonl')
    const link = join(root, 'link.jsonl')
    await writeFile(target, '{}\n')
    await symlink(target, link)

    expect(await canonicalPath(link)).toBe(await realpath(target))
  })

  test('falls back to the absolute path when an intermediate path segment is a file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'podium-paths-'))
    const file = join(root, 'file')
    const child = join(file, 'child')
    await writeFile(file, '{}\n')

    await expect(canonicalPath(child)).resolves.toBe(child)
  })
})

describe('listFilesRecursive', () => {
  test('lists accepted files in deterministic order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'podium-list-'))
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(join(root, 'b.jsonl'), '{}\n')
    await writeFile(join(root, 'B.jsonl'), '{}\n')
    await writeFile(join(root, 'a.txt'), 'ignore')
    await writeFile(join(root, 'nested', 'a.jsonl'), '{}\n')

    await expect(listFilesRecursive(root, (file) => file.endsWith('.jsonl'))).resolves.toEqual([
      join(root, 'B.jsonl'),
      join(root, 'b.jsonl'),
      join(root, 'nested', 'a.jsonl'),
    ])
  })
})
