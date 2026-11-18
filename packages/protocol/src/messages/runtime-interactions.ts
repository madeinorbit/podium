/**
 * THE INTERACTION CONTRACT, the browser-facing half of the Agent Runtime wire
 * (POD-2470). Its schemas are defined in `@podium/model`
 * (`entities/pending-interaction.ts`, served as `@podium/model/pending-interaction`), because the `pendingInteraction` record
 * is declared there with every other synced record type (POD-7084). This file
 * is the half of the runtime contract the common barrel serves; the
 * daemon-plane half is `./runtime.ts`, reachable only through
 * `@podium/protocol/daemon`.
 */

export type { InteractionAskSpec, RecoveryAskReason } from '@podium/model/pending-interaction'
export {
  ElicitationAnswer,
  ElicitationAsk,
  hasTranscriptCard,
  InteractionAnswer,
  InteractionAnswerability,
  InteractionAnsweredBy,
  InteractionAnswerOutcome,
  InteractionEvent,
  InteractionKind,
  InteractionSource,
  InteractionStatus,
  isResumeTimeRecovery,
  LoginAnswer,
  LoginAsk,
  PendingInteraction,
  PendingInteractionWire,
  PermissionAnswer,
  PermissionAsk,
  PlanApprovalAnswer,
  PlanApprovalAsk,
  QuestionAnswer,
  QuestionAsk,
  QuestionOption,
  QuestionPrompt,
  QuestionSelection,
  RESUME_TIME_RECOVERY_REASONS,
  RecoveryAnswer,
  RecoveryAsk,
  RecoveryChoice,
} from '@podium/model/pending-interaction'
