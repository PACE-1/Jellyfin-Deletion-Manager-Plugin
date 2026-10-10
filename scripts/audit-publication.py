#!/usr/bin/env python3
"""Check a public source tree or package for private data; report locations without values.

Scans text, printable binary strings, archive members and optional Git author/committer metadata.
Example domains, GitHub no-reply identities, localhost and required license contact addresses are allowed.
A clean result describes these checks; it does not assert that arbitrary media contains no personal data.
"""
import argparse
import io
import re
import subprocess
import zipfile
from pathlib import Path

EMAIL = re.compile(r'(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}(?![\w.-])')
ALLOWED_DOMAINS = {'example.com', 'example.org', 'example.net', 'example.invalid', 'users.noreply.github.com', 'fsf.org', 'gnu.org'}
PATTERNS = {
    'home directory': re.compile(r'(?:/home/[A-Za-z0-9_.-]+|/Users/[A-Za-z0-9_.-]+/|[A-Za-z]:\\Users\\[A-Za-z0-9_.-]+)'),
    'private IPv4 address': re.compile(r'\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b'),
    'private key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'provider credential': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16})\b'),
    'embedded credential': re.compile(r'(?i)\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*[\"\'][A-Za-z0-9/+_=-]{16,}[\"\']'),
    'URL credentials': re.compile(r'https?://[^\s/]+:[^\s/]+@'),
}
SKIP_DIRS = {'.git', 'node_modules', 'bin', 'obj', '__pycache__'}


def scan_text(text):
    hits = []
    for match in EMAIL.finditer(text):
        if match.group().rsplit('@', 1)[1].lower() not in ALLOWED_DOMAINS:
            hits.append(('email address', text.count('\n', 0, match.start()) + 1))
    for label, pattern in PATTERNS.items():
        for match in pattern.finditer(text):
            # Assembly-qualified type names contain version numbers shaped like IP addresses.
            # Accept only the precise assembly metadata context, never a bare numeric address.
            if label == 'private IPv4 address' and text[max(0, match.start() - 8):match.start()] == 'Version=' and text[match.end():].startswith(', Culture='):
                continue
            hits.append((label, text.count('\n', 0, match.start()) + 1))
    return hits


def scan_bytes(data):
    # DLL strings may be UTF-16LE. Decode both encodings; return only locations/categories.
    hits = scan_text(data.decode('utf-8', errors='replace'))
    if b'\x00' in data:
        hits += scan_text(data.decode('utf-16le', errors='replace'))
    return sorted(set(hits))


def scan_file(path, label):
    data = path.read_bytes()
    if zipfile.is_zipfile(io.BytesIO(data)):
        hits = []
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for member in archive.infolist():
                if member.is_dir():
                    continue
                hits.extend((f'{label}:{member.filename}', kind, line) for kind, line in scan_bytes(archive.read(member)))
        return hits
    return [(label, kind, line) for kind, line in scan_bytes(data)]


def audit(root, history=False):
    root = Path(root).resolve()
    files = [root] if root.is_file() else sorted(p for p in root.rglob('*') if p.is_file() and not set(p.relative_to(root).parts) & SKIP_DIRS)
    hits = []
    for path in files:
        label = path.name if root.is_file() else str(path.relative_to(root))
        hits.extend(scan_file(path, label))
    if history:
        result = subprocess.run(['git', '-C', str(root), 'log', '--all', '--format=%h%x09%an <%ae>%x09%cn <%ce>'], check=True, capture_output=True, text=True)
        for row in result.stdout.splitlines():
            commit, _, metadata = row.partition('\t')
            hits.extend((f'git metadata {commit}', kind, line) for kind, line in scan_text(metadata))
    return hits, len(files)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('path')
    parser.add_argument('--git-history', action='store_true', help='also check author/committer identities on all refs')
    args = parser.parse_args()
    hits, count = audit(args.path, args.git_history)
    for label, kind, line in hits:
        print(f'{label}: {kind} (line/string {line})')
    print(f'Checked {count} files; {len(hits)} findings.')
    return bool(hits)


if __name__ == '__main__':
    raise SystemExit(main())
