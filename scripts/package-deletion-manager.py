#!/usr/bin/env python3
"""Build the Jellyfin Deletion Manager release files into dist/.

  python3 scripts/package-deletion-manager.py [--no-docker] [--repo OWNER/REPO | --source-base-url URL]
                                              [--merge-into manifest.json] [--changelog TEXT]

Produces, for the version in Jellyfin.Plugin.DeletionManager/DeletionManager.csproj:
  jellyfin-deletion-manager_<version>.zip   the DLL, meta.json, LICENSE and NOTICE.md
  SHA256SUMS                                checksums for the zip and the DLL
  manifest.json                             a plugin-catalog entry for the zip (MD5, as Jellyfin's catalog requires)

The build uses the .NET 10 SDK in a container (or the local one with --no-docker). The zip is written with fixed
timestamps, so rebuilding the same source gives the same checksums. --source-base-url is where the zip will be
downloaded from; --repo OWNER/REPO is shorthand for the GitHub release download URL of this version. Without either,
the catalog entry carries an obvious placeholder that must be replaced before publishing. --merge-into starts from an
existing catalog file, so earlier versions stay listed; the result is written to dist/manifest.json.
"""
import argparse, hashlib, json, os, re, subprocess, sys, zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROJECT = ROOT / 'Jellyfin.Plugin.DeletionManager'
PLUGIN_ID = 'f501435c-5b9d-4f2c-9556-12297eee46e7'
TARGET_ABI = '12.1.0.0'  # the only Jellyfin line this release is validated on
FIXED_TIME = (2026, 1, 1, 0, 0, 0)


def version():
    return re.search(r'<AssemblyVersion>([\d.]+)</AssemblyVersion>', (PROJECT / 'DeletionManager.csproj').read_text()).group(1)


def build(use_docker):
    build_args = ['dotnet', 'build', 'Jellyfin.Plugin.DeletionManager/DeletionManager.csproj', '-c', 'Release',
                  '-p:ContinuousIntegrationBuild=true', '-p:Deterministic=true', '--nologo']
    if use_docker:
        cmd = ['docker', 'run', '--rm', '-u', f'{os.getuid()}:{os.getgid()}', '-e', 'HOME=/tmp', '-e', 'DOTNET_CLI_HOME=/tmp',
               '-e', 'DOTNET_NOLOGO=1', '-v', f'{ROOT}:/src', '-w', '/src', 'mcr.microsoft.com/dotnet/sdk:10.0'] + build_args
    else:
        cmd = build_args
    subprocess.run(cmd, check=True, cwd=ROOT)
    return PROJECT / 'bin' / 'Release' / 'net10.0' / 'Jellyfin.Plugin.DeletionManager.dll'


def add(archive, name, data):
    info = zipfile.ZipInfo(name, FIXED_TIME)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    archive.writestr(info, data)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--no-docker', action='store_true')
    parser.add_argument('--source-base-url', default='')
    parser.add_argument('--repo', default='', help='GitHub OWNER/REPO that will host the release')
    parser.add_argument('--merge-into', default='', help='existing catalog manifest to add this version to')
    parser.add_argument('--changelog', default='')
    args = parser.parse_args()

    ver = version()
    dll = build(not args.no_docker)
    dist = ROOT / 'dist'
    dist.mkdir(exist_ok=True)
    zip_path = dist / f'jellyfin-deletion-manager_{ver}.zip'
    meta = {
        'category': 'General', 'guid': PLUGIN_ID, 'name': 'Jellyfin Deletion Manager',
        'description': 'Request, review, schedule and safely execute media deletions.',
        'overview': 'Users request deletion of movies, series, seasons and episodes; admins approve, deny or cancel from a dashboard.',
        'owner': 'PACE', 'targetAbi': TARGET_ABI, 'version': ver,
        'timestamp': '2026-01-01T00:00:00Z', 'status': 'Active', 'autoUpdate': True,
    }
    with zipfile.ZipFile(zip_path, 'w') as archive:
        add(archive, dll.name, dll.read_bytes())
        add(archive, 'meta.json', json.dumps(meta, indent=2).encode() + b'\n')
        add(archive, 'LICENSE', (ROOT / 'LICENSE').read_bytes())
        add(archive, 'NOTICE.md', (PROJECT / 'NOTICE.md').read_bytes())

    sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
    (dist / 'SHA256SUMS').write_text(f'{sha(zip_path)}  {zip_path.name}\n{sha(dll)}  {dll.name}\n')
    base = args.source_base_url.rstrip('/')
    if not base and args.repo:
        base = f'https://github.com/{args.repo}/releases/download/v{ver}'
    base = base or 'REPLACE_WITH_RELEASE_DOWNLOAD_URL'
    version_entry = {
        'version': ver, 'changelog': args.changelog or 'First standalone release: runs on a vanilla Jellyfin 12.1 server with no companion plugin.',
        'targetAbi': TARGET_ABI, 'sourceUrl': f'{base}/{zip_path.name}',
        'checksum': hashlib.md5(zip_path.read_bytes()).hexdigest().upper(),
        'timestamp': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S'),
    }
    entry = [{
        'guid': PLUGIN_ID, 'name': 'Jellyfin Deletion Manager', 'description': meta['description'], 'overview': meta['overview'],
        'owner': meta['owner'], 'category': 'General', 'versions': [],
    }]
    if args.merge_into and Path(args.merge_into).exists():
        entry = json.loads(Path(args.merge_into).read_text())
    plugin = next(p for p in entry if p['guid'] == PLUGIN_ID)
    plugin['versions'] = [version_entry] + [v for v in plugin['versions'] if v['version'] != ver]
    (dist / 'manifest.json').write_text(json.dumps(entry, indent=2) + '\n')
    print(f'{zip_path}\n  sha256 {sha(zip_path)}\n  md5    {hashlib.md5(zip_path.read_bytes()).hexdigest().upper()}')
    if base.startswith('REPLACE'):
        print('note: manifest.json has a placeholder sourceUrl; pass --repo or --source-base-url before publishing', file=sys.stderr)


if __name__ == '__main__':
    main()
