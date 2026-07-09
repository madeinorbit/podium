# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report vulnerabilities privately via [GitHub Security Advisories](https://github.com/madeinorbit/podium/security/advisories/new) ("Report a vulnerability"). If you cannot use GitHub, email <mike.wirth@gmail.com> with `[podium security]` in the subject.

You can expect an acknowledgement within 7 days. Please include reproduction steps and the affected version/commit if you can.

## Supported versions

Podium is pre-1.0. Only the latest release (and `main`) receive security fixes.

## Deployment notes

- Podium's server is designed to run on **loopback** or behind an authenticated proxy/tunnel (e.g. Tailscale).
- If you bind it to a non-loopback interface, set `PODIUM_PASSWORD`. The server warns — but stays up — when exposed without a password; treat that configuration as unsafe unless the network itself is trusted.
- Agent sessions execute real shell commands on the host. Only connect machines and repositories you trust.
