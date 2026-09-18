/** One sequential proof lane; invoke through scripts/test-heavy.ts. */
const commands = [
  ['bun', 'run', 'typecheck', '--', '--filter', '@podium/web', '--filter', '@podium/mobile'],
  ['bun', 'run', 'test:file', '--', 'apps/web/src/perf/d1-reactivity.test.tsx', 'apps/mobile/src/d1-reactivity.test.tsx', 'packages/client-core/src/replica/replica.sqlite.test.ts', 'packages/client-core/src/replica/contract.test.ts'],
  ['bun', '--conditions=@podium/source', 'packages/client-core/proofs/d1/memory.tsx'],
  ['bun', 'packages/client-core/proofs/d1/build.ts'],
  ['bun', 'run', 'build:clients'],
]
for (const command of commands) {
  console.log(JSON.stringify({ d1Validation: command }))
  const child = Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit', env: { ...process.env, PODIUM_D1_PROOF: '1' } })
  const code = await child.exited
  if (code) process.exit(code)
}
