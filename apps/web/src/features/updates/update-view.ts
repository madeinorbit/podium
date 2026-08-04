/**
 * The update dialog's content model. This is pure so the language and the list
 * of places stay testable without rendering a browser surface.
 *
 * Podium is one product with one version running in places. The operator should
 * see where the update lands and what they will notice there, not implementation
 * details about how those places are connected.
 */
import type { ServerVersion, SkewVerdict, UpdateNotes } from '@podium/protocol'

export type PlaceKind = 'this-app' | 'server' | 'machines'

export interface Place {
  kind: PlaceKind
  label: string
  effect: string
}

export type UpdateView =
  | { state: 'none' }
  | {
      state: 'available' | 'required'
      version: string
      places: Place[]
      notes?: { summary?: string; url?: string }
      restartNote: string
      reason?: string
    }
  | { state: 'in-progress'; version: string; done: number; total: number }
  | { state: 'failed'; detail: string }

export interface UpdateInput {
  localVersion: string
  server: ServerVersion
  surface: 'web' | 'desktop-all-in-one' | 'desktop-remote' | 'mobile'
  serverName?: string
  fleet: { total: number; behind: number; converging: number; failed: number }
  touched: { app: boolean; server: boolean; machines: boolean }
  skew: SkewVerdict
}

function machineLabel(count: number): string {
  return `${count} machine${count === 1 ? '' : 's'}`
}

function targetNotes(notes: UpdateNotes | undefined): { summary?: string; url?: string } | undefined {
  if (!notes) return undefined
  return {
    ...(notes.summary !== undefined ? { summary: notes.summary } : {}),
    ...(notes.url !== undefined ? { url: notes.url } : {}),
  }
}

function restartNote(input: UpdateInput): string {
  const noRestartNeeded = !input.touched.app && !input.touched.server
  if (noRestartNeeded) return 'No restart needed. Your sessions keep running.'
  return 'Your sessions keep running.'
}

function appPlace(input: UpdateInput): Place {
  const effect = input.surface === 'desktop-all-in-one' ? 'will refresh, about 5 seconds' : 'will refresh'
  return { kind: 'this-app', label: 'This app', effect }
}

function placesFor(input: UpdateInput): Place[] {
  const places: Place[] = []

  // The all-in-one desktop shell is one place to the operator. Its embedded
  // server must not become a second row in the dialog.
  const appTouched =
    input.touched.app ||
    (input.surface === 'desktop-all-in-one' && input.touched.server)
  if (appTouched) places.push(appPlace(input))

  if (input.touched.server && input.surface !== 'desktop-all-in-one') {
    const label = input.serverName ? `Your server (${input.serverName})` : 'Your server'
    places.push({ kind: 'server', label, effect: 'will briefly reconnect' })
  }

  if (input.touched.machines && input.fleet.behind > 0) {
    places.push({
      kind: 'machines',
      label: machineLabel(input.fleet.behind),
      effect: 'will not be interrupted',
    })
  }

  return places
}

function skewReason(skew: SkewVerdict): string | undefined {
  switch (skew) {
    case 'client-too-new':
      return 'Your server is behind this app. Update your server to continue.'
    case 'client-too-old':
      return 'This app needs an update to continue.'
    case 'schema-skew':
      return 'This app and your server need compatible builds.'
    default:
      return undefined
  }
}

export function describeUpdate(input: UpdateInput): UpdateView {
  const target = input.server.target
  const version = target?.version ?? input.server.appVersion ?? input.localVersion

  if (input.fleet.failed > 0) {
    return {
      state: 'failed',
      detail: `${machineLabel(input.fleet.failed)} could not update.`,
    }
  }

  if (input.fleet.converging > 0) {
    const total = Math.max(input.fleet.total, input.fleet.converging + input.fleet.behind)
    const done = Math.max(0, total - input.fleet.behind - input.fleet.converging)
    return { state: 'in-progress', version, done, total }
  }

  const required = input.skew !== 'ok' || target?.critical === true
  const places = placesFor(input)
  if (!required && places.length === 0) return { state: 'none' }

  const result: Extract<UpdateView, { state: 'available' | 'required' }> = {
    state: required ? 'required' : 'available',
    version,
    places,
    restartNote: restartNote(input),
  }

  const notes = targetNotes(target?.notes)
  if (notes !== undefined) result.notes = notes

  const reason = skewReason(input.skew)
  if (reason !== undefined) result.reason = reason

  return result
}
