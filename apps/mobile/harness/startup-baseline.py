"""Seeded production phone Work-tab cold/warm first Paint on flatblock.

Uses the shared corpus, durable-cache check and Chromium Paint collector.
Invoke from the repository root; all remaining flags go to the controller.
"""
from pathlib import Path
import subprocess
import sys

controller = Path(__file__).resolve().parents[2] / 'web/harness/startup-baseline.py'
raise SystemExit(subprocess.call([sys.executable, str(controller), *sys.argv[1:], '--surface=phone']))
