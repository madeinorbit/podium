import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const preflight = fileURLToPath(new URL('./preflight.ts', import.meta.url))

const writeCommand = (dir: string, name: string, body: string): void => {
  const windows = process.platform === 'win32'
  const path = join(dir, windows ? `${name}.cmd` : name)
  writeFileSync(path, windows ? `@echo off\r\n${body}\r\n` : `#!/bin/sh\n${body}\n`)
  if (!windows) chmodSync(path, 0o755)
}

const runPreflightWithNode = (version: string) => {
  const binDir = mkdtempSync(join(tmpdir(), 'podium-preflight-node-'))
  try {
    writeCommand(binDir, 'node', `echo ${version}`)
    for (const command of ['cargo', 'cc', 'pkg-config']) writeCommand(binDir, command, 'exit 0')

    return spawnSync(process.execPath, [preflight], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
    })
  } finally {
    rmSync(binDir, { recursive: true, force: true })
  }
}

describe('desktop Node prerequisite', () => {
  it.each([
    'v18.19.1',
    'v20.18.1',
    'v21.7.3',
    'v22.11.0',
  ])('rejects unsupported Node version %s before Vite runs', (version) => {
    const result = runPreflightWithNode(version)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      `Node.js ${version} cannot run Vite (needs ^20.19.0 || >=22.12.0).`,
    )
    expect(result.stderr).toContain('sudo pacman -S nodejs')
  })

  it.each(['v20.19.0', 'v22.12.0', 'v24.1.0'])('accepts supported Node version %s', (version) => {
    const result = runPreflightWithNode(version)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('[preflight] ✅ toolchain looks good')
    expect(result.stderr).not.toContain('Node.js')
  })

  it.each([
    'v22.12.0-rc.1',
    'unknown',
  ])('rejects a version Vite cannot prove compatible: %s', (version) => {
    expect(runPreflightWithNode(version).status).toBe(1)
  })
})
