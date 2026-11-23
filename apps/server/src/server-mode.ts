/**
 * HOSTED OR SELF-HOSTED: ONE VALUE, ONE DERIVATION (POD-7308; POD-6954 design
 * 4.2 and 4.12).
 *
 * A composition root says which kind of server it starts with
 * `startServer({ mode })`. Nothing else decides it: the identity seam, a
 * workspace id, the database URL and the cloud-runtime provider are each their
 * own input and none of them is read as "this server is hosted". Features do
 * not ask the mode either; they ask the capability object below, which is
 * derived from it here and nowhere else.
 *
 * Hosted turns off every shortcut that trusts the machine the server runs on.
 * On a hosted server that machine belongs to the operator of the service, not
 * to any workspace's members, so "the request came from this computer" or
 * "the person who installed it" names nobody a workspace can vouch for.
 */
import { TRPCError } from '@trpc/server'

export type ServerMode = 'self-hosted' | 'hosted'

export const SERVER_MODES: readonly ServerMode[] = ['self-hosted', 'hosted']

/** What a server may do, given its mode and whether it has a machine of its own. */
export interface ServerCapabilities {
  readonly mode: ServerMode
  /**
   * The server belongs to a fleet machine of its own (POD-7225). A hosted
   * server never has one; a self-hosted server has one unless its root says
   * otherwise.
   */
  readonly hostMachine: boolean
  /**
   * A request from this computer may act without a sign-in: the same-machine
   * rule, the `authOpenMode` waiver behind it, and the host-local setup
   * bootstrap. Needs the server's own machine, so it is never on when hosted.
   */
  readonly sameMachineTrust: boolean
  /**
   * The user-only unix control socket and everything served on it: the public
   * URL and tunnel reports, `podium setup`'s login password, member recovery
   * links, and host sign-in (`podium auth mint-session`). Hosted creates no
   * socket file at all.
   */
  readonly controlSocket: boolean
  /** Host sign-in on the control socket: a device sign-in for this computer's CLI. */
  readonly hostSignIn: boolean
  /**
   * Acting as the workspace's earliest admin when the request names nobody:
   * the setup bootstrap's principal and the control socket's password and
   * recovery commands.
   */
  readonly earliestAdminDefault: boolean
  /**
   * A person calling the lock commands without an agent session holds the
   * lease as the one shared `operator`. Hosted has many people per workspace
   * and no single operator, so such a call is refused.
   */
  readonly operatorLocks: boolean
  /** The first-run setup routes under `/setup/*`. */
  readonly setupRoutes: boolean
  /** Reconfiguring or restarting the server's own installation through `setup.*`. */
  readonly hostSetup: boolean
  /** Publishing development releases from this server's source checkout. */
  readonly devUpdateFeed: boolean
  /**
   * The installation holds exactly one workspace, so the installation's id can
   * name that workspace to devices (identity/replica-boundary.ts). A hosted
   * installation holds many, and only the request's bound workspace names one.
   */
  readonly installationNamesWorkspace: boolean
}

/**
 * THE derivation. `hostMachine: false` is POD-7225's option for a server
 * without a machine of its own; hosted implies it.
 */
export function serverCapabilities(
  input: { mode?: ServerMode | undefined; hostMachine?: false | undefined } = {},
): ServerCapabilities {
  const mode = input.mode ?? 'self-hosted'
  if (!SERVER_MODES.includes(mode)) throw new Error(`unknown server mode '${String(mode)}'`)
  if (mode === 'hosted') {
    return {
      mode,
      hostMachine: false,
      sameMachineTrust: false,
      controlSocket: false,
      hostSignIn: false,
      earliestAdminDefault: false,
      operatorLocks: false,
      setupRoutes: false,
      hostSetup: false,
      devUpdateFeed: false,
      installationNamesWorkspace: false,
    }
  }
  const hostMachine = input.hostMachine !== false
  return {
    mode,
    hostMachine,
    sameMachineTrust: hostMachine,
    controlSocket: true,
    hostSignIn: hostMachine,
    earliestAdminDefault: true,
    operatorLocks: true,
    setupRoutes: true,
    hostSetup: true,
    devUpdateFeed: hostMachine,
    installationNamesWorkspace: true,
  }
}

/** The capabilities of a server whose root said nothing: every self-hosted install. */
export const SELF_HOSTED_CAPABILITIES: ServerCapabilities = serverCapabilities()

/** A feature the hosted mode turns off, as a refusal names it. */
export type HostOnlyFeature = 'operator-lock' | 'host-setup'

const HOST_ONLY_FEATURE_TEXT: Record<HostOnlyFeature, string> = {
  'operator-lock': 'Holding a lock without an agent session',
  'host-setup': "Configuring the server's own installation",
}

/**
 * The typed refusal of a host-only feature on a hosted server. A tRPC error,
 * so every transport reports it as a precondition the caller cannot meet here.
 */
export class HostedModeRefusal extends TRPCError {
  readonly feature: HostOnlyFeature

  constructor(feature: HostOnlyFeature) {
    super({
      code: 'PRECONDITION_FAILED',
      message: `${HOST_ONLY_FEATURE_TEXT[feature]} is not available on a hosted server.`,
    })
    this.name = 'HostedModeRefusal'
    this.feature = feature
  }
}
