/**
 * The update dialog's content model. This is pure so the language and the list
 * of places stay testable without rendering a browser surface.
 *
 * Podium is one product with one version running in places. The operator should
 * see where the update lands and what they will notice there, not implementation
 * details about how those places are connected.
 */
import type { ServerVersion, SkewVerdict, UpdateNotes } from '@podium/protocol'
/**
 * THE SUBPATH IS LOAD-BEARING (POD-2241, POD-2190).
 *
 * Everything else this file needs from the protocol is a TYPE, which costs a
 * bundle nothing. The refusal table is a value, and reaching it through the
 * barrel pulls the entire wire schema into the update chunk — the chunk that
 * was deliberately split out to keep 99 KB off the first paint. Measured: the
 * chunk's cold import went from ~250 ms to ~3 s, and `updates-context.test.tsx`
 * timed out waiting for the panel to appear. The table imports nothing, so
 * through its own entrypoint it costs one module.
 */
import type { MachineFailureCode } from '@podium/protocol/update-refusal'
import {
  CODE_FOR_UPDATE_FAILURE_TOKEN,
  matchUpdateFailureToken,
} from '@podium/protocol/update-refusal'

/**
 * `phone` is the Expo website at /mobile. It is always ANOTHER device from the
 * dialog's point of view: this dialog ships in the desktop shell, and the phone
 * shell does not render it — so the row describes something the operator will
 * pick up later, never the page they are reading.
 */
export type PlaceKind = 'this-app' | 'phone' | 'server' | 'machines'

export interface Place {
  kind: PlaceKind
  label: string
  effect: string
}

/**
 * THE OFFER, and nothing else (POD-2102).
 *
 * `in-progress` and `failed` used to live here, computed from the fleet
 * snapshot — one of the three competing progress models spec §1.2 catalogues.
 * They are gone: once an update starts it IS an operation, and the operation
 * says what is happening (`operation-view.ts`). What is left is the question
 * only the client can answer before anything starts — "what would this update
 * touch, and what will you notice where" — which this file has always answered
 * well and keeps answering.
 */
export type UpdateView =
  | { state: 'none' }
  | { state: 'checking' }
  | { state: 'current'; version: string }
  | { state: 'local-stale'; version: string }
  | {
      state: 'available' | 'required'
      version: string
      places: Place[]
      notes?: { summary?: string; url?: string }
      restartNote: string
      reason?: string
    }

export interface DesktopUpdateInfo {
  version: string
  critical: boolean
  notes?: string | null
}

export interface UpdateInput {
  localVersion: string
  server: ServerVersion
  surface: 'web' | 'desktop-all-in-one' | 'desktop-remote' | 'mobile'
  serverName?: string
  fleet: {
    total: number
    behind: number
    converging: number
    failed: number
    preparation?: {
      webReady: boolean
      bundleReady: boolean
      failureDetail?: string
    }
    startability?: { startable: true } | { startable: false; reason: string }
    machines?: readonly { name?: string; version?: string; state: string; detail?: string }[]
  }
  touched: { app: boolean; server: boolean; machines: boolean; phone: boolean }
  skew: SkewVerdict
  desktopUpdate?: DesktopUpdateInfo
}

function machineLabel(count: number): string {
  return `${count} machine${count === 1 ? '' : 's'}`
}

function affectedMachineLabel(input: UpdateInput): string {
  const targetVersion = input.server.target?.version
  const names = (input.fleet.machines ?? [])
    .filter((machine) => targetVersion === undefined || machine.version !== targetVersion)
    .flatMap((machine) => (machine.name ? [machine.name] : []))
  if (names.length === 0) return machineLabel(input.fleet.behind)

  const shown = names.slice(0, 3)
  const remaining = Math.max(0, input.fleet.behind - shown.length)
  return remaining > 0 ? shown.join(', ') + ', and ' + remaining + ' more' : shown.join(', ')
}

function targetNotes(
  notes: UpdateNotes | undefined,
): { summary?: string; url?: string } | undefined {
  if (!notes) return undefined
  return {
    ...(notes.summary !== undefined ? { summary: notes.summary } : {}),
    ...(notes.url !== undefined ? { url: notes.url } : {}),
  }
}

/**
 * `touched` describes what the advertised target would move. A wire-skew
 * verdict describes something stronger: which running half must move before
 * this client/server pair is safe to use. Keep that recovery fact in the view
 * model so a same-label skew cannot produce an empty affected-place list.
 */
function affectedPlaces(input: UpdateInput): UpdateInput['touched'] {
  return {
    app: input.touched.app || input.skew === 'client-too-old' || input.skew === 'schema-skew',
    server: input.touched.server || input.skew === 'client-too-new' || input.skew === 'schema-skew',
    machines: input.touched.machines,
    phone: input.touched.phone,
  }
}

function restartNote(input: UpdateInput): string {
  if (input.skew === 'schema-skew') {
    if (input.surface === 'web') {
      const server = input.serverName ? `Podium on ${input.serverName}` : 'Podium on the server'
      return (
        'Rebuild the web app with `bun run build`, then restart ' +
        `${server} so the app and server load the same schema. Your sessions keep running.`
      )
    }

    if (input.surface === 'desktop-all-in-one') {
      return 'Install or rebuild Podium, then restart it so its app and server load the same schema. Your sessions keep running.'
    }

    const server = input.serverName ? `Podium on ${input.serverName}` : 'Podium on the server'
    return (
      'Update or rebuild this app, then restart ' +
      `${server} so the app and server load the same schema. Your sessions keep running.`
    )
  }

  const affected = affectedPlaces(input)
  const noRestartNeeded = !affected.app && !affected.server
  if (noRestartNeeded) return 'No restart needed. Your sessions keep running.'
  return 'Your sessions keep running.'
}

function appPlace(input: UpdateInput): Place {
  const effect =
    input.surface === 'desktop-all-in-one' ? 'will refresh, about 5 seconds' : 'will refresh'
  return { kind: 'this-app', label: 'This app', effect }
}

function placesFor(input: UpdateInput): Place[] {
  const places: Place[] = []
  const affected = affectedPlaces(input)

  // Dev channel: forensic `dev+<sha>` identity OR a publisher mint
  // (`<base>.dev.<N>+<sha>`, POD-2502). Both mean the page follows this server.
  const targetVersion = input.server.target?.version ?? ''
  const isDevChannelTarget =
    targetVersion.startsWith('dev+') ||
    /\.dev\.\d+\+[0-9a-f]{7,40}$/i.test(targetVersion) ||
    /^\d+\.\d+\.\d+-dev\.\d+\+[0-9a-f]{7,40}$/i.test(targetVersion)

  const sourceAppAndServer =
    affected.app &&
    affected.server &&
    (input.surface === 'web' || input.surface === 'mobile') &&
    isDevChannelTarget

  if (sourceAppAndServer) {
    const server = input.serverName ? `your server (${input.serverName})` : 'your server'
    places.push({
      kind: 'server',
      label: `This app and ${server}`,
      effect:
        input.skew === 'schema-skew'
          ? 'need matching builds and a restart'
          : 'will rebuild; this page will need to reload',
    })
  }

  // The all-in-one desktop shell is one place to the operator. Its embedded
  // server must not become a second row in the dialog.
  const appTouched = affected.app || (input.surface === 'desktop-all-in-one' && affected.server)
  if (appTouched && !sourceAppAndServer) places.push(appPlace(input))

  if (affected.server && input.surface !== 'desktop-all-in-one' && !sourceAppAndServer) {
    const label = input.serverName ? `Your server (${input.serverName})` : 'Your server'
    places.push({
      kind: 'server',
      label,
      effect:
        input.skew === 'schema-skew'
          ? 'needs a matching build and restart'
          : 'will briefly reconnect',
    })
  }

  // The phone website is rebuilt by the same unit as the desktop one, but the
  // operator is not holding the phone, so it gets its own row rather than being
  // folded into "This app" — and it says what they will have to do there.
  if (affected.phone) {
    places.push({
      kind: 'phone',
      label: 'Podium on your phone',
      effect: 'will rebuild; reload it there',
    })
  }

  // Only the dev wave belongs here: this dialog's ONE action grants that
  // authority alone, so naming an edge/stable machine would promise a move it
  // cannot make. Those machines act from their own Settings row.
  if (input.touched.machines && input.fleet.behind > 0) {
    places.push({
      kind: 'machines',
      label: affectedMachineLabel(input),
      effect: 'will not be interrupted',
    })
  }

  return places
}

/** A short git SHA is the source-host web identity, not a packaged web artifact. */
function isSourceWebDigest(digest: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(digest)
}

/**
 * True when this app is the only place and its update comes from the desktop
 * release feed rather than the server's target. Verified against the live dev
 * coordinator, whose target publishes `headless` artifacts only.
 *
 * POD-2106 came to delete this as version-namespace guesswork the operation
 * model made unnecessary, and it is not: operations describe an update already
 * under way, while this runs earlier, on the OFFER, to pick which of two
 * version streams to name. Both arms are pinned by tests — forcing either to
 * `false` reds `update-view.test.ts` — so it stays until something replaces the
 * two-streams problem itself rather than the code that copes with it.
 */
function appOnlyFromReleaseFeed(input: UpdateInput): boolean {
  if (input.desktopUpdate === undefined) return false
  if (input.server.target?.artifacts.desktop) return false
  const webDigest = input.server.target?.artifacts.web?.digest
  if (webDigest !== undefined && !isSourceWebDigest(webDigest)) return false
  const places = placesFor(input)
  return places.length > 0 && places.every((place) => place.kind === 'this-app')
}

function skewReason(skew: SkewVerdict): string | undefined {
  switch (skew) {
    case 'client-too-new':
      return 'Your server is behind this app. Update your server to continue.'
    case 'client-too-old':
      return 'This app needs an update to continue.'
    case 'schema-skew':
      return 'This page and your server are out of sync.'
    default:
      return undefined
  }
}

/**
 * What this file says when it recognized NOTHING. Exported because the caller
 * has to be able to tell "translated" from "gave up": a §7 error carrying its
 * own user-facing sentence should show that sentence rather than this one.
 */
export const UNTRANSLATED_FAILURE_MESSAGE = 'Podium could not finish the update.'

export interface FailedUpdateView {
  state: 'failed'
  message: string
  guidance: string
  diagnostic?: string
}

/** What happened, and the one thing to do about it. §7's first two layers. */
export interface MachineFailureCopy {
  message: string
  nextAction: string
}

/**
 * THE ONLY PLACE A MACHINE FAILURE BECOMES WORDS (POD-2241).
 *
 * There used to be two: this file translated a raw daemon sentence, and
 * `operation-view.ts` translated the code the server had derived from the same
 * sentence — so the same refusal read one way on the ActionError path and
 * another on the operation path, and an arm added to one was half a fix. The
 * classification now happens once, in `@podium/protocol`, and the copy happens
 * once, here. Both entry points call this.
 *
 * A `Record` and not a `switch`, deliberately: a code added to
 * {@link MachineFailureCode} reds this file until somebody writes the sentence
 * a human will read. A convention asking the next person to remember is not an
 * instrument that can say no; a missing key is.
 *
 * `subject` is the machine's name when one is known. Each arm chooses its own
 * fallback, because "A machine", "This machine" and "Podium" are not
 * interchangeable in these sentences.
 */
const MACHINE_FAILURE_COPY: Record<
  MachineFailureCode,
  (subject: string | undefined) => MachineFailureCopy
> = {
  'machine-dirty-checkout': (subject) => ({
    message: `${subject ?? 'A machine'} has local files or edits that prevent a safe update.`,
    nextAction: `Commit, stash, move, or locally exclude those files on ${subject ?? 'that machine'}, then try again.`,
  }),
  'machine-unsupported': (subject) => ({
    message: `${subject ?? 'A machine'} cannot use this update's package.`,
    nextAction:
      "Ask the server operator to check the release includes that machine's platform and " +
      'delivery method, then try again.',
  }),
  /**
   * THE ONLY ARM THAT MAY SAY "STOPPED RESPONDING". It reads as the truth for
   * exactly one input — a machine that went quiet — and as a confident lie for
   * every other sentence in the table, which is what POD-2210 and POD-2240 both
   * were. Keep it narrow.
   */
  'machine-unreachable': (subject) => ({
    message: `${subject ?? 'A machine'} stopped responding while updating.`,
    nextAction:
      'Podium stopped waiting for it. Check that machine is running, then apply the update ' +
      'again from Settings → Machines.',
  }),
  /**
   * THE FIRST FAILURE WHOSE NEXT ACTION WAS NOT "TRY AGAIN" (POD-2210).
   *
   * A Podium started as a single foreground process — `podium all`, or a bare
   * `podium` on a box with no persistence — is server and daemon in one PID
   * with nothing to restart it, so its daemon refuses rather than exiting into
   * a server that never comes back. Trying again refuses identically: the
   * answer is in the operator's terminal, not in this panel.
   *
   * "Nothing was changed" leads, because it is the question a person asks
   * before they decide whether it is safe to restart it. Then both ways out, in
   * the order a person wants them: the one that takes five seconds, and the one
   * that makes it not happen again.
   */
  'machine-cannot-restart': (subject) => ({
    message:
      `${subject ? `Podium on ${subject}` : 'Podium here'} is running as a single foreground ` +
      'process, so it cannot update itself. Nothing was changed.',
    nextAction:
      'Stop it in the terminal it is running in and start it again to pick up this update — or ' +
      'run `podium setup` there to install it as a service, which can update itself without ' +
      'going down.',
  }),
  /**
   * THE REFUSAL THAT KEPT A MACHINE ALIVE (POD-2213), IN ITS THREE KINDS
   * (POD-2233, POD-2239).
   *
   * Migrations are forward-only, so an older build cannot open a database a
   * newer one has already migrated — it refuses to start, and the thing that
   * would put the newer build back is the server that will not start. The
   * daemon declines the downgrade before swapping anything.
   *
   * THREE ARMS, NOT ONE, because they are three different states of knowledge
   * and §7 forbids a failure asserting what it has not established. Collapsing
   * them made the panel claim what the daemon had deliberately refused to claim.
   */
  'machine-schema-advanced': (subject) => ({
    // Both halves established: the refusal named an applied migration the
    // target does not define, so the target IS behind and WOULD refuse to open.
    message:
      `${subject ?? 'A machine'} was asked to move to an older version that cannot open the ` +
      'data it already has. Nothing was changed and Podium is still running there.',
    nextAction:
      'Pick a version at least as new as the one it is on — or, if you really need the older ' +
      'one, restore a database backup from before the upgrade by hand first ' +
      '(docs/data-and-upgrades.md).',
  }),
  /**
   * The arm that asserts LEAST. Neither half is established: the target did not
   * declare what it can open and could not be proved newer, so "older" and
   * "cannot open" are both guesses. And no advice to pick something newer,
   * which is not merely unproven but unachievable — a coordinator on a source
   * build reports `dev+<sha>`, which orders against nothing published, so every
   * choice returns here. The action that exists belongs to the release.
   */
  'machine-schema-unknown': (subject) => ({
    message:
      `${subject ?? 'A machine'} was asked to move to a version that does not say which data ` +
      'it can open, so nothing here could tell whether it would start. Nothing was changed and ' +
      'Podium is still running there.',
    nextAction:
      'Ask the server operator for a release that declares which data it can open — that is ' +
      'what settles this. A machine running a development build cannot order itself against ' +
      'published versions, so choosing a different one will not.',
  }),
  'machine-schema-unreadable': (subject) => ({
    // Says nothing about the target at all — the database could not be read.
    // The only one of the three where "try again" is right, because a read that
    // lost to a lock or a permission can win next time.
    message:
      `${subject ?? 'A machine'} could not read its own database, so nothing here could tell ` +
      'whether that version would start against it. Nothing was changed and Podium is still ' +
      'running there.',
    nextAction:
      'Check that database file and its disk on that machine — the technical detail below says ' +
      'why the read failed — then try again.',
  }),
  /**
   * THE FOUR CODES THE UNREACHABLE DEFAULT USED TO ANSWER FOR (POD-2241).
   *
   * Every sentence behind these was written by a machine that was running and
   * answering, and every one of them used to arrive as "stopped responding,
   * check it's running; it will resume when it reconnects" — a claim that was
   * false when made and that could never become true.
   */
  'machine-delivery-failed': (subject) => ({
    message:
      `${subject ?? 'A machine'} could not put this update in place. Nothing was changed there ` +
      'and Podium is still running.',
    nextAction:
      'The technical detail below names the step that failed. Try again, and if it keeps ' +
      "failing check that machine's checkout and its disk.",
  }),
  'machine-delivery-unavailable': (subject) => ({
    // NO "try again": these are properties of the release or the pairing, not
    // of a moment, so a retry is guaranteed to return here.
    message:
      `This update cannot be delivered to ${subject ?? 'a machine'} as configured. Nothing was ` +
      'changed there.',
    nextAction:
      "Ask the server operator to check the release and that machine's pairing — trying again " +
      'will not change this on its own.',
  }),
  'machine-artifact-rejected': (subject) => ({
    // The one failure where "try again" is bad advice rather than merely
    // useless: what arrived was not what was signed.
    message:
      `The update package failed verification on ${subject ?? 'a machine'}, so Podium refused ` +
      'to install it. Nothing was changed there.',
    nextAction:
      'Ask the server operator to re-publish the release before applying it again — what ' +
      'arrived was not what was signed.',
  }),
  'machine-update-not-confirmed': (subject) => ({
    // Reported BY THAT MACHINE'S OWN BOOT, so it is up and connected. Nothing
    // here claims why the new version did not start; the detail says how far it
    // got.
    message:
      `${subject ?? 'A machine'} took this update but did not come back on the new version, ` +
      'and is running again on the version it had.',
    nextAction:
      "Check that machine's log for why the new version did not start — the technical detail " +
      'below says how far it got.',
  }),
  'update-withdrawn': (subject) => ({
    message:
      `The server withdrew this update while ${subject ?? 'a machine'} was still applying it, ` +
      'so nothing was changed there.',
    nextAction:
      'The detail below is the reason the server gave. Apply the update again once it is ' +
      'publishing one.',
  }),
  'download-failed': () => ({
    // Deliberately subject-free: this is about the bytes, not about a machine,
    // and naming one would accuse the wrong thing.
    message: 'Podium could not download this update.',
    nextAction: 'Check the connection, then try the update again.',
  }),
}

/**
 * The copy for a failure code, or `undefined` when the code is not one of this
 * table's — a desktop-shell code, or one from a server newer than this bundle.
 *
 * `undefined` is what lets `operation-view.ts` keep degrading an unknown code
 * to the server's own sentence instead of to a blank panel (P8).
 */
export function machineFailureCopy(code: string, subject?: string): MachineFailureCopy | undefined {
  const arm = (
    MACHINE_FAILURE_COPY as Record<string, ((s?: string) => MachineFailureCopy) | undefined>
  )[code]
  return arm?.(subject)
}

/**
 * Translate a raw failure sentence — from a daemon, the grant path, the boot
 * reconciler, or the service's own timeout — into what an operator reads.
 *
 * Still here, and still worth its keep, even though failures now arrive as
 * TYPED codes on the operation (§7): a server older than the taxonomy — or any
 * kind that reports a bare sentence — still produces free text. What changed in
 * POD-2241 is that it is no longer a SECOND classifier. It matches the token
 * with `@podium/protocol`'s table, which the server uses too, and renders the
 * same copy the code path renders. There is one reading of one sentence.
 */
export function describeUpdateFailure(detail?: string, machineName?: string): FailedUpdateView {
  const normalized = detail?.trim()
  const token = matchUpdateFailureToken(normalized)
  if (token !== undefined) {
    const copy = machineFailureCopy(CODE_FOR_UPDATE_FAILURE_TOKEN[token], machineName)
    // Unreachable in practice — the table's codes are exactly this file's keys,
    // and TypeScript holds that — but the fall-through below is the honest
    // answer if it ever stops being true, rather than a thrown renderer.
    if (copy) {
      return {
        state: 'failed',
        message: copy.message,
        guidance: copy.nextAction,
        ...(normalized ? { diagnostic: normalized } : {}),
      }
    }
  }

  return {
    state: 'failed',
    message: UNTRANSLATED_FAILURE_MESSAGE,
    guidance: 'Try again. If it still fails, share the details below with the server operator.',
    ...(normalized ? { diagnostic: normalized } : {}),
  }
}

export function describeUpdate(input: UpdateInput): UpdateView {
  const target = input.server.target
  const version = appOnlyFromReleaseFeed(input)
    ? // The server's target and the desktop app's release feed are DIFFERENT
      // version streams. When the only place is this app and the target
      // carries no artifact for it (the dev bundle publishes `headless`
      // only), the target's label names a version this dialog's action will
      // not install — the release feed's does.
      (input.desktopUpdate?.version ?? input.localVersion)
    : (target?.version ??
      input.desktopUpdate?.version ??
      input.server.appVersion ??
      input.localVersion)

  const required =
    input.skew !== 'ok' || target?.critical === true || input.desktopUpdate?.critical === true
  const places = placesFor(input)
  if (!required && places.length === 0) return { state: 'none' }
  if (input.fleet.startability?.startable === false && input.desktopUpdate === undefined) {
    return { state: 'local-stale', version }
  }

  const result: Extract<UpdateView, { state: 'available' | 'required' }> = {
    state: required ? 'required' : 'available',
    version,
    places,
    restartNote: restartNote(input),
  }

  const targetUpdateNotes = targetNotes(target?.notes)
  const desktopNotes = input.desktopUpdate?.notes
    ? { summary: input.desktopUpdate.notes }
    : undefined
  const notes = targetUpdateNotes ?? desktopNotes
  if (notes !== undefined) result.notes = notes

  const reason = skewReason(input.skew)
  if (reason !== undefined) result.reason = reason

  return result
}
