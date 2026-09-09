/**
 * Parent ←→ server control channel for update swap and self-handover [POD-2505].
 *
 * Three request kinds share one serialized parent channel:
 *
 *  - `swap`     — the parent runs schema-gate-before-fetch, verified fetch,
 *                 atomic swap (retaining `.old`) and the post-swap VERSION
 *                 re-read fence. The server does NOT swap its own bundle out
 *                 from under itself; it asks and waits for the answer.
 *  - `handover` — the bundle on disk is already the target; the parent spawns
 *                 the successor parent and waits for it to be healthy.
 *  - `topology` — the live parent reconciles its server/daemon child set and
 *                 answers only after the requested health boundary.
 *
 * A `swap` needs an answer (a fetch can fail, and the operation's `server` step
 * has to report `download-failed` with a real reason rather than hanging), so
 * the parent writes a RESULT file keyed by the request id and the caller polls
 * for it. `handover` has no useful answer — by the time it succeeds the asking
 * server has been replaced.
 *
 * TWO INLETS, ONE EXECUTION PATH (POD-3763). A request reaches the supervisor
 * one of two ways, and WHICH ONE IS STRUCTURAL, NEVER A FALLBACK:
 *
 *  - THE LINE. A supervised child — the server, the daemon — holds the private
 *    channel its supervisor gave it when it spawned it. It asks on that line and
 *    the answer comes back on the same line. **A channel error is a failure,
 *    never a reason to fall back to files.** Falling back would silently undo the
 *    thing this epic exists to do: it would let a child that knows exactly which
 *    process supervises it go back to guessing from a pid on disk, which is the
 *    bug POD-2721 filed and POD-3752 diagnosed.
 *  - THE FILE AND THE SIGNAL. A process the supervisor never spawned CANNOT have
 *    a line — a pipe exists only between a process and the child it started
 *    (POD-3760 measured that on every platform), and one cannot be conjured
 *    afterwards. The operator subcommands (`podium server-transfer-promote`,
 *    `podium server-transfer-retire-daemon`) are exactly that: a human at a shell
 *    on the box, in the situation where the component being moved may be down.
 *    This is their path, and it is not deprecated, not legacy, and not to be
 *    deleted in a later cleanup. It writes a request file under `<stateDir>/run/`
 *    and wakes the parent with SIGUSR1 at the pid in its run-registry record; the
 *    parent answers with a result file that the caller polls for.
 *
 * The supervisor runs the same swap/handover/topology code for either inlet.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { stateDir } from './config'
import { liveRecord } from './run-registry'

export const PARENT_HANDOVER_SIGNAL: NodeJS.Signals = 'SIGUSR1'

export const ParentRequestKind = z.enum(['swap', 'handover', 'topology'])
export type ParentRequestKind = z.infer<typeof ParentRequestKind>

export const ParentRequest = z.object({
  /** Correlates a request with its result file. */
  requestId: z.string().min(1),
  kind: ParentRequestKind,
  /** Target version the successor must serve on /version. */
  expectedVersion: z.string().min(1),
  /** ISO timestamp of the request. */
  requestedAt: z.string(),
  /**
   * For `swap`: the full update target, so the parent can plan convergence,
   * schema-gate it against this machine's ledger and fetch the verified bundle.
   * Kept as a passthrough object — the parent parses it with the protocol's own
   * `UpdateTarget` schema, and runtime must not re-declare that shape here.
   */
  target: z.record(z.unknown()).optional(),
  /**
   * For `swap`: the public half of the instance's update-signing key, so the
   * parent verifies dev-published bundles against the SAME pin the server
   * advertises. The server owns that identity (it mints the key); the parent
   * must not re-derive it, so it travels with the request. Public by
   * construction — it is what pairing daemons are handed.
   */
  pinnedPubkey: z.string().optional(),
  /**
   * For `swap`: the publisher key advertised with the grant. This is diagnostic
   * context only; verification remains rooted in `pinnedPubkey`.
   */
  publisherPubkey: z.string().optional(),
  /**
   * For a daemon-initiated packaged handover: the target declaration compared
   * with this machine's ledger. Absence stays unknown, so rollback stays refused.
   */
  releaseHadMigrations: z.boolean().optional(),
  children: z.array(z.enum(['server', 'daemon'])).optional(),
  restartDaemon: z.boolean().optional(),
  topologyHealth: z.enum(['server', 'daemon', 'none']).optional(),
})
export type ParentRequest = z.infer<typeof ParentRequest>

export const ParentResult = z.object({
  requestId: z.string().min(1),
  kind: ParentRequestKind,
  ok: z.boolean(),
  /** Failure reason, verbatim, when `ok` is false. */
  error: z.string().optional(),
  /**
   * Set by a successful `swap`: did the release the parent just installed carry
   * migrations this database had not applied? Decision 4 forbids rollback when
   * it did, and this is the ONLY place that can answer it — the parent is what
   * reads the target's declared migrations against the live ledger.
   */
  releaseHadMigrations: z.boolean().optional(),
  completedAt: z.string(),
})
export type ParentResult = z.infer<typeof ParentResult>

/**
 * The parent's UNSOLICITED report about the release it was asked to install.
 *
 * A result file answers a request; this one answers nothing, because by the time
 * the parent knows the release is bad the process that asked has been replaced
 * or killed. Decision 4 requires the parent to "report WHY rollback was
 * unavailable", and §4 requires a rollback to end as a `stuck` report rather
 * than as a silent revert — so the outcome is written where the NEXT server to
 * boot will find it, and that server folds it into the update operation it
 * adopts (`reconcileUpdateOperation`).
 */
export const ParentOutcome = z.object({
  at: z.string(),
  outcome: z.enum(['rolled-back', 'rollback-unavailable']),
  /** One plain sentence: what happened to the release, and why. */
  why: z.string().min(1),
  /** The version the machine is left running. */
  version: z.string().optional(),
})
export type ParentOutcome = z.infer<typeof ParentOutcome>

export function parentOutcomePath(dir: string = stateDir()): string {
  return join(dir, 'run', 'parent-outcome.json')
}

export function writeParentOutcome(outcome: ParentOutcome, dir: string = stateDir()): void {
  const parsed = ParentOutcome.parse(outcome)
  mkdirSync(join(dir, 'run'), { recursive: true })
  writeFileSync(parentOutcomePath(dir), `${JSON.stringify(parsed, null, 2)}\n`)
}

export function readParentOutcome(dir: string = stateDir()): ParentOutcome | undefined {
  const path = parentOutcomePath(dir)
  if (!existsSync(path)) return undefined
  try {
    return ParentOutcome.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

/**
 * Consume the report. Called by the server that read it: the note describes the
 * boot that just happened, and leaving it would misattribute it to a later one.
 */
export function clearParentOutcome(dir: string = stateDir()): void {
  rmSync(parentOutcomePath(dir), { force: true })
}

export function parentRequestPath(dir: string = stateDir()): string {
  return join(dir, 'run', 'parent-request.json')
}

export function parentResultPath(dir: string = stateDir()): string {
  return join(dir, 'run', 'parent-result.json')
}

export function writeParentRequest(request: ParentRequest, dir: string = stateDir()): string {
  const parsed = ParentRequest.parse(request)
  const path = parentRequestPath(dir)
  mkdirSync(join(dir, 'run'), { recursive: true })
  // A stale result from an earlier request must never be read as this one's answer.
  rmSync(parentResultPath(dir), { force: true })
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`)
  return path
}

export function readParentRequest(dir: string = stateDir()): ParentRequest | undefined {
  const path = parentRequestPath(dir)
  if (!existsSync(path)) return undefined
  try {
    return ParentRequest.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

export function clearParentRequest(dir: string = stateDir()): void {
  rmSync(parentRequestPath(dir), { force: true })
}

export function writeParentResult(result: ParentResult, dir: string = stateDir()): void {
  const parsed = ParentResult.parse(result)
  mkdirSync(join(dir, 'run'), { recursive: true })
  writeFileSync(parentResultPath(dir), `${JSON.stringify(parsed, null, 2)}\n`)
}

export function readParentResult(
  requestId: string,
  dir: string = stateDir(),
): ParentResult | undefined {
  const path = parentResultPath(dir)
  if (!existsSync(path)) return undefined
  try {
    const parsed = ParentResult.parse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.requestId === requestId ? parsed : undefined
  } catch {
    return undefined
  }
}

export type SignalFn = (pid: number, signal?: NodeJS.Signals) => void

/**
 * This process's end of the line to the supervisor that spawned it, as the code
 * that asks needs it. `connectLifecycleChannel` implements it and registers it
 * here; the shapes on the wire are {@link ParentRequest} and {@link ParentResult},
 * kept opaque on the transport's side so it need not know the update domain.
 */
export interface ParentControlLink {
  /** True while the line is open. */
  open(): boolean
  /** Post an ask and resolve when the frame has FLUSHED. No answer is waited for. */
  post(requestId: string, request: Record<string, unknown>): Promise<void>
  /** Post an ask and resolve with the supervisor's answer. Rejects if the line closes first. */
  request(requestId: string, request: Record<string, unknown>): Promise<Record<string, unknown>>
}

let processLink: ParentControlLink | undefined

/** Called by `connectLifecycleChannel`; there is exactly one supervisor per process. */
export function setParentControlLink(link: ParentControlLink | undefined): void {
  processLink = link
}

export function parentControlLink(): ParentControlLink | undefined {
  return processLink
}

/**
 * "DO I HOLD AN OPEN LINE TO MY SUPERVISOR?" — the supervised child's question,
 * and the honest answer to "can this process get itself restarted?".
 *
 * NOT THE SAME QUESTION AS {@link registeredParentPid}, and the two must not be
 * unified. A child that was spawned with a line knows exactly which process
 * supervises it, and that knowledge cannot go stale: if the supervisor dies the
 * line closes. A pid read out of the run registry can be missing while a
 * supervisor is very much alive — an aborted handover left exactly that hole
 * (POD-2721), and a server that read it concluded it could not be restarted at
 * all. The registry lookup survives ONLY for a caller that never had a line and
 * never can (see the header), which is why it keeps its own name.
 */
export function supervisorLineOpen(): boolean {
  return processLink?.open() === true
}

/**
 * The supervisor's pid from the run registry, for the file+signal inlet. The
 * channel-less caller's only way to find the parent — see {@link supervisorLineOpen}
 * for why a supervised child must never ask this instead.
 */
export function registeredParentPid(): number | undefined {
  return liveRecord('parent')?.pid
}

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface ParentRequestOptions {
  stateDir?: string
  signal?: SignalFn
  kill?: SignalFn
  /** Injectable clock/ids for tests. */
  now?: () => number
  newId?: () => string
  sleep?: (ms: number) => Promise<void>
  /**
   * Injectable line, for tests only. `undefined` asks this process's registered
   * link (what production does); `null` states that this process holds no line,
   * which is how a test exercises the channel-less caller's inlet.
   */
  link?: ParentControlLink | null
}

/** The supervisor answered something this process cannot read as a result. */
const UNREADABLE_ANSWER = 'the supervising parent answered with a result this process cannot read'

function resolveLink(opts: ParentRequestOptions): ParentControlLink | undefined {
  if (opts.link !== undefined) return opts.link ?? undefined
  return processLink
}

/**
 * Does this ask go on the line?
 *
 * THE ONE INVARIANT THIS FUNCTION EXISTS TO HOLD: a process that HAS an open
 * line always uses it, and there is no path from a channel failure back to the
 * file inlet. That is why this is a plain question asked BEFORE the ask, and not
 * a `catch` around it — a `catch` is exactly the shape that would quietly
 * downgrade a supervised child back to a pid on disk.
 */
function onTheLine(opts: ParentRequestOptions): ParentControlLink | undefined {
  const link = resolveLink(opts)
  return link?.open() === true ? link : undefined
}

interface ParentRequestBody {
  expectedVersion: string
  target?: Record<string, unknown>
  pinnedPubkey?: string
  publisherPubkey?: string
  releaseHadMigrations?: boolean
  children?: Array<'server' | 'daemon'>
  restartDaemon?: boolean
  topologyHealth?: 'server' | 'daemon' | 'none'
}

function buildRequest(
  kind: ParentRequestKind,
  requestId: string,
  request: ParentRequestBody,
  opts: ParentRequestOptions,
): ParentRequest {
  return ParentRequest.parse({
    requestId,
    ...(request.publisherPubkey ? { publisherPubkey: request.publisherPubkey } : {}),
    kind,
    expectedVersion: request.expectedVersion,
    requestedAt: new Date(opts.now?.() ?? Date.now()).toISOString(),
    ...(request.target ? { target: request.target } : {}),
    ...(request.pinnedPubkey ? { pinnedPubkey: request.pinnedPubkey } : {}),
    ...(request.releaseHadMigrations !== undefined
      ? { releaseHadMigrations: request.releaseHadMigrations }
      : {}),
    ...(request.children ? { children: request.children } : {}),
    ...(request.restartDaemon !== undefined ? { restartDaemon: request.restartDaemon } : {}),
    ...(request.topologyHealth ? { topologyHealth: request.topologyHealth } : {}),
  })
}

function mintId(kind: ParentRequestKind, opts: ParentRequestOptions): string {
  return opts.newId?.() ?? `${kind}-${(opts.now?.() ?? Date.now()).toString(36)}`
}

/** Ask on the line and read the answer back as a {@link ParentResult}. */
async function askOnLine(link: ParentControlLink, request: ParentRequest): Promise<ParentResult> {
  const answer = await link.request(
    request.requestId,
    request as unknown as Record<string, unknown>,
  )
  const parsed = ParentResult.safeParse(answer)
  if (!parsed.success) throw new Error(UNREADABLE_ANSWER)
  if (parsed.data.requestId !== request.requestId) {
    throw new Error('the supervising parent answered a different request')
  }
  return parsed.data
}

/** The channel-less inlet: write the request file and wake the registered parent. */
function postFile(
  request: ParentRequest,
  opts: ParentRequestOptions,
): { ok: true; pid: number } | { ok: false; reason: string } {
  const pid = registeredParentPid()
  if (pid === undefined) return { ok: false, reason: 'no-parent' }
  writeParentRequest(request, opts.stateDir ?? stateDir())
  const kill = opts.signal ?? opts.kill ?? process.kill
  kill(pid, PARENT_HANDOVER_SIGNAL)
  return { ok: true, pid }
}

/**
 * Post a request that expects no answer, on whichever inlet this process has.
 *
 * NEVER THROWS. Both callers return `{ ok, reason }` rather than raising, and
 * both are invoked from a scheduled callback nobody is awaiting — a throw there
 * would become an unhandled rejection instead of the refusal the caller is
 * written to read. An unreadable state dir and a supervisor that died between
 * the lookup and the signal both come back as `ok: false` with the sentence.
 */
async function postOnInlet(
  request: ParentRequest,
  opts: ParentRequestOptions,
): Promise<{ ok: true; pid?: number } | { ok: false; reason: string }> {
  const link = onTheLine(opts)
  try {
    if (link) {
      // A CHANNEL ERROR IS A FAILURE, NEVER A REASON TO FALL BACK TO FILES.
      await link.post(request.requestId, request as unknown as Record<string, unknown>)
      return { ok: true }
    }
    return postFile(request, opts)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Poll the result file the parent writes for a file-inlet request. */
async function awaitFileResult(
  request: ParentRequest,
  pid: number,
  opts: ParentRequestOptions & { timeoutMs?: number },
  timeoutMs: number,
  timedOut: string,
): Promise<ParentResult> {
  const dir = opts.stateDir ?? stateDir()
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? sleepMs
  const deadline = now() + (opts.timeoutMs ?? timeoutMs)
  while (now() < deadline) {
    const result = readParentResult(request.requestId, dir)
    if (result) return result
    await sleep(250)
  }
  throw new Error(`the supervising parent (pid ${pid}) ${timedOut}`)
}

/**
 * Ask the live parent to run self-handover onto the bundle already on disk.
 *
 * FIRE AND FORGET, because a handover that succeeds replaces the process that
 * asked: there is nobody left for an answer to come back to. `ok` therefore
 * means the ask has actually LEFT this process — the flush callback on the line,
 * or the request file plus the signal on the other inlet — and not merely that
 * it was queued. Returns `ok: false` when there is no supervisor to ask, which
 * is what makes the caller surface machine-cannot-restart rather than pretending
 * a restart is under way (disposition 6).
 */
export async function requestParentHandover(
  request: { expectedVersion: string; releaseHadMigrations?: boolean },
  opts: ParentRequestOptions = {},
): Promise<{ ok: true; pid?: number } | { ok: false; reason: string }> {
  const requestId = mintId('handover', opts)
  return await postOnInlet(buildRequest('handover', requestId, request, opts), opts)
}

/**
 * Ask the live parent to reconcile its complete child set, and DO NOT wait for
 * it — for a child that expects to be retired by the very reconciliation it is
 * asking for. {@link requestParentTopology} is the form that waits.
 */
export async function signalParentTopology(
  request: {
    children: Array<'server' | 'daemon'>
    restartDaemon?: boolean
    health: 'server' | 'daemon' | 'none'
  },
  opts: ParentRequestOptions = {},
): Promise<{ ok: true; pid?: number } | { ok: false; reason: string }> {
  const requestId = mintId('topology', opts)
  return await postOnInlet(topologyRequest(requestId, request, opts), opts)
}

function topologyRequest(
  requestId: string,
  request: {
    children: Array<'server' | 'daemon'>
    restartDaemon?: boolean
    health: 'server' | 'daemon' | 'none'
  },
  opts: ParentRequestOptions,
): ParentRequest {
  return buildRequest(
    'topology',
    requestId,
    {
      expectedVersion: 'topology',
      children: request.children,
      ...(request.restartDaemon !== undefined ? { restartDaemon: request.restartDaemon } : {}),
      topologyHealth: request.health,
    },
    opts,
  )
}

export async function requestParentTopology(
  request: {
    children: Array<'server' | 'daemon'>
    restartDaemon?: boolean
    health: 'server' | 'daemon' | 'none'
  },
  opts: ParentRequestOptions & { timeoutMs?: number } = {},
): Promise<void> {
  const requestId = mintId('topology', opts)
  const body = topologyRequest(requestId, request, opts)
  const link = onTheLine(opts)
  const result = link
    ? await askOnLine(link, body)
    : await (async () => {
        const posted = postFile(body, opts)
        if (!posted.ok) {
          throw new Error('machine-cannot-restart: no supervising parent is registered')
        }
        return await awaitFileResult(
          body,
          posted.pid,
          opts,
          60_000,
          'did not reconcile runtime topology in time',
        )
      })()
  if (!result.ok) throw new Error(result.error ?? 'the parent could not reconcile runtime topology')
}

export async function requestParentSwap(
  request: {
    expectedVersion: string
    target: Record<string, unknown>
    pinnedPubkey?: string
    publisherPubkey?: string
  },
  opts: ParentRequestOptions & { timeoutMs?: number } = {},
): Promise<{ releaseHadMigrations: boolean }> {
  const requestId = mintId('swap', opts)
  const body = buildRequest('swap', requestId, request, opts)
  const link = onTheLine(opts)
  const result = link
    ? await askOnLine(link, body)
    : await (async () => {
        const posted = postFile(body, opts)
        if (!posted.ok) {
          throw new Error(
            'machine-cannot-restart: no supervising parent is registered to install this update',
          )
        }
        return await awaitFileResult(
          body,
          posted.pid,
          opts,
          20 * 60_000,
          'did not answer the install request in time',
        )
      })()
  if (!result.ok) throw new Error(result.error ?? 'the parent could not install this update')
  return { releaseHadMigrations: result.releaseHadMigrations === true }
}
