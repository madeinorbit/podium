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

  const sourceAppAndServer =
    affected.app &&
    affected.server &&
    (input.surface === 'web' || input.surface === 'mobile') &&
    (input.server.target?.version ?? '').startsWith('dev+')

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

/**
 * Keep transport and delivery vocabulary out of the primary failure message.
 * A short, sanitized diagnostic remains available for support and operators.
 *
 * Still here, and still worth its keep, even though failures now arrive as
 * TYPED codes on the operation (§7): a server older than the taxonomy — or any
 * kind that reports a bare sentence — still produces free text, and this is the
 * accumulated knowledge of what that free text tends to mean. It is the default
 * branch of `presentOperationError`, not a competing path.
 */
export function describeUpdateFailure(detail?: string, machineName?: string): FailedUpdateView {
  const normalized = detail?.trim()

  /**
   * THE ONE FAILURE WHOSE NEXT ACTION IS NOT "TRY AGAIN" (POD-2210).
   *
   * Podium started as a single foreground process — `podium all`, or a bare
   * `podium` on a box with no persistence — is server and daemon in one PID with
   * nothing to restart it. Its daemon therefore refuses the update outright
   * instead of exiting into a server that never comes back, and this is the
   * sentence that refusal becomes. FIRST, because it is the most specific match:
   * the generic delivery branches below would swallow it into "one or more
   * machines cannot use this update", which is both untrue and unactionable.
   *
   * The guidance names both ways out, in the order a person would want them: the
   * one that takes five seconds, and the one that makes the problem not happen
   * again.
   */
  if (normalized && /foreground[-_\s]all[-_\s]in[-_\s]one/i.test(normalized)) {
    const subject = machineName ? `Podium on ${machineName}` : 'Podium here'
    return {
      state: 'failed',
      message: `${subject} is running as a single foreground process, so it cannot update itself.`,
      guidance:
        'Nothing was changed. Stop it in the terminal it is running in and start it again to ' +
        'pick up this update — or run `podium setup` there to install it as a service, which ' +
        'can update itself without going down.',
      diagnostic:
        'The daemon shares its process with the server; updating it would have stopped the ' +
        'server with nothing to restart it.',
    }
  }

  if (normalized && /dirty[-_\s]working[-_\s]tree/i.test(normalized)) {
    const subject = machineName ?? 'A machine'
    const location = machineName ?? 'that machine'
    return {
      state: 'failed',
      message: subject + ' has local files or edits that prevent a safe update.',
      guidance:
        'Commit, stash, move, or locally exclude those files on ' + location + ', then try again.',
      diagnostic: 'Git delivery stopped because the checkout is not clean.',
    }
  }

  if (normalized && /unsupported[-_\s]delivery/i.test(normalized)) {
    return {
      state: 'failed',
      message: 'One or more machines cannot use this update.',
      guidance:
        'Ask the server operator to check the release package for those machines, then try again.',
      diagnostic: "The machines do not support this update's delivery method.",
    }
  }

  if (normalized && /(?:no[-_\s]artifact|unsupported[-_\s]platform)/i.test(normalized)) {
    return {
      state: 'failed',
      message: 'One or more machines cannot use this update.',
      guidance:
        'Ask the server operator to check the release package for those machines, then try again.',
      diagnostic: /unsupported[-_\s]platform/i.test(normalized)
        ? "The release does not support the machines' platform."
        : 'The release does not include an update package for the machines.',
    }
  }

  // A bounded wait that ran out is its own story: nothing is wrong with the
  // release, a machine simply stopped answering. Saying so — and saying the
  // update can be applied again — is the difference between a visible timeout
  // and a dialog that appears to have hung.
  if (normalized && /stopped reporting progress/i.test(normalized)) {
    return {
      state: 'failed',
      message: 'A machine stopped responding while updating.',
      guidance:
        'Podium stopped waiting for it. Check that machine is running, then apply the update ' +
        'again from Settings → Machines.',
      diagnostic: normalized,
    }
  }

  if (
    normalized &&
    /(?:unable to connect|access the url|failed to fetch|fetch failed|download timed out|network(?:error| request failed)|econn(?:refused|reset)|etimedout|enotfound)/i.test(
      normalized,
    )
  ) {
    return {
      state: 'failed',
      message: 'Podium could not reach the update source.',
      guidance: "Check this server's internet connection, then try the update again.",
      diagnostic: 'The update could not be downloaded.',
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
