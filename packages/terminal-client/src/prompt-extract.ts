// Composer prompt-draft extraction moved to the shared, pure @podium/composer
// package (POD-859) so the daemon draft-sync engine reuses the exact same
// semantics. Re-exported here so the web fallback + session-mount keep importing
// it from terminal-client (barrel / relative) unchanged.
export { extractClaudePromptDraft, extractCodexPromptDraft } from '@podium/composer'
