# POD-3103 headed driver acceptance

## Pins and isolation

The source branch and local `issue/1761-agent-runtime` both pointed to
`fbc2f18baf77d74d370c6469444b3c3d800b0a71`. The OpenCode basic cell used named
instance `p3103-opencode-basic`, product-derived state and agent home, scratch cwd
`/tmp/pod-3103-opencode-basic/repo`, and ports 19971/46971/46972. The verifier read
the server and daemon spawn stamps and fetched the served web stamp; all three were
`fbc2f18`. Port 19797, port 32090, the default instance state, and their processes
were not touched.

The installed harness was OpenCode 1.18.25 from
`~/.opencode/bin/opencode`. The drive used the product session/runtime path; no
provider binary was driven directly.

## 2026-08-30 first batch: OpenCode launch/send control

At 2026-08-30 00:02:49 CEST the session bound `opencode-server`. The initial
nonce prompt was accepted with disposition `delivered`; the exact assistant nonce
arrived in 3,520 ms and the whole probe completed in 3,845 ms. The independent
positive control staged a file containing a second random nonce: the agent read it
and returned the nonce in 1,505 ms (1,808 ms whole probe), with zero approval asks.

Host state immediately after the bounded run was 17,471,201,280 bytes
MemAvailable, 563,666,944 bytes swap used, 73 GiB root free, and load average
14.53/11.53/7.76. The elevated load is part of the reading; these timings are not
presented as an idle-host baseline.

This cell proves current-tip binding, initial input acceptance, output delivery,
and transcript synchronization. It is not a headed view-switch, interruption, or
recovery verdict; those remain separate cells.

## Current evidence not repeated

The Grok basic Chat/CLI repair at `d77713859196462a59e4898f4f5e4ac0e29c5787`
and the Codex native-view timing cited in the parent release ledger remain current:
`git diff d777138..fbc2f18 -- . ':!docs'` is empty. Repeating those provider runs
would not test changed product bytes.

## Raw cell rows

See `rows.tsv`; each populated line was checked for exactly eight tab-separated
