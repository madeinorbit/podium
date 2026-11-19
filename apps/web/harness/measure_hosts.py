"""Measurement hosts and their locks, shared by the startup controllers (POD-7099).

A controller either runs on ludovico and drives the host over ssh, taking the
host's lock itself, or runs on the host (`--local`) under a lock its caller
already holds (`--lock-held`), which is how `remote-lane <host> <issue> run`
invokes it. The defaults are the agent VMs and the same locks as remote-lane.
Both VMs report the hostname `agents`, so captures record the ssh alias.
"""
import json
import os
import subprocess
from dataclasses import dataclass

# name -> (ssh alias and recorded host label, timing lock)
HOSTS = {
    'vega': ('vega-agents', 'test:vega-agents'),
    'polaris': ('polaris-agents', 'test:polaris-agents'),
    # Historical: POD-5594's baseline host. Not allowed for new runs (operator 2026-11-12).
    'flatblock': ('flatblock', 'bench:flatblock'),
}

# Additional authorized VMs are operational configuration, not public routing
# inventory. Both arms inherit this mapping through the measurement process.
extra_hosts = json.loads(os.environ.get('PODIUM_MEASUREMENT_HOSTS', '{}'))
if not isinstance(extra_hosts, dict):
    raise ValueError('PODIUM_MEASUREMENT_HOSTS must be a JSON object')
for name, spec in extra_hosts.items():
    if (not name or name in HOSTS or not isinstance(spec, list) or len(spec) != 2
            or any(not isinstance(value, str) or not value for value in spec)
            or spec[0].startswith('-') or any(char.isspace() for char in spec[0])
            or not spec[1].startswith(('test:', 'bench:'))):
        raise ValueError('Additional measurement hosts need a new label, SSH alias and timing lock')
    HOSTS[name] = tuple(spec)

# Prefer a checkout-local toolchain (flatblock), else the VM lane toolchain.
TOOLCHAIN = ('T="$PWD/.toolchain"; [ -d "$T" ] || T="$HOME/podium-lanes-toolchain"; '
             'export PATH="$T:$PATH" LD_LIBRARY_PATH="$T/lib"; ')


def add_arguments(parser, default='vega'):
    parser.add_argument('--host', default=default, choices=sorted(HOSTS),
                        help='measurement host (default: %(default)s); recorded with every capture')
    parser.add_argument('--local', action='store_true',
                        help='this process already runs on --host (for example under remote-lane)')
    parser.add_argument('--lock', default='', help="host lock held for each timing window (default: the host's remote-lane lock)")
    parser.add_argument('--lock-held', action='store_true',
                        help='the caller already holds --lock for the whole run (remote-lane does); take, renew and release nothing')


@dataclass
class Host:
    name: str
    alias: str
    lock: str
    local: bool
    held: bool

    def argv(self, command):
        return ['bash', '-c', command] if self.local else ['ssh', '-o', 'BatchMode=yes', self.alias, command]

    def run(self, command, **kwargs):
        return subprocess.run(self.argv(command), **kwargs)

    def popen(self, command, **kwargs):
        return subprocess.Popen(self.argv(command), **kwargs)

    def acquire(self, name=None, ttl='45m'):
        name = name or self.lock
        if self.held:
            return {'data': {'granted': True}, 'text': f'{name} held by the caller', 'heldByCaller': True}
        grant = subprocess.run(['podium', 'lock', 'acquire', name, '--wait', '--ttl', ttl, '--json'],
                               check=True, capture_output=True, text=True)
        value = json.loads(grant.stdout)
        if not value.get('data', {}).get('granted'):
            raise RuntimeError(f'{name} was not acquired')
        return value

    def renew(self, name=None, ttl='45m'):
        if not self.held:
            subprocess.run(['podium', 'lock', 'renew', name or self.lock, '--ttl', ttl], check=True)

    def release(self, name=None):
        if not self.held:
            subprocess.run(['podium', 'lock', 'release', name or self.lock], check=True)


def resolve(args):
    alias, lock = HOSTS[args.host]
    return Host(args.host, alias, args.lock or lock, args.local, args.lock_held)
