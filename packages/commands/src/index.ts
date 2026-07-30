/**
 * `@podium/commands` — L1 command CONTRACTS (ADR 3 D1).
 *
 * Contracts only. Handlers register against these from their L3 feature modules
 * and are joined at the composition root; nothing here may import a service, a
 * database or an app.
 *
 * SCOPE NOTE (POD-728): this package is the framework POD-311 specifies, landed
 * with agent-mail as its FIRST TENANT rather than with issues. POD-311 still owns
 * migrating the issue registry onto it, folding in the stranded protocol
 * contracts (`protocol/commands.ts` CommandDef, `messages/mutations.ts`
 * MutationEnvelope/MutationResult) and deriving the four transports from the
 * table. Those are deliberately NOT done here — see the commit message.
 */

export {
  type AnyCommandContract,
  type AttributionPolicy,
  type AuthoredAttribution,
  type OptimisticEffect,
  type CommandAction,
  type CommandContract,
  type CommandContractBase,
  type CommandPolicy,
  type CommandResource,
  type ConfirmationRule,
  type ContractInput,
  type CreationOwnership,
  classificationErrors,
  type DeliveryClass,
  type DeliveryPolicy,
  type ErrorConsistency,
  type MachineVerb,
  type OptimisticReducer,
  type RedactionPolicy,
  type RoleFloor,
  registryClassificationErrors,
  SERVED_NOWHERE,
  type TransportTag,
  type VisibilityClass,
} from './contract'
export {
  type AddressDeps,
  type AddressResolution,
  type HumanCeiling,
  type PlacementDecision,
  type PlacementDeps,
  placementDecision,
  resolveAddress,
  SINGLE_USER_CEILING,
  UNADDRESSABLE,
} from './mail/ceiling'
export {
  awaitAgentContract,
  awaitAgentInput,
  MAIL_CONTRACTS,
  type MailContractName,
  mailAskContract,
  mailAskInput,
  mailDismissContract,
  mailDismissInput,
  mailInboxConsumeContract,
  mailInboxInput,
  mailLedgerContract,
  mailLedgerInput,
  mailPendingRemindersContract,
  mailPendingRemindersInput,
  mailReplyContract,
  mailReplyInput,
  mailSendContract,
  mailSendInput,
  mailShowContract,
  mailShowInput,
  mailStatusContract,
  mailStatusInput,
  spawnAgentContract,
  spawnAgentInput,
} from './mail/contracts'
export {
  RENAME_REJECTIONS,
  type SessionRenameInput,
  type SessionRenameOutcome,
  sessionRenameContract,
  sessionRenameInput,
  sessionRenameReducer,
} from './sessions/rename'
export {
  deliversUnwrapped,
  exemptFromBrakes,
  isHumanPrincipal,
  type MailSenderPrincipal,
  operatorAddressee,
  senderBrakeKey,
  senderLabel,
} from './mail/principal'
export {
  EXPORTABLE_HARNESSES,
  type SessionHandoffInput,
  type SessionHandoffOutput,
  sessionHandoffContract,
  sessionHandoffInput,
  sessionHandoffOutput,
} from './sessions/handoff'
