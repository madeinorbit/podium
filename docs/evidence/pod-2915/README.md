# POD-2915 web audit evidence

Runtime readings were taken on the named `p2915` instance after pinning the
server, web bundle, and daemon. The fix-arm server/web/daemon pin was
`91114b3a420f963ba2f1e65d0173f20a4513813d`; the POD-2604 parent pin was
`6c668904614fc5a79877e5e791634b5c570f019d`, and the POD-2761 parent daemon
pin was `a841ade7407d91e72e946d05ebd281fe59f557b6`.

- `2604-provider-tip.json` records the positive working control, the real Grok
  `usage_limit`/402 error, and the Chat detail and recovery surface.
- `2761-switch-tip.json` records the ALPHA/BRAVO/CHARLIE conversation, three
  Chat-to-CLI-to-Chat-to-CLI captures, header counts, and client PIDs.
- `2637-artifact-tip.json` records the positive Codex screen control and the
  accepted terminal-evidence artifact on local POD-25.
- `2637-terminal.png` is the stored terminal capture; its readback was
  byte-identical at 165742 bytes with SHA-256
  `29c1567b9debb90636b9375b019cb02d368ebe7af3c86b4d5686a616f038cf7e`.

The two named parent arms were `NO_MEASUREMENT`: both hit
`create-session: File name too long` before their positive controls fired.
The full tip web build emitted usable artifacts but tripped the independent
eager-byte budget at `7793309 > 7780000`.
