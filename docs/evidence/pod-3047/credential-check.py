"""Read-only check that a Claude credential is safe to point a rig at.

The value is NEVER printed. A rig must not carry a credential it did not check:
an expired access token with a superseded refresh token can be treated as replay
and revoke the whole family, which logs the operator out of their own tool.
"""
import datetime
import json
import sys

path = sys.argv[1]
oauth = (json.load(open(path)) or {}).get('claudeAiOauth') or {}
expires = oauth.get('expiresAt')
if not expires:
    raise SystemExit('refusing: credential has no claudeAiOauth.expiresAt to check')
at = datetime.datetime.fromtimestamp(expires / 1000, datetime.timezone.utc)
now = datetime.datetime.now(datetime.timezone.utc)
if at <= now:
    raise SystemExit(f'refusing: operator credential expired at {at.astimezone()}')
print(f'credential check: unexpired, expires {at.astimezone():%Y-%m-%d %H:%M:%S %Z}, margin {str(at - now).split(".")[0]}')
