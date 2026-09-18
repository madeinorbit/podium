/** D7 uses D1's exact fixture, assertions, memory children and bundle builder. */
const commands = [
  ['bun', 'run', 'typecheck', '--', '--filter', '@podium/web', '--filter', '@podium/mobile'],
  ['bun', 'run', 'test:file', '--', 'apps/web/src/perf/d1-reactivity.test.tsx', 'apps/mobile/src/d1-reactivity.test.tsx'],
  ['bun', '--conditions=@podium/source', 'packages/client-core/proofs/d1/memory.tsx'],
  ['bun', 'packages/client-core/proofs/d1/build.ts'],
]
for (const command of commands) {
  console.log(JSON.stringify({ d7Validation: command }))
  const child = Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit',
    env: { ...process.env, PODIUM_D1_PROOF: '1', PODIUM_D7_PROOF: '1' } })
  if (await child.exited) process.exit(child.exitCode ?? 1)
}
