import type { AuthCapabilities } from '@podium/client-core/accounts'
export const passwordCapabilities: AuthCapabilities = {
  version: 1,
  passwordSignIn: true,
  providers: [],
  selfSignUp: false,
  invitationDelivery: 'link',
  passwordReset: 'admin-link',
  emailVerification: false,
  organisations: false,
  sameMachineSignIn: true,
  adminSignOutEverywhere: true,
  adminEndDeviceSignIn: true,
  accountUrl: null,
}
export const accountCapabilities: AuthCapabilities = {
  ...passwordCapabilities,
  providers: ['google', 'github'],
  selfSignUp: true,
  invitationDelivery: 'mail',
  passwordReset: 'mail',
  emailVerification: true,
  organisations: true,
  sameMachineSignIn: false,
  adminSignOutEverywhere: false,
  adminEndDeviceSignIn: false,
  accountUrl: 'https://accounts.example/account',
}
