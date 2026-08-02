/**
 * Harness-neutral transcript classifier engine.
 *
 * It knows only how to run an owning manifest's feature extractor and rule set;
 * provider keywords, transcript shapes, excerpts, and identities never enter core.
 * This module is intentionally absent from the package public barrel.
 */
export interface TranscriptClassifierRuleSet<Context, Features, Verdict> {
  extract(records: unknown[], context: Context): Features
  classify(features: Features): Verdict
}

export interface TranscriptClassifier<Context, Features, Verdict> {
  extract(records: unknown[], context: Context): Features
  classify(records: unknown[], context: Context): Verdict
}

export function createTranscriptClassifier<Context, Features, Verdict>(
  rules: TranscriptClassifierRuleSet<Context, Features, Verdict>,
): TranscriptClassifier<Context, Features, Verdict> {
  return {
    extract: (records, context) => rules.extract(records, context),
    classify: (records, context) => rules.classify(rules.extract(records, context)),
  }
}
