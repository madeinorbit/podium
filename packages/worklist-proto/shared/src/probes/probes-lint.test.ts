// @vitest-environment node
// (ESLint reads files with a Node AbortSignal; happy-dom replaces the global.)
/**
 * POD-4564 (L6b) — the lint column of every probe, measured.
 *
 * Each probe's `lintPlants` is the mistake's code shape in an arm's idiom,
 * linted at a path inside the lint fence's fixture arm
 * (`harness/lint/fixtures/arms/planted/`) through the fence's own config, the
 * one `fence-lint.test.ts` proves can say yes and no. The rules it reports
 * must be exactly the plant's `expect` (empty: the lint fence is SILENT on
 * that shape). So a catalogue cell like "lint fires only at module scope" is
 * a measurement, and a rule change that starts or stops catching a probe
 * turns this red.
 */
import { join } from 'node:path'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import { fenceConfig } from '../../../harness/lint/fence-plugin.mjs'
import { PROBES } from './index'

const PACKAGE_DIR = process.cwd().endsWith(join('packages', 'worklist-proto'))
  ? process.cwd()
  : join(process.cwd(), 'packages', 'worklist-proto')
const FIXTURES = 'harness/lint/fixtures/arms'
const PLANTED = `${FIXTURES}/planted`

const lint = new ESLint({
  cwd: PACKAGE_DIR,
  overrideConfigFile: true,
  overrideConfig: fenceConfig({ root: FIXTURES, frozen: [] }),
})

async function ruleIds(code: string, file: string): Promise<string[]> {
  const [result] = await lint.lintText(code, { filePath: join(PACKAGE_DIR, PLANTED, file) })
  return (result?.messages ?? []).map((m) => m.ruleId ?? `parse: ${m.message}`)
}

describe('probe lint plants, through the lint fence', () => {
  for (const probe of PROBES) {
    for (const plant of probe.lintPlants) {
      it(`${probe.id} — ${plant.name}: ${plant.expect.length === 0 ? 'SILENT' : plant.expect.join(', ')}`, async () => {
        expect(await ruleIds(plant.code, plant.file)).toEqual([...plant.expect])
      })
    }
  }

  it('every probe has at least one lint plant', () => {
    expect(PROBES.filter((probe) => probe.lintPlants.length === 0).map((probe) => probe.id)).toEqual([])
  })
})
