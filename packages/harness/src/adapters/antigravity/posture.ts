import type { PostureSection, UnmetRequirement } from '../../posture-types.js'

export const antigravityPosture: PostureSection = (launch, request) => {
  const unmet: UnmetRequirement[] = []
  const mode = request.posture.mode
  const native = mode === 'supervised' ? 'default' : mode === 'autonomous' ? 'auto' : mode.native
  const args: string[] = []
  if (native === 'auto') args.push('--mode', 'auto', '--sandbox')
  else if (native === 'always-proceed') args.push('--dangerously-skip-permissions')
  else if (['accept-edits', 'plan'].includes(native)) args.push('--mode', native)
  else if (native !== 'default')
    unmet.push({
      requirement: 'autonomy',
      reason: `Antigravity has no permission mode named ${native}`,
    })
  if (request.mode === 'turn' && native !== 'always-proceed') {
    unmet.push({
      requirement: 'autonomy',
      reason:
        'Antigravity print mode cannot forward interactive permission questions; use its terminal for supervised work',
    })
  }
  // agy replaces, rather than merges, repeated --settings values. Credential
  // delivery owns that flag when it selects the Gemini API provider; adding
  // a second one here silently switches the process back to subscription auth.
  if (request.mode === 'terminal' || request.mode === 'client') {
    unmet.push({
      requirement: 'workspace-trust',
      reason:
        'Antigravity owns its initial workspace trust confirmation; approve it in the native terminal',
    })
  }
  return {
    launch: { args: [...args, ...launch.args], env: launch.env, files: launch.files },
    homeEdits: [],
    requestedMode: native,
    unmet,
  }
}
