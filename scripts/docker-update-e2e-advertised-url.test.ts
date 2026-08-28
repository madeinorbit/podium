import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'

// POD-2767: the gate finished setup advertising `http://source:18787` — the
// coordinator container's name on the run's own private docker network. It
// resolves for a joining fleet daemon and for nothing else, so the first human
// to open a held sandbox was handed a URL their browser could not resolve and
// had to retype it. Twenty-one rows watched this gate and not one asked whether
// the address the instance HANDS OUT is an address anybody can reach.
//
// The fix is a ladder (`resolve_advertised_url`) and a row
// (`advertised_url_reachable`). Both are decision logic, and decision logic that
// can only be exercised by a forty-minute docker run is decision logic nobody
// re-checks. So they are pinned here, in the ordinary unit lane, from the real
// script: every rung of the ladder in order, and every way the row is allowed to
// go red — including the one that matters most, a loopback address, which would
// pass a naive "did it answer?" fetch from the host while reaching no client
// anywhere else.
//
// What this file does NOT prove is that the chosen address is really reachable.
// Nothing short of the gate can prove that, which is exactly why the row exists
// and why it fetches rather than reasons.

const ROOT = join(import.meta.dirname, '..')
const GATE = join(ROOT, 'scripts/docker-update-e2e.sh')

const scratch = mkdtempSync(join(tmpdir(), 'podium-advertised-url-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

async function bash(snippet: string): Promise<string> {
  const script = `set -Eeuo pipefail\nshopt -s inherit_errexit\nsource ${JSON.stringify(GATE)}\n${snippet}\n`
  try {
    const { stdout } = await promisify(execFile)('bash', ['-c', script], { encoding: 'utf8' })
    return stdout
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    return `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
}

/** Run the real ladder with a given exposure and report what it chose. */
async function ladder(exposure: Record<string, string>): Promise<{ url: string; via: string }> {
  const assignments = Object.entries(exposure)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join('\n')
  const out = await bash(
    `${assignments}\nresolve_advertised_url\nprintf 'URL=%s\\nVIA=%s\\n' "$ADVERTISED_URL" "$ADVERTISED_VIA"`,
  )
  return {
    url: /^URL=(.*)$/m.exec(out)?.[1] ?? '',
    via: /^VIA=(.*)$/m.exec(out)?.[1] ?? '',
  }
}

describe('the advertised-address ladder', () => {
  // Every rung has to answer from BOTH sides — outside the run where the browser
  // is, and inside it where a joining daemon is — because the join token embeds
  // the ws-ified publicUrl as each daemon's serverUrl. Which rung is chosen is
  // the only thing that varies; that both sides work was measured, not reasoned.
  it('prefers the tailnet HTTPS front over every plain-HTTP address', async () => {
    const chosen = await ladder({
      TAILNET_HTTPS_URL: 'https://node.example-tailnet.ts.net:32880',
      TAILNET_IP: '100.64.0.1',
      TAILNET_PORT: '32780',
      NETWORK_GATEWAY: '172.30.0.1',
      GATEWAY_PORT: '32768',
    })
    // First because it is the only TRUSTED SECURE ORIGIN on offer, and a service
    // worker is defined only in a secure context — so it is the only rung where
    // the precache and the offline shell exist at all (POD-2762), and the only
    // one the macOS desktop webview accepts. The rungs below are not a shabbier
    // URL for the same product; they are a different product.
    expect(chosen.url).toBe('https://node.example-tailnet.ts.net:32880')
    expect(chosen.via).toContain('secure origin')
  })

  it('falls back to the plain tailnet address when no HTTPS front came up', async () => {
    const chosen = await ladder({
      TAILNET_HTTPS_URL: '',
      TAILNET_IP: '100.64.0.1',
      TAILNET_PORT: '32780',
      NETWORK_GATEWAY: '172.30.0.1',
      GATEWAY_PORT: '32768',
    })
    expect(chosen.url).toBe('http://100.64.0.1:32780')
    // A fallback that did not SAY it had lost the secure context would leave the
    // reader believing the offline layer was under test when it was not.
    expect(chosen.via).toContain('no service worker')
  })

  it('falls back to the run’s own docker gateway on a host with no tailnet', async () => {
    const chosen = await ladder({
      TAILNET_HTTPS_URL: '',
      TAILNET_IP: '',
      TAILNET_PORT: '',
      NETWORK_GATEWAY: '172.30.0.1',
      GATEWAY_PORT: '32768',
    })
    // The rung that makes this a fixture rather than one person's setup: the host
    // owns the gateway address and every container on the run's network routes to
    // it, so it needs no Tailscale, no account and nobody's hostname.
    expect(chosen.url).toBe('http://172.30.0.1:32768')
  })

  it('never invents an address when the run was exposed nowhere', async () => {
    const chosen = await ladder({
      TAILNET_HTTPS_URL: '',
      TAILNET_IP: '',
      TAILNET_PORT: '',
      NETWORK_GATEWAY: '',
      GATEWAY_PORT: '',
    })
    // It keeps the old container-internal value so the run still reaches the row
    // and prints a matrix — but leaves the provenance EMPTY, so nothing downstream
    // can present the fallback as a considered choice.
    expect(chosen.url).toBe('http://source:18787')
    expect(chosen.via).toBe('')
  })

  it('advertises the container-internal name again under the deliberate control', async () => {
    const chosen = await ladder({
      PROVE_FAILURE: 'advertised-url',
      TAILNET_HTTPS_URL: 'https://node.example-tailnet.ts.net:32880',
      NETWORK_GATEWAY: '172.30.0.1',
      GATEWAY_PORT: '32768',
    })
    // The control has to reproduce the DEFECT exactly, not merely something
    // broken, or the red it produces proves nothing about the row.
    expect(chosen.url).toBe('http://source:18787')
  })
})

/**
 * Run the real row against a stubbed instance and a stubbed fetch, and report
 * the verdict it recorded.
 *
 * The row's whole point is that it asks the INSTANCE what it advertises and then
 * fetches THAT — so the two things worth stubbing are exactly those two, and
 * everything between them is the code under test.
 */
async function row(options: {
  info: string
  fetchOk?: boolean
  fetchBody?: string
}): Promise<{ result: string; detail: string; fetched: string }> {
  const work = mkdtempSync(join(scratch, 'run-'))
  const out = await bash(`
    WORK=${JSON.stringify(work)}
    mkdir -p "$WORK/logs"
    INSTANCE=update-e2e
    ADVERTISED_VIA='a stubbed exposure'
    rpc() { printf '%s\\n' ${JSON.stringify(options.info)}; }
    http_request() {
      FETCHED="$2"
      HTTP_BODY=${JSON.stringify(options.fetchBody ?? '{"instanceId":"update-e2e"}')}
      ${options.fetchOk === false ? 'return 1' : 'return 0'}
    }
    advertised_url_reachable || true
    printf 'RESULT=%s\\nDETAIL=%s\\nFETCHED=%s\\n' \
      "\${RESULT[advertised-url]:-none}" "\${DETAIL[advertised-url]:-none}" "\${FETCHED:-none}"
  `)
  return {
    result: /^RESULT=(.*)$/m.exec(out)?.[1] ?? '',
    detail: /^DETAIL=(.*)$/m.exec(out)?.[1] ?? '',
    fetched: /^FETCHED=(.*)$/m.exec(out)?.[1] ?? '',
  }
}

describe('the advertised-url row', () => {
  it('passes only after fetching the address the instance itself reported', async () => {
    const verdict = await row({ info: '{"publicUrl":"https://node.example-tailnet.ts.net:32880"}' })
    expect(verdict.result).toBe('PASS')
    // Not `$ADVERTISED_URL`: asserting the value the script sent would prove only
    // that the script remembers its own variable. The question is what the
    // instance now tells clients, so the fetch has to follow setup.info.
    expect(verdict.fetched).toBe('https://node.example-tailnet.ts.net:32880/version')
  })

  it('reddens on the container-internal name, naming the address', async () => {
    // The original defect: answers inside the run, unreachable from every client.
    const verdict = await row({ info: '{"publicUrl":"http://source:18787"}', fetchOk: false })
    expect(verdict.result).toBe('FAIL')
    expect(verdict.detail).toContain('http://source:18787')
    expect(verdict.detail).toContain('did not answer')
  })

  it('reddens on a loopback address even though it would answer', async () => {
    // The reason the fetch alone is not the whole row. `http://127.0.0.1:<mapped>`
    // answers perfectly from the host and is exactly as useless to every other
    // client as `http://source:18787` was — so a fetch-only row would call this
    // same class of defect green. The stub deliberately reports success.
    const verdict = await row({ info: '{"publicUrl":"http://127.0.0.1:32780"}', fetchOk: true })
    expect(verdict.result).toBe('FAIL')
    expect(verdict.detail).toContain('loopback')
    expect(verdict.fetched).toBe('none')
  })

  it('reddens on localhost the same way', async () => {
    const verdict = await row({ info: '{"publicUrl":"http://localhost:32780"}', fetchOk: true })
    expect(verdict.result).toBe('FAIL')
    expect(verdict.detail).toContain('loopback')
  })

  it('reddens on 0.0.0.0, the least obvious loopback of the three', async () => {
    // Measured, not assumed: `curl http://0.0.0.0:<port>` answers 200 on Linux.
    // So an instance that advertised the address it BOUND instead of the one it
    // is reached at would pass a fetch-only row while reaching nobody.
    const verdict = await row({ info: '{"publicUrl":"http://0.0.0.0:32780"}', fetchOk: true })
    expect(verdict.result).toBe('FAIL')
    expect(verdict.detail).toContain('loopback')
  })

  it('reddens on a bracketed IPv6 loopback, port and all', async () => {
    // The bracket is why this needs its own case: cutting the host at the first
    // colon leaves `[`, and the check would silently never fire.
    const verdict = await row({ info: '{"publicUrl":"http://[::1]:32780"}', fetchOk: true })
    expect(verdict.result).toBe('FAIL')
    expect(verdict.detail).toContain('loopback')
  })

  it('does not mistake a routable IPv6 address for the loopback', async () => {
    const verdict = await row({ info: '{"publicUrl":"http://[fd7a:115c:a1e0::1]:32780"}' })
    expect(verdict.result).toBe('PASS')
    expect(verdict.fetched).toBe('http://[fd7a:115c:a1e0::1]:32780/version')
  })

  it('reddens when setup completed with no advertised address at all', async () => {
    const verdict = await row({ info: '{"publicUrl":null}' })
    expect(verdict.result).toBe('FAIL')
    expect(verdict.detail).toContain('no address at all')
  })

  it('reddens when the advertised address answers as a different instance', async () => {
    // A stale proxy onto somebody else's sandbox answers 200 and means the
    // advertised address does not lead back to THIS machine.
    const verdict = await row({
      info: '{"publicUrl":"https://node.example-tailnet.ts.net:32880"}',
      fetchBody: '{"instanceId":"some-other-instance"}',
    })
    expect(verdict.result).toBe('FAIL')
    expect(verdict.detail).toContain('different instance')
  })
})
