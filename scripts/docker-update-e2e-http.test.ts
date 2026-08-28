import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// POD-2731: a sandbox build died on `curl: (22) The requested URL returned error:
// 400` and nobody — human or agent — could tell WHICH request had been refused.
// `curl -f` is the reason: it discards the response body, which is exactly where a
// tRPC refusal explains itself, and its message names no URL. These tests pin the
// replacement: every failing request names its subject.

const ROOT = join(import.meta.dirname, '..')
const HELPER = join(ROOT, 'scripts/docker-update-e2e/http.sh')

let server: Server
let origin = ''

/**
 * Run one bash snippet with the harness HTTP helpers sourced.
 *
 * Async on purpose: the fixture server below lives in this same process, so a
 * synchronous exec would block the event loop and curl would never be answered.
 */
async function bash(snippet: string): Promise<{ stdout: string; stderr: string; status: number }> {
  const script = `set -Eeuo pipefail\nshopt -s inherit_errexit\nsource ${JSON.stringify(HELPER)}\n${snippet}\n`
  try {
    const { stdout, stderr } = await promisify(execFile)('bash', ['-c', script], {
      encoding: 'utf8',
    })
    return { stdout, stderr, status: 0 }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.code ?? -1 }
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith('/trpc/repos.add')) {
      // The shape a tRPC refusal actually arrives in.
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            json: {
              message: 'machine "source" runs no daemon and cannot host a repo',
              code: -32600,
            },
          },
        }),
      )
      return
    }
    if (req.url?.startsWith('/huge')) {
      res.writeHead(400, { 'content-type': 'text/html' })
      res.end('x'.repeat(50_000))
      return
    }
    if (req.url?.startsWith('/version')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ instanceId: 'update-e2e', appVersion: '9.9.9' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ result: { data: { ok: true } } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('docker-update-e2e request reporting', () => {
  it('names the URL, the status and the response body when a request is refused', async () => {
    const url = `${origin}/trpc/repos.add`
    const result = await bash(`http_request POST ${JSON.stringify(url)} '{"path":"/work/source"}'`)

    expect(result.status).not.toBe(0)
    // The subject of the failure, which `curl -f` never printed.
    expect(result.stderr).toContain(url)
    expect(result.stderr).toContain('POST')
    expect(result.stderr).toContain('400')
    // The body, which is where the refusal explains itself.
    expect(result.stderr).toContain('machine "source" runs no daemon and cannot host a repo')
    // The request we sent, so the refusal can be read against its input.
    expect(result.stderr).toContain('{"path":"/work/source"}')
  })

  it('reports a refusal without the caller having to opt in', async () => {
    // The old helper only spoke when `jq -e .error` matched a body it had already
    // thrown away. Reporting must not depend on the caller doing anything.
    const result = await bash(
      `http_request GET ${JSON.stringify(`${origin}/trpc/repos.add`)} || true`,
    )
    expect(result.stderr).toContain('400')
  })

  it('bounds a large response body instead of flooding the log', async () => {
    const result = await bash(`http_request GET ${JSON.stringify(`${origin}/huge`)} || true`)
    expect(result.stderr.length).toBeLessThan(12_000)
    expect(result.stderr).toContain('truncated')
    expect(result.stderr).toContain(`${origin}/huge`)
  })

  it('names the URL when the connection never lands', async () => {
    // Port 1 on loopback refuses; there is no status and no body to echo, but the
    // subject must still be named.
    const result = await bash(`http_request GET 'http://127.0.0.1:1/trpc/updates.fleet' || true`)
    expect(result.stderr).toContain('http://127.0.0.1:1/trpc/updates.fleet')
  })

  it('returns the body to the caller on success and stays silent', async () => {
    const result = await bash(
      `http_request GET ${JSON.stringify(`${origin}/ok`)}\nprintf '%s' "$HTTP_BODY"`,
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('"ok":true')
    expect(result.stderr).toBe('')
  })

  it('reports the tRPC call the harness actually makes, by name', async () => {
    // The end-to-end path that failed in the field: rpc() -> http_request ->
    // report. Testing http_request alone would leave rpc free to swallow it.
    const harness = join(ROOT, 'scripts/docker-update-e2e.sh')
    const port = (server.address() as AddressInfo).port
    const result = await promisify(execFile)(
      'bash',
      [
        '-c',
        `set -Eeuo pipefail
         source ${JSON.stringify(harness)}
         SOURCE_PORT=${port}
         rpc POST repos.add '{"path":"/work/source"}' || true`,
      ],
      { encoding: 'utf8' },
    ).catch((e: { stdout?: string; stderr?: string }) => ({
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    }))

    expect(result.stderr).toContain(`http://127.0.0.1:${port}/trpc/repos.add`)
    expect(result.stderr).toContain('400')
    expect(result.stderr).toContain('machine "source" runs no daemon and cannot host a repo')
  })

  it('still runs its gate when executed rather than sourced', async () => {
    // The entry guard that makes the helpers testable must not turn the script
    // into a silent no-op. Reaching preflight is proof it still runs.
    const result = await promisify(execFile)(
      'bash',
      [join(ROOT, 'scripts/docker-update-e2e.sh'), '--preflight'],
      { encoding: 'utf8' },
    ).catch((e: { stdout?: string; stderr?: string }) => ({
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    }))
    expect(`${result.stdout}${result.stderr}`).toContain('[update-e2e]')
  })

  describe('readiness probes', () => {
    /** Source the harness, set the port, and run one probe. */
    async function probe(instance: string, port: number) {
      return await promisify(execFile)(
        'bash',
        [
          '-c',
          `set -Eeuo pipefail
           source ${JSON.stringify(join(ROOT, 'scripts/docker-update-e2e.sh'))}
           SOURCE_PORT=${port}
           INSTANCE=${JSON.stringify(instance)}
           if coordinator_healthy; then echo READY; else echo "NOT-READY $?"; fi`,
        ],
        { encoding: 'utf8' },
      ).catch((e: { stdout?: string; stderr?: string }) => ({
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
      }))
    }

    it('says yes when the instance matches', async () => {
      const port = (server.address() as AddressInfo).port
      expect((await probe('update-e2e', port)).stdout).toContain('READY')
    })

    it('can still say no when the instance is wrong', async () => {
      // The failure mode that would matter most: a probe rewritten into one that
      // cannot refuse makes every wait_for pass instantly and the gate go blind.
      const port = (server.address() as AddressInfo).port
      expect((await probe('someone-elses-instance', port)).stdout).toContain('NOT-READY')
    })

    it('can still say no when nothing is listening, and stays quiet doing it', async () => {
      // Quiet on purpose: wait_for polls this every 250ms for up to 120s and
      // reports the label itself on timeout.
      const result = await probe('update-e2e', 1)
      expect(result.stdout).toContain('NOT-READY')
      expect(result.stderr).toBe('')
    })
  })

  it('is the helper the real harness uses, not a sibling copy', () => {
    // Without this, every assertion above could pass while docker-update-e2e.sh kept
    // its own bare `curl -fsS`.
    const harness = readFileSync(join(ROOT, 'scripts/docker-update-e2e.sh'), 'utf8')
    expect(harness).toContain('docker-update-e2e/http.sh')
    // No request-making curl may keep `-f`: that flag is what discards the body.
    const offenders = harness
      .split('\n')
      .map((line, index) => [index + 1, line] as const)
      .filter(([, line]) => /curl\s+(-\S*f\S*|--fail)\b/.test(line))
    expect(offenders).toEqual([])
  })
})
