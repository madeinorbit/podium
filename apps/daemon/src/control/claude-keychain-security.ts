import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export const SECURITY_PATH = '/usr/bin/security'
export const SECURITY_TIMEOUT_MS = 12_000
export const SECURITY_OUTPUT_LIMIT = 1_000_000

export interface SecurityResult {
  readonly stdout: Buffer
  readonly stderr: string
  readonly exitCode: number | null
  readonly signal?: NodeJS.Signals
  readonly timedOut: boolean
  readonly overflowed?: boolean
  readonly failedToSpawn?: boolean
}

export interface SecurityRunner {
  run(args: readonly string[], input?: Buffer): Promise<SecurityResult>
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  currentSize: number,
): { readonly size: number; readonly overflowed: boolean } {
  if (currentSize + chunk.length > SECURITY_OUTPUT_LIMIT) {
    return { size: currentSize, overflowed: true }
  }
  chunks.push(Buffer.from(chunk))
  return { size: currentSize + chunk.length, overflowed: false }
}

export const productionSecurityRunner: SecurityRunner = {
  run(args, input) {
    return new Promise((resolve) => {
      let settled = false
      let timedOut = false
      let overflowed = false
      let stdoutSize = 0
      let stderrSize = 0
      let timer: NodeJS.Timeout | undefined
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let child: ChildProcessWithoutNullStreams

      const finish = (result: Omit<SecurityResult, 'stdout' | 'stderr' | 'timedOut'>) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve({
          ...result,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut,
          ...(overflowed ? { overflowed: true } : {}),
        })
      }

      try {
        child = spawn(SECURITY_PATH, [...args], {
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch {
        resolve({
          stdout: Buffer.alloc(0),
          stderr: '',
          exitCode: null,
          timedOut: false,
          failedToSpawn: true,
        })
        return
      }

      timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, SECURITY_TIMEOUT_MS)
      timer.unref()

      child.stdout.on('data', (value: Buffer) => {
        const appended = appendBounded(stdout, value, stdoutSize)
        stdoutSize = appended.size
        if (appended.overflowed) {
          overflowed = true
          child.kill('SIGKILL')
        }
      })
      child.stderr.on('data', (value: Buffer) => {
        const appended = appendBounded(stderr, value, stderrSize)
        stderrSize = appended.size
        if (appended.overflowed) {
          overflowed = true
          child.kill('SIGKILL')
        }
      })
      child.once('error', () => finish({ exitCode: null, failedToSpawn: true }))
      child.once('close', (exitCode, signal) => finish({ exitCode, ...(signal ? { signal } : {}) }))
      child.stdin.once('error', () => {
        // The close/error event carries the non-secret outcome.
      })
      child.stdin.end(input)
    })
  },
}

const HEX = Buffer.from('0123456789abcdef', 'ascii')

function hexEncode(content: Buffer): Buffer {
  const encoded = Buffer.allocUnsafe(content.length * 2)
  for (let index = 0; index < content.length; index += 1) {
    const value = content[index] as number
    encoded[index * 2] = HEX[value >>> 4] as number
    encoded[index * 2 + 1] = HEX[value & 0x0f] as number
  }
  return encoded
}

export function claudeKeychainWriteInput(
  account: string,
  service: string,
  content: Buffer,
  replace: boolean,
): Buffer {
  if (!/^[A-Za-z0-9._-]+$/.test(account)) throw new Error('invalid Keychain account')
  if (!/^Claude Code-credentials(?:-[0-9a-f]{8})?$/.test(service)) {
    throw new Error('invalid Keychain service')
  }
  const encoded = hexEncode(content)
  try {
    return Buffer.concat([
      Buffer.from(
        `add-generic-password${replace ? ' -U' : ''} -a "${account}" -s "${service}" -X "`,
        'ascii',
      ),
      encoded,
      Buffer.from('"\n', 'ascii'),
    ])
  } finally {
    encoded.fill(0)
  }
}
