/** The capability list (specification, section 2.9): fixed for the life of a process. */
import type { Capabilities, IdentityConfig } from './types'

export function capabilitiesOf(config: IdentityConfig): Capabilities {
  const providers: Capabilities['providers'] = []
  if (config.loginMethods.google) providers.push('google')
  if (config.loginMethods.github) providers.push('github')
  const mails = config.mail !== null
  const local = config.accounts === 'local'
  return {
    version: 1,
    passwordSignIn: config.loginMethods.password,
    providers,
    selfSignUp: config.selfSignUp,
    invitationDelivery: mails ? 'mail' : 'link',
    passwordReset: mails ? 'mail' : 'admin-link',
    emailVerification: mails,
    organisations: (config.libraryRoutes?.extensions ?? []).some(
      (extension) => extension.id === 'organization',
    ),
    sameMachineSignIn: config.sameMachine !== null,
    // A device sign-in of a shared account also serves the person's other
    // workspaces, so there an admin ends none of them.
    adminSignOutEverywhere: local,
    adminEndDeviceSignIn: local,
    accountUrl: config.hosts.kind === 'fixed' ? `${config.hosts.appOrigin}/account` : null,
  }
}
