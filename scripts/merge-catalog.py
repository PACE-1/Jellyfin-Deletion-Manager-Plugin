#!/usr/bin/env python3
"""Merge release catalog entries without losing versions already on the default branch."""
import json
import sys
from pathlib import Path


def merge_catalog(current, released):
    for incoming in released:
        plugin = next((p for p in current if p['guid'] == incoming['guid']), None)
        if plugin is None:
            current.append(incoming)
            continue
        versions = {(v['version'], v['targetAbi']): v for v in plugin['versions']}
        # Existing catalog versions are authoritative; releases add missing entries.
        for version in incoming['versions']:
            versions.setdefault((version['version'], version['targetAbi']), version)
        plugin['versions'] = sorted(versions.values(), key=lambda v: tuple(map(int, v['version'].split('.'))), reverse=True)
    return current


if __name__ == '__main__':
    target, release = map(Path, sys.argv[1:])
    target.write_text(json.dumps(merge_catalog(json.loads(target.read_text()), json.loads(release.read_text())), indent=2) + '\n')
