/**
 * WHAT "RUNNING VERSION" MEANS ONCE THE COMPONENTS LEGITIMATELY DIFFER
 * (updater-convergence spec §2.2b, §8).
 *
 * Before the convergence work, a per-component breakdown was an ANOMALY SIGNAL:
 * settings showed one version, and the components only got their own rows when
 * they disagreed, because disagreeing meant something was wrong. That reading
 * dies with the redesign. The desktop shell carries its own artifact version and
 * is minted only when the frame itself changes (§2.2, §5) — on Development it
 * carries an EDGE version by design — so a shell that differs from the server is
 * the normal, correct state and must not read as a fault.
 *
 * So the rule inverts (§2.2b): agreement collapses to one line, and every
 * divergence is spelled out with a mark saying whether it is expected or worth
 * someone's attention.
 *
 * EVERY VERSION HERE COMES FROM THE ARTEFACT ITSELF. The server's from
 * `/version`, the page's from its own build stamp, the shell's from the bridge
 * (`CARGO_PKG_VERSION`, baked at build), the phone's from the served bundle's
 * stamp. None is derived from a sibling component or from the channel's target
 * — that inference is the bug §2.2b exists to forbid, because it makes the
 * display agree with itself exactly when the truth is that it should not.
 */

import { buildsDiffer } from '@podium/protocol'
import { formatDisplayedVersion, type SkewMark } from '@/lib/machine-version-skew'
import type { UiSource } from '@/lib/ui-source'
import { CHANNEL_LABELS, type FleetChannel } from './updates-view'

/** The same expected/unexpected question the machine rows answer. */
export type { SkewMark }

export interface ComponentVersionRow {
  key: 'server' | 'interface' | 'phone' | 'desktop'
  label: string
  /** Rendered in the machine voice — a version, or prose when there is none. */
  value: string
  /** Rendered before the value, in prose: which source served this component. */
  prefix?: string
  /** Why this row differs, in the user's words. Present only when it differs. */
  note?: string
  mark?: SkewMark
}

export interface ComponentVersionsInput {
  /** The coordinating server's own build, as `/version` reports it. */
  serverVersion?: string
  /** The coordinating server's source identity, independent of its display label. */
  serverDigest?: string
  /** This document: the build stamp it carries, and which layer served it. */
  page: { version: string; digest?: string; source: UiSource }
  /** The phone bundle this server serves (`servedWebIdentity`), if it has one. */
  phone?: { present: boolean; appVersion?: string; digest?: string }
  /** The desktop web dist's source digest — the phone's comparison partner. */
  servedWebDigest?: string
  /** The shell's own artifact version over the bridge. Absent in a browser. */
  desktopVersion?: string
  /** The fleet's channel, which decides what a trailing shell MEANS (§2.2). */
  channel: FleetChannel | null
}

export interface ComponentVersionsView {
  /**
   * The single "Podium <version>" line, or null when the breakdown has to
   * speak. Null while the server version is still unknown, too: a page that
   * cannot name the server cannot claim everything agrees with it.
   */
  single: string | null
  rows: ComponentVersionRow[]
}

const PHONE_UNREPORTED = 'Not reported'

/** The shell trails or leads its server by design; only the reason changes. */
function desktopNote(channel: FleetChannel | null): string {
  if (channel === 'dev') {
    return `${CHANNEL_LABELS.dev} runs the ${CHANNEL_LABELS.edge} app frame, so this is the version it is meant to have.`
  }
  return 'The app frame is released only when the frame itself changes, so it does not have to match the server.'
}

export function componentVersions(input: ComponentVersionsInput): ComponentVersionsView {
  const { serverVersion, serverDigest, page, phone, servedWebDigest, desktopVersion, channel } =
    input
  const rows: ComponentVersionRow[] = []
  /** Anything that must keep the breakdown open, whether or not it is a fault. */
  let divergent = false

  if (serverVersion) {
    rows.push({ key: 'server', label: 'Server', value: formatDisplayedVersion(serverVersion) })
  }

  const pageDiffers = buildsDiffer(
    { version: page.version, digest: page.digest },
    { version: serverVersion, digest: serverDigest },
  )
  const interfaceRow: ComponentVersionRow = {
    key: 'interface',
    label: 'Interface',
    value: formatDisplayedVersion(page.version),
    // An unknown source says nothing at all rather than putting "Not reported"
    // where the answer belongs: the build stamp beside it is still true.
    ...(page.source.kind === 'unknown' ? {} : { prefix: page.source.label }),
  }
  if (pageDiffers) {
    // Mid-rollout is the ordinary way to see this: the server swapped its dist
    // and this tab is still running the one it loaded. The skew notice already
    // offers the reload, so this row explains rather than alarms.
    interfaceRow.mark = 'expected'
    interfaceRow.note =
      'This window is running a different build from the server. Reloading picks up the server’s.'
    divergent = true
  } else if (page.source.note) {
    // Same build, but not from the server: worth saying, and not a fault.
    interfaceRow.mark = 'expected'
    interfaceRow.note = page.source.note
  }
  // Only the baked copy is a genuinely different artefact — it can be frozen at
  // whatever shipped. A cached copy of the SAME build is the offline layer doing
  // its job, and its build stamp is already compared above.
  if (page.source.kind === 'baked') divergent = true
  rows.push(interfaceRow)

  if (phone?.present) {
    const row: ComponentVersionRow = { key: 'phone', label: 'Phone', value: PHONE_UNREPORTED }
    // A digest is comparison evidence, not a product version: it can say
    // same-or-different without ever being printed, and it must not be dressed
    // up as the phone's version. It also catches what a version cannot — two
    // bundles carrying one version number but built from different source.
    const phoneDiffers = buildsDiffer(
      { version: phone.appVersion, digest: phone.digest },
      { version: serverVersion, digest: serverDigest },
    )
    const digestDiffers = buildsDiffer({ digest: phone.digest }, { digest: servedWebDigest })
    if (phone.appVersion) {
      row.value = formatDisplayedVersion(phone.appVersion)
      if (digestDiffers) {
        row.mark = 'unexpected'
        row.note = 'The phone interface on this server was built from different source.'
        divergent = true
      } else if (phoneDiffers) {
        row.mark = 'unexpected'
        row.note = 'The phone interface on this server is from a different build than the server.'
        divergent = true
      }
    } else if (phone.digest && servedWebDigest) {
      row.value = digestDiffers ? 'Different build from this window' : 'Same build as this window'
      if (digestDiffers) {
        row.mark = 'unexpected'
        row.note = 'The phone interface on this server was built from different source.'
        divergent = true
      }
    } else {
      // Present, unstamped: no verdict is available, and no verdict must never
      // be shown as agreement.
      row.note = 'This server does not report a version for its phone interface.'
      divergent = true
    }
    rows.push(row)
  }

  if (desktopVersion) {
    const row: ComponentVersionRow = {
      key: 'desktop',
      label: 'Desktop app',
      value: formatDisplayedVersion(desktopVersion),
    }
    if (serverVersion !== undefined && desktopVersion !== serverVersion) {
      row.mark = 'expected'
      row.note = desktopNote(channel)
      divergent = true
    }
    rows.push(row)
  }

  // Compared RAW, shown SHORT: the comparisons above decide identity and must
  // never be made on a label, while every string that reaches the screen goes
  // through the display form POD-2502 introduced.
  return {
    single: serverVersion && !divergent ? formatDisplayedVersion(serverVersion) : null,
    rows,
  }
}
