# POD-3098 current-tip A3 evidence

This directory contains only the release-critical A3 interruption cells requested at exact
`issue/1761-agent-runtime` tip `fbc2f18baf77d74d370c6469444b3c3d800b0a71`. The runtime uses the named
instance `p3098-a3-current-tip`, explicit state `/tmp/pod-3098-a3-fbc2f18/state`, explicit agent
home `/tmp/pod-3098-a3-fbc2f18/agent-home`, and ports `19983/46983/46984`; port 19797 and the
operator default state are never resolved.

Each JSON reading records both working-phase and output-growth controls before interruption,
request-to-stopped latency, every 250 ms output sample for 12 seconds after the request, exactly
one `event:interrupt` item live and after client reload, the same item after both source server
and daemon restart, and an idle/refused request whose response cannot be confused with a
confirmed stop.

The source pins established before the first source read were:

- branch/HEAD: `fbc2f18baf77d74d370c6469444b3c3d800b0a71`
- server source: `c6bd6e350479ec1b2de986ee4d3f6a14365ae38d`
- daemon source: `d77713859196462a59e4898f4f5e4ac0e29c5787`
- web source: `1e6569960c7b7f4a61391ae8b52c94e98952aa78`
- served bundle: built and stamped `fbc2f18`

Readings are committed one cell at a time and summarized here only after the final cell.
