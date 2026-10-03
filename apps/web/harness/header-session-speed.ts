/** Same-SHA, pilot-on scan/delta comparison. Reuses the canonical speed gate's
 * production build, targets, trusted input/Paint boundary and six-sample pairs.
 * The generated driver is scratch evidence, never a product or page change. */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve('.artifacts/header-session-speed')
const driver = resolve(root, 'driver.ts')
const sourceDir = resolve('apps/web/harness')
let source = await readFile(resolve(sourceDir, 'speed-gate.ts'), 'utf8')
function replace(before: string, after: string) {
  if (source.split(before).length !== 2) throw new Error(`Capture template changed: ${before.slice(0, 80)}`)
  source = source.replace(before, after)
}
function remove(start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a)
  if (a < 0 || b < a) throw new Error(`Capture template changed: ${start}`)
  source = source.slice(0, a) + source.slice(b)
}

replace("const ACTIONS = [\n  'sidebar-issue',\n  'mission-switch',\n  'session-pane',\n  'issue-rename',\n  'background-update',\n] as const", "const ACTIONS = ['mission-switch'] as const")
replace("resolve('.artifacts/speed-gate')", "resolve('.artifacts/header-session-speed')")
remove("      await measure('sidebar-issue'", "      await measure('mission-switch'")
remove('      await full.page.locator(row(targets.rename))', '      const actions = Object.fromEntries(')
replace('&panelMode=chat${pane', '&panelMode=chat&headerScan=${pane === 0 ? 1 : 0}${pane')
replace("!== (pane ? 'pool' : 'legacy')", "!== 'pool'")
replace("    assertSpeedSwitches(state.switches, switches)", `    assertSpeedSwitches(state.switches, switches)
    const headerArm = await page.evaluate(() => Reflect.get(window, '__headerSessionArm'))
    if (headerArm !== (pane === 0 ? 'scan' : 'delta')) throw new Error('Wrong header capture arm: ' + headerArm)`)
replace('Same-SHA pane ${arm}', 'Same-SHA header ${pane === 0 ? \'scan\' : \'delta\'}')
replace("'paired-pane.json'", "'paired-header.json'")
replace('targets: baseline!.targets, delayMs, pair, runs, legacyPageDerivations,',
  "comparison: 'header scan control vs incremental; pilot on in both arms', order: ['scan', 'delta', 'scan', 'delta'], targets: baseline!.targets, delayMs, pair, runs, legacyPageDerivations,")
replace("${report.passed ? 'PANE SPEED PAIR GREEN' : 'PANE SPEED PAIR RED'}", "${report.passed ? 'HEADER SPEED PAIR GREEN' : 'HEADER SPEED PAIR RED'}")
replace("plugins: config.plugins?.filter(\n        (plugin) => (plugin as { name?: string })?.name !== 'acceptance-state-boundaries',\n      ),", `plugins: [...(config.plugins?.filter(
        (plugin) => (plugin as { name?: string })?.name !== 'acceptance-state-boundaries',
      ) ?? []), {
        name: 'header-scan-control', enforce: 'pre',
        transform(code: string, id: string) {
          if (!id.endsWith('/client-graph/src/header-views.ts')) return
          const marker = 'return sessions ??= new HeaderSessions(pool)'
          if (code.split(marker).length !== 2) throw new Error('Header capture boundary changed')
          return { code: 'import { createScanningHeaderSessions } from ' + ${JSON.stringify(JSON.stringify(resolve(sourceDir, 'header-scan-control.ts')))} + '\\n' + code.replace(marker,
            "const scan = new URLSearchParams(location.search).get('headerScan') === '1'; Object.assign(globalThis, { __headerSessionArm: scan ? 'scan' : 'delta' }); return sessions ??= (scan ? createScanningHeaderSessions(pool, memo) : new HeaderSessions(pool))"), map: null }
        },
      }],`)

// Keep shared-driver imports at their original locations even though the
// generated file lives entirely under this issue's ignored evidence directory.
source = source.replace(/(from\s+|import\()(['"])(\.[^'"]+)\2/g,
  (_match, leading: string, _quote: string, path: string) => leading + JSON.stringify(resolve(sourceDir, path)))
await mkdir(root, { recursive: true })
await writeFile(driver, source)
try {
  const child = spawn(process.execPath, [driver, '--paired-pane', '--switch=mobxPane=1', '--switch=mobxHeader=1',
    '--switch=mobxSessionPane=1', '--switch=mobxChips=1', ...process.argv.slice(2).filter(arg => arg !== '--')], { stdio: 'inherit' })
  const code = await new Promise<number>((done, reject) => {
    child.once('error', reject)
    child.once('exit', code => done(code ?? 2))
  })
  process.exitCode = code
} finally { await unlink(driver) }
