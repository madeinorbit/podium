// packages/harness/src/driver/families/headless/wrapper.ts
//
// THE SHELL EVERY HOSTED TURN RUNS UNDER (POD-4614).
//
// podium-host --no-pty merges the child's stdout and stderr into one
// sequence-numbered ring and offers no way to close the child's stdin. A
// one-shot turn needs three things that ring cannot give on its own, so a
// POSIX sh wrapper provides them, with no file on disk:
//
//  1. WHO THIS IS. The first line of the ring is an identity marker: the turn
//     identity hash, its start time and the conversation it is pinned to. A
//     restarted daemon replays the ring from seq 0 and reads it back, so it
//     adopts only its own turn (never a stranger's) and keeps the original
//     deadline. This replaces the abduco runner's identity and created-at
//     files.
//  2. WHICH BYTES ARE STDERR. Each stderr line is prefixed, so the fold reads
//     stdout exactly (a text-output harness's whole stdout IS the answer) and
//     keeps stderr as the failure explanation. stdout lines stay untouched.
//  3. STDIN THAT ENDS. `none` runs the child with /dev/null; a byte count
//     makes `head -c N` the child's stdin — the daemon writes the payload over
//     the host's write channel and the child sees EOF after it; `live` leaves
//     the host's write channel attached for a whole stream-json conversation.
//
// The exit status the host reports (EXITED) is the child's own: the wrapper
// captures it through fd 5 and exits with it.

import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { HeadlessStdin } from './invocation.js'
import type { HostedTurnIdentity } from './types.js'

export const TURN_MARKER_PREFIX = '@@podium-turn@@'
export const TURN_STDERR_PREFIX = '@@podium-stderr@@ '

/** POSIX sh: `$1` marker line, `$2` stdin mode, the rest is the argv to run. */
export const TURN_WRAPPER_SCRIPT = `printf '%s\\n' "$1"
mode=$2
shift 2
exec 4>&1
run() {
  case $mode in
    none) "$@" </dev/null ;;
    live) "$@" ;;
    *) head -c "$mode" | "$@" ;;
  esac
}
st=$( { { run "$@" 2>&1 1>&4 4>&- 5>&-; echo $? >&5; } | sed 's/^/${TURN_STDERR_PREFIX}/' >&4 4>&- 5>&-; } 5>&1 )
exit "\${st:-1}"
`

/** Which step of a turn a host is running: the conversation allocation
 *  (cursor `create-chat`) or the turn itself. */
export type TurnPhase = 'alloc' | 'turn'

export interface TurnMarker {
  phase: TurnPhase
  identityHash: string
  createdAt: number
  /** UNBRANDED BY DECISION: a provider/harness-native session id. */
  pinnedSessionId?: string
}

/** The exact identity a replay must match: session, turn, digest and account. */
export function turnIdentityHash(identity: HostedTurnIdentity): string {
  return createHash('sha256')
    .update(
      `${identity.sessionId}\u0000${identity.turnId}\u0000${identity.requestDigest}\u0000${identity.accountId}`,
    )
    .digest('hex')
    .slice(0, 32)
}

export function encodeTurnMarker(marker: TurnMarker): string {
  return [
    TURN_MARKER_PREFIX,
    'v1',
    marker.phase,
    marker.identityHash,
    String(marker.createdAt),
    marker.pinnedSessionId ?? '-',
  ].join(' ')
}

export function parseTurnMarker(line: string): TurnMarker | undefined {
  const parts = line.trim().split(' ')
  if (parts[0] !== TURN_MARKER_PREFIX || parts[1] !== 'v1' || parts.length !== 6) return undefined
  const phase = parts[2]
  if (phase !== 'alloc' && phase !== 'turn') return undefined
  const createdAt = Number(parts[4])
  if (!Number.isFinite(createdAt)) return undefined
  const pinned = parts[5]
  return {
    phase,
    identityHash: parts[3] as string,
    createdAt,
    ...(pinned && pinned !== '-' ? { pinnedSessionId: pinned } : {}),
  }
}

function stdinMode(stdin: HeadlessStdin): string {
  if (stdin.kind === 'none') return 'none'
  if (stdin.kind === 'live') return 'live'
  return String(Buffer.byteLength(stdin.data, 'utf8'))
}

/** The host's argv for one wrapped invocation. */
export function wrapTurnInvocation(input: {
  marker: TurnMarker
  stdin: HeadlessStdin
  cmd: string
  args: readonly string[]
}): { cmd: string; args: string[] } {
  return {
    cmd: '/bin/sh',
    args: [
      '-c',
      TURN_WRAPPER_SCRIPT,
      'podium-turn',
      encodeTurnMarker(input.marker),
      stdinMode(input.stdin),
      input.cmd,
      ...input.args,
    ],
  }
}

export type TurnLine =
  | { kind: 'marker'; marker: TurnMarker | undefined; raw: string }
  | { kind: 'stdout'; line: string }
  | { kind: 'stderr'; line: string }

/**
 * Split the host ring back into what the wrapper wrote. The FIRST line of a
 * ring read from seq 0 is the marker; a ring whose first byte is not seq 0 has
 * lost it (overflow), and the splitter reports `marker: undefined` on its
 * first line so the caller refuses rather than guesses.
 */
export function createTurnLineSplitter(onLine: (line: TurnLine) => void): {
  push(seq: bigint, chunk: Uint8Array): void
  flush(): void
} {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let first = true
  let startedAtZero: boolean | undefined
  const emit = (line: string): void => {
    if (first) {
      first = false
      onLine({
        kind: 'marker',
        marker: startedAtZero ? parseTurnMarker(line) : undefined,
        raw: line,
      })
      return
    }
    if (line.startsWith(TURN_STDERR_PREFIX)) {
      onLine({ kind: 'stderr', line: line.slice(TURN_STDERR_PREFIX.length) })
      return
    }
    onLine({ kind: 'stdout', line })
  }
  return {
    push(seq, chunk) {
      if (startedAtZero === undefined) startedAtZero = seq === 0n
      buffer += decoder.write(Buffer.from(chunk))
      let boundary = buffer.indexOf('\n')
      while (boundary >= 0) {
        emit(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 1)
        boundary = buffer.indexOf('\n')
      }
    },
    flush() {
      buffer += decoder.end()
      if (buffer) emit(buffer)
      buffer = ''
    },
  }
}
