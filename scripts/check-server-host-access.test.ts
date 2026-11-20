import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkServerHostAccess,
  checkServerHostSources,
  probeServerHostAccess,
  scanServerHostAccess,
} from './check-server-host-access'

const file = 'modules/example/service.ts'

describe('server host-access fence', () => {
  it('proves each required refusal independently', () => {
    expect(probeServerHostAccess()).toEqual([])
  })

  it.each([
    "import fs from 'node:fs'",
    "export { readFile } from 'node:fs/promises'",
    "const child = require('node:child_process')",
    "const fs = await import('fs/promises')",
    "import fs = require('node:fs')",
    "import { homedir as home } from 'node:os'",
    "import * as os from 'node:os'; os.hostname()",
    "import os from 'os'; const system = os; system['tmpdir']()",
    "const { homedir: home } = await import('node:os')",
    "(await import('node:os')).hostname()",
    "Bun.file('file')",
    "Bun.write('file', 'data')",
    "Bun.spawn(['git', 'status'])",
    "Bun['spawnSync'](['git', 'status'])",
    'Bun.$`git status`',
    'const spawn = Bun.spawn',
  ])('rejects local APIs: %s', (source) => {
    const findings = scanServerHostAccess(file, source)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ rule: 'local-machine', file, line: 1 })
  })

  it.each([
    'const target = store.hostMachineId',
    "const target = store['hostMachineId']",
    'const target = store.hostMachine?.id',
    'const { hostMachine: machine } = store',
    'const { hostMachineId } = store',
    'function target({ hostMachine: machine }) { return machine }',
    'send(hostMachine)',
    'send({ hostMachineId })',
    'hostMachineId ??= record.machineId',
  ])('rejects host-machine reads: %s', (source) => {
    expect(scanServerHostAccess(file, source)).toEqual([
      { rule: 'host-machine', file, line: 1, access: expect.stringMatching(/^hostMachine(Id)?$/) },
    ])
  })

  it('ignores comments, strings, declarations, type queries and unrelated OS APIs', () => {
    expect(
      scanServerHostAccess(
        file,
        `
      // import fs from 'node:fs'; store.hostMachine; Bun.spawn(['git'])
      const example = "store.hostMachineId, Bun.file('example')"
      interface Deps { hostMachineId: string }
      type Host = typeof hostMachine
      const hostMachineId = record.machineId
      function configure(hostMachine: Host) {}
      class Store { hostMachine: Host = null }
      const fields = { hostMachine: null }
      store.hostMachine = null
      import { platform } from 'node:os'
      import os from 'node:os'
      os.arch()
    `,
      ),
    ).toEqual([])
  })

  it('keeps disk and host-identity exceptions independent and matches directory boundaries', () => {
    const local = [{ path: 'modules/example/', reason: 'Builds the server installation.' }]
    const source = "import fs from 'node:fs'; const id = store.hostMachineId"
    const errors = checkServerHostSources([{ file, source }], local, [])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('[host-machine]')
    expect(
      checkServerHostSources([{ file, source }], local, [
        { path: file, reason: 'Composes the installation identity.' },
      ]),
    ).toEqual([])
    expect(
      checkServerHostSources(
        [{ file: 'modules/example-other/service.ts', source: "import fs from 'node:fs'" }],
        local,
        [],
      ),
    ).toEqual([expect.stringContaining('[local-machine]'), expect.stringContaining('unused entry')])
  })

  it('rejects exceptions for missing files, removed accesses and excluded test files', () => {
    for (const path of ['missing.ts', file, 'example.test.ts']) {
      expect(
        checkServerHostSources(
          [
            { file, source: 'export const safe = true' },
            { file: 'example.test.ts', source: "import fs from 'node:fs'" },
          ],
          [{ path, reason: 'Must actually use the exception.' }],
          [],
        ),
      ).toEqual([expect.stringContaining(`unused entry ${path}`)])
    }
  })

  it('requires one-line reasons on both allowlists', () => {
    expect(
      checkServerHostSources(
        [{ file, source: "import fs from 'node:fs'; store.hostMachine" }],
        [{ path: file, reason: ' ' }],
        [{ path: file, reason: 'two\nlines' }],
      ),
    ).toEqual([
      expect.stringContaining('local-machine allowlist:'),
      expect.stringContaining('host-machine allowlist:'),
    ])
  })

  it('walks the server tree while excluding only tests and the named support directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-host-access-'))
    try {
      for (const path of [
        file,
        'modules/nested/worker.tsx',
        'example.test.ts',
        'example.bench.ts',
        'test-support/fixture.ts',
        'modules/example/testing/fixture.ts',
        'store/spike/probe.ts',
      ]) {
        const target = join(root, 'apps/server/src', path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, "import fs from 'node:fs'")
      }
      expect(checkServerHostAccess(root, [], []).sort()).toEqual([
        expect.stringContaining(file),
        expect.stringContaining('modules/nested/worker.tsx'),
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
