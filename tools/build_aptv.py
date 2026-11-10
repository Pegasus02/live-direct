#!/usr/bin/env python3
"""Bundle live_direct into one standard-library script for single-file hosts.

    python3 tools/build_aptv.py            # writes dist/live-direct-aptv.py

See live_direct/bundle.py. The admin page can also export a copy that has the
current settings built in.
"""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from live_direct import bundle  # noqa: E402

PKG = bundle.PKG
DEFAULT_OUT = ROOT / 'dist' / 'live-direct-aptv.py'


def version():
    try:
        return subprocess.run(['git', 'describe', '--always', '--dirty'], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return 'unknown'


def build(out=DEFAULT_OUT, config=None):
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(bundle.render(version(), config), encoding='utf-8')
    return out


if __name__ == '__main__':
    target = build(Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT)
    print(f'{target} ({target.stat().st_size // 1024} KiB)')
