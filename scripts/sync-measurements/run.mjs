/** Sequential A/B pairs within each mode. Benchmark, not an agent test gate.
 * Hold sync-gate while running; renew the lease for long slow-reader runs.
 * bun scripts/sync-measurements/run.mjs <before-root> <after-root> <out> [both|before|after] [full|smoke] [mode]
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const [beforeArg, afterArg, outArg, arms = 'both', scale = 'full', onlyMode] = process.argv.slice(2)
if (!beforeArg || !afterArg || !outArg)
  throw new Error('before-root, after-root, output-dir required')
const beforeRoot = resolve(beforeArg),
  afterRoot = resolve(afterArg),
  out = resolve(outArg)
mkdirSync(out, { recursive: true })
const scriptRoot = import.meta.dirname
const beforeSha = 'd958a17c3c9e916d3bab9741422d92d049dcfa79'
const afterSha = execFileSync('git', ['rev-parse', 'issue/pod-3933-http-sync-streaming'], {
  encoding: 'utf8',
}).trim()
if (execFileSync('git', ['diff', afterSha, '--', 'apps', 'packages'], { encoding: 'utf8' }).trim())
  throw new Error('AFTER SOURCE STOP: production tree differs from integration tip')
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('PODIUM_')),
)
const disk = () => {
  const stat = statfsSync(out)
  return {
    at: new Date().toISOString(),
    availableBytes: stat.bavail * stat.bsize,
    df: execFileSync('df', ['-h', out], { encoding: 'utf8' }),
  }
}
async function client(args, root, sha) {
  const loader = createRequire(resolve(root, 'package.json')).resolve('tsx')
  let peak = 0
  await new Promise((yes, no) => {
    const child = spawn(
      'node',
      ['--conditions=@podium/source', '--import', loader, join(scriptRoot, 'client.mjs'), ...args],
      { stdio: 'inherit', env: { ...env, MEASUREMENT_SHA: sha } },
    )
    const timer = setInterval(() => {
      try {
        const text = readFileSync(`/proc/${child.pid}/status`, 'utf8')
        peak = Math.max(peak, Number(text.match(/^VmHWM:\s+(\d+)/m)?.[1] ?? 0) * 1024)
      } catch {}
    }, 10)
    child.on('error', (error) => {
      clearInterval(timer)
      no(error)
    })
    child.on('exit', (code, signal) => {
      clearInterval(timer)
      code === 0 ? yes() : no(new Error(`client exited ${code ?? signal}`))
    })
  })
  return peak
}
const order = arms === 'both' ? ['before', 'after'] : [arms]
const summary = []
const modes = [
  ['bootstrap', 'identity'],
  ['bootstrap', 'gzip'],
  ['bootstrap', 'zstd'],
  ['delta', 'identity'],
  ['admission', 'identity'],
  ['concurrent', 'identity'],
  ['rate-control', 'identity'],
].filter(([mode]) => !onlyMode || mode === onlyMode)
for (const [mode, coding] of modes)
  for (let run = 0; run < order.length; run++) {
    const arm = order[run],
      root = arm === 'before' ? beforeRoot : afterRoot,
      sha = arm === 'before' ? beforeSha : afterSha
    // The gzip pair uses legacy identity as its explicitly labelled comparator;
    // the old transport has no gzip encoding.
    const beforeDisk = disk()
    if (beforeDisk.availableBytes < 3 * 1024 ** 3)
      throw new Error('DISK STOP: below coordinator 3 GiB floor')
    const dir = join(out, `${run}-${arm}-${mode}-${coding}`)
    if (existsSync(dir)) throw new Error(`Refusing overwrite: ${dir}`)
    mkdirSync(dir)
    writeFileSync(join(dir, 'disk-before.json'), JSON.stringify(beforeDisk, null, 2))
    const ready = join(dir, 'ready.json'),
      db = join(dir, 'podium.db')
    const server = spawn(
      'bun',
      ['--conditions=@podium/source', join(scriptRoot, 'server.mjs'), root, db, arm, ready, scale],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, PODIUM_STATE_DIR: join(dir, 'state') } },
    )
    let logs = '',
      exitCode,
      endDisk,
      failure
    server.stdout.on('data', (bytes) => {
      logs += bytes
    })
    server.stderr.on('data', (bytes) => {
      logs += bytes
    })
    server.on('exit', (code) => {
      exitCode = code
    })
    try {
      const deadline = Date.now() + 180000
      while (!existsSync(ready)) {
        if (exitCode !== undefined) throw new Error(`server exited ${exitCode}: ${logs}`)
        if (Date.now() > deadline) throw new Error('fixture timeout')
        await delay(100)
      }
      const peak = await client(
        [ready, join(dir, 'result.json'), mode, coding, mode === 'rate-control' ? '250' : '500'],
        root,
        sha,
      )
      endDisk = disk()
      const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'))
      result.diskBefore = beforeDisk
      result.diskEnd = endDisk
      result.externalClientLifetimePeakRssBytes = peak
      writeFileSync(join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
      summary.push({
        arm,
        mode,
        coding,
        sha,
        wallMs: result.wallMs,
        mainBusyPercent: result.mainThreadBusyPercent,
        healthP95Ms: result.health.p95Ms,
        pingP95Ms: result.websocketPing.p95Ms,
        peakServerRssMiB: result.peakSampledServerRssBytes / 1024 ** 2,
        achievedRatio: result.result.achievedRatio ?? result.result[0]?.achievedRatio,
      })
      writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
      console.table(summary)
      if (beforeDisk.availableBytes - endDisk.availableBytes > 1024 ** 3)
        throw new Error('DISK STOP: more than 1 GiB net consumed')
      const values = Array.isArray(result.result) ? result.result : [result.result]
      if (values.some((value) => value.status === 'failed'))
        throw new Error('MEASUREMENT STOP: failed transfer recorded')
      if (
        scale === 'full' &&
        values.some((value) => value.proofPassed === false || value.admissionPassed === false)
      )
        throw new Error('MEASUREMENT STOP: backpressure/admission proof failed')
      if (
        scale === 'full' &&
        coding === 'zstd' &&
        (result.result.achievedRatio < 5 || result.result.achievedRatio > 7)
      )
        throw new Error('CORPUS STOP: Zstd ratio outside 5–7x band')
    } catch (error) {
      failure = error
    } finally {
      server.kill('SIGTERM')
      await new Promise((yes) => {
        if (exitCode !== undefined) return yes()
        server.once('exit', yes)
        setTimeout(() => server.kill('SIGKILL'), 2000).unref()
      })
      writeFileSync(join(dir, 'server.log'), logs)
      if (!endDisk) endDisk = disk()
      writeFileSync(join(dir, 'disk-end.json'), JSON.stringify(endDisk, null, 2))
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${db}${suffix}`, { force: true })
      rmSync(join(dir, 'state'), { recursive: true, force: true })
      writeFileSync(join(dir, 'disk-after-cleanup.json'), JSON.stringify(disk(), null, 2))
    }
    if (failure) throw failure
  }
