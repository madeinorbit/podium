/**
 * THE CREDENTIAL TYPE REGISTRY (credential management spec §5).
 *
 * A type says what a kind of credential IS: who the provider is, where its
 * secret lives, whether it renews itself, how one comes into being, whether
 * sharing it needs a warning, and what removing it does at the provider. It is
 * code, not data: adding a type is a change here, reviewed like any other.
 *
 * What a type is ACCEPTED BY is not here. Each consumer (a harness adapter,
 * direct inference) declares the types it takes in `accepts.ts`'s vocabulary,
 * and whether a credential can be used somewhere is the match between the two
 * (spec §3 R2). There is no compatibility table to maintain.
 */

export const CREDENTIAL_TYPE_IDS = [
  'anthropic.api-key',
  'anthropic.claude-login',
  'anthropic.claude-token',
  'openai.api-key',
  'openai.chatgpt-login',
  'openai.chatgpt-plan',
  'openrouter.api-key',
  'google.api-key',
  'google.antigravity-login',
] as const

export type CredentialTypeId = (typeof CREDENTIAL_TYPE_IDS)[number]

export function isCredentialTypeId(value: string): value is CredentialTypeId {
  return (CREDENTIAL_TYPE_IDS as readonly string[]).includes(value)
}

export type CredentialObtain = 'paste' | 'harness-sign-in' | 'found-on-machine' | 'oauth' | 'issued'

export interface CredentialTypeSpec {
  id: CredentialTypeId
  provider: string
  /** What a person reads: "Claude subscription token". */
  title: string
  /** `vault`: encrypted on the server. `home`: a login in a harness home on a machine. */
  store: 'vault' | 'home'
  /** Vault types only. A home login is renewed by its harness, so it has none. */
  renewal?: 'none' | 'expires' | 'podium'
  obtain: readonly CredentialObtain[]
  /** `warn`: an additional warning before sharing it (spec §12). */
  sharing: 'free' | 'warn'
  /** What removing it does at the provider. */
  revocation: 'none' | 'sign-out' | 'provider-call'
}

export const CREDENTIAL_TYPES: Readonly<Record<CredentialTypeId, CredentialTypeSpec>> = {
  'google.api-key': {
    id: 'google.api-key',
    provider: 'google',
    title: 'Gemini API key',
    store: 'vault',
    renewal: 'none',
    obtain: ['paste'],
    sharing: 'free',
    revocation: 'none',
  },
  'google.antigravity-login': {
    id: 'google.antigravity-login',
    provider: 'google',
    title: 'Google AI subscription login',
    store: 'home',
    obtain: ['harness-sign-in', 'found-on-machine'],
    sharing: 'warn',
    revocation: 'sign-out',
  },
  'anthropic.api-key': {
    id: 'anthropic.api-key',
    provider: 'anthropic',
    title: 'Anthropic API key',
    store: 'vault',
    renewal: 'none',
    obtain: ['paste'],
    sharing: 'free',
    revocation: 'none',
  },
  'anthropic.claude-login': {
    id: 'anthropic.claude-login',
    provider: 'anthropic',
    title: 'Claude subscription login',
    store: 'home',
    obtain: ['harness-sign-in', 'found-on-machine'],
    sharing: 'warn',
    revocation: 'sign-out',
  },
  'anthropic.claude-token': {
    id: 'anthropic.claude-token',
    provider: 'anthropic',
    title: 'Claude subscription token',
    store: 'vault',
    renewal: 'expires',
    obtain: ['paste'],
    sharing: 'warn',
    revocation: 'none',
  },
  'openai.api-key': {
    id: 'openai.api-key',
    provider: 'openai',
    title: 'OpenAI API key',
    store: 'vault',
    renewal: 'none',
    obtain: ['paste'],
    sharing: 'free',
    revocation: 'none',
  },
  'openai.chatgpt-login': {
    id: 'openai.chatgpt-login',
    provider: 'openai',
    title: 'ChatGPT login in Codex',
    store: 'home',
    obtain: ['harness-sign-in', 'found-on-machine'],
    sharing: 'warn',
    revocation: 'sign-out',
  },
  'openai.chatgpt-plan': {
    id: 'openai.chatgpt-plan',
    provider: 'openai',
    title: 'ChatGPT plan',
    store: 'vault',
    renewal: 'podium',
    obtain: ['oauth'],
    sharing: 'warn',
    revocation: 'provider-call',
  },
  'openrouter.api-key': {
    id: 'openrouter.api-key',
    provider: 'openrouter',
    title: 'OpenRouter API key',
    store: 'vault',
    renewal: 'none',
    obtain: ['paste'],
    sharing: 'free',
    revocation: 'none',
  },
}
