import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const HARNESS = join(ROOT, 'scripts/docker-update-e2e.sh')

async function bash(snippet: string, env: NodeJS.ProcessEnv = {}) {
  try {
    const { stdout, stderr } = await promisify(execFile)(
      'bash',
      ['-c', `set -Eeuo pipefail\nsource ${JSON.stringify(HARNESS)}\n${snippet}`],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } },
    )
    return { status: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return {
      status: failure.code ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    }
  }
}

describe('the update gate always crosses authentication', () => {
  it('builds a password clause by default and never acknowledges no password', async () => {
    const result = await bash('setup_auth_clause')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('"password":"podium-update-e2e"')
    expect(result.stdout).not.toContain('acknowledgeNoPassword')
  })

  it('JSON-encodes an overridden password', async () => {
    const result = await bash('setup_auth_clause', {
      PODIUM_UPDATE_E2E_PASSWORD: 'quote"and\\slash',
    })
    expect(JSON.parse(`{${result.stdout}}`).password).toBe('quote"and\\slash')
  })

  it('arms the negative control by changing only the login credential', async () => {
    const result = await bash(
      `SOURCE=source
       PROVE_FAILURE=authentication
       container_exec() {
         local container=$1
         shift
         local payload=""
         while (( $# > 0 )); do
           if [[ "$1" == -d ]]; then payload=$2; shift 2; else shift; fi
         done
         [[ "$payload" == *'deliberately-wrong'* ]] || return 90
         printf 'HTTP/1.1 401 Unauthorized\\r\\n\\n\\n401'
       }
       e2e_login source`,
    )
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('deliberate authentication failure armed')
    expect(result.stderr).toContain('LOGIN FAILED: POST http://127.0.0.1:18787/auth/login')
    expect(result.stderr).toContain('status: 401')
  })

  it('puts the coordinator session into both real browser clients before navigation', () => {
    const harness = readFileSync(HARNESS, 'utf8')
    const serverLane = readFileSync(join(ROOT, 'scripts/docker-update-e2e/server-lane.sh'), 'utf8')
    expect(harness).toContain('PODIUM_UPDATE_E2E_SESSION="${HTTP_SESSION_COOKIE[host]}"')
    expect(serverLane).toContain('PODIUM_UPDATE_E2E_SESSION="${HTTP_SESSION_COOKIE[host]}"')

    for (const path of [
      'scripts/docker-update-e2e/ui-update.ts',
      'scripts/docker-update-e2e/server-client.ts',
    ]) {
      const client = readFileSync(join(ROOT, path), 'utf8')
      expect(client).toContain('process.env.PODIUM_UPDATE_E2E_SESSION')
      expect(client).toContain("context.addCookies([{ name: 'podium_session'")
      expect(client.indexOf('context.addCookies')).toBeLessThan(client.indexOf('context.newPage'))
    }
  })
})
