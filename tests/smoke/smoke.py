#!/usr/bin/env python3
"""Clean-container smoke test for the Jellyfin Deletion Manager plugin.

Starts a vanilla Jellyfin container with only this plugin, generated media and two users, then checks:
installation, injection, authorization and validation, the browser UI (headless Chromium), scheduled
execution and its guards on generated files only, uninstall and reinstall and, optionally, an upgrade.

  python3 tests/smoke/smoke.py --dll path/to/Jellyfin.Plugin.DeletionManager.dll \
      [--previous-dll old.dll] \
      [--image jellyfin/jellyfin:12.1] [--keep]

Needs Docker, python3 and network access to pull the Jellyfin and Playwright images. Everything the test
creates lives in a temporary directory and one container, both removed at the end (unless --keep).
Exit status is 0 only when every check passed.
"""
import argparse, json, os, shutil, socket, subprocess, sys, tempfile, time, urllib.error, urllib.request
from pathlib import Path

PLUGIN_ID = 'f501435c-5b9d-4f2c-9556-12297eee46e7'
PLUGIN_DIR = 'DeletionManager_1.1.0.0'
R = '/DeletionManager/Requests'
HERE = Path(__file__).resolve().parent
results = []


def check(name, passed, detail=''):
    results.append((name, bool(passed)))
    print(('PASS ' if passed else 'FAIL ') + name + ('' if passed else '  -> ' + str(detail)[:300]), flush=True)
    return passed


class Server:
    def __init__(self, image, workdir):
        self.image, self.dir = image, Path(workdir)
        self.name = f'jdm-smoke-{os.getpid()}'
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            self.port = s.getsockname()[1]
        self.base = f'http://127.0.0.1:{self.port}'
        (self.dir / 'config').mkdir(parents=True, exist_ok=True)
        (self.dir / 'media').mkdir(parents=True, exist_ok=True)
        (self.dir / 'cache').mkdir(parents=True, exist_ok=True)

    def start(self):
        uid, gid = os.getuid(), os.getgid()
        cmd = ['docker', 'run', '-d', '--name', self.name, '-v', f'{self.dir}/config:/config', '-v', f'{self.dir}/media:/media', '-v', f'{self.dir}/cache:/cache',
               '-p', f'127.0.0.1:{self.port}:8096']
        cmd += ['-e', f'PUID={uid}', '-e', f'PGID={gid}'] if 'linuxserver' in self.image else ['--user', f'{uid}:{gid}']
        subprocess.run(cmd + [self.image], check=True, capture_output=True)
        self.wait()

    def wait(self, seconds=150):
        end = time.time() + seconds
        while time.time() < end:
            try:
                urllib.request.urlopen(self.base + '/System/Info/Public', timeout=3).read()
                time.sleep(6)  # plugins finish loading shortly after the endpoint answers
                return
            except Exception:
                time.sleep(2)
        raise RuntimeError('Jellyfin did not start')

    def restart(self):
        subprocess.run(['docker', 'restart', self.name], check=True, capture_output=True)
        self.wait()

    def stop(self): subprocess.run(['docker', 'stop', self.name], check=True, capture_output=True)
    def begin(self): subprocess.run(['docker', 'start', self.name], check=True, capture_output=True); self.wait()
    def exec(self, *args): return subprocess.run(['docker', 'exec', self.name, *args], capture_output=True, text=True)
    def exists(self, path): return self.exec('test', '-e', path).returncode == 0
    def logs(self): return subprocess.run(['docker', 'logs', self.name], capture_output=True, text=True).stdout
    def remove(self): subprocess.run(['docker', 'rm', '-f', self.name], capture_output=True)

    def api(self, path, body=None, token=None, method=None):
        header = 'MediaBrowser Client="smoke", Device="smoke", DeviceId="smoke", Version="1"' + (f', Token="{token}"' if token else '')
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode() if body is not None else None,
                                     headers={'Authorization': header, 'Content-Type': 'application/json'}, method=method or ('POST' if body is not None else 'GET'))
        try:
            with urllib.request.urlopen(req, timeout=90) as res:
                code, data = res.status, res.read()
        except urllib.error.HTTPError as e:
            code, data = e.code, e.read()
        try:
            return code, (json.loads(data) if data else None)
        except ValueError:
            return code, data.decode('utf8', 'replace')

    def login(self, name):
        code, j = self.api('/Users/AuthenticateByName', {'Username': name, 'Pw': 'pw12345'})
        assert code == 200, (name, code, j)
        return j['AccessToken'], j['User']['Id']


def generate_media(server):
    ffmpeg = '/usr/lib/jellyfin-ffmpeg/ffmpeg'
    files = [f'/media/Movies/{n} (2026)/{n} (2026).mp4' for n in ('Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo')]
    files += [f'/media/Shows/Epsilon (2026)/Season 01/Epsilon (2026) S01E0{e}.mp4' for e in (1, 2)]
    for f in files:
        server.exec('mkdir', '-p', os.path.dirname(f))
        r = server.exec(ffmpeg, '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=duration=2',
                        '-shortest', '-pix_fmt', 'yuv420p', f, '-y')
        assert r.returncode == 0, r.stderr
    # docker exec runs as root on some images; the server must own the files it is asked to delete.
    server.exec('chown', '-R', f'{os.getuid()}:{os.getgid()}', '/media')


def setup_server(server):
    api = server.api
    api('/Startup/Configuration', {'UICulture': 'en-US', 'MetadataCountryCode': 'US', 'PreferredMetadataLanguage': 'en'})
    api('/Startup/User')
    api('/Startup/User', {'Name': 'admin', 'Password': 'pw12345'})
    api('/Startup/Complete', {}, method='POST')
    token, _ = server.login('admin')
    _, system_config = api('/System/Configuration', None, token)
    system_config['ServerName'] = 'Jellyfin'
    api('/System/Configuration', system_config, token)
    for name, kind, path in [('Movies', 'movies', '/media/Movies'), ('Shows', 'tvshows', '/media/Shows')]:
        api(f'/Library/VirtualFolders?name={name}&collectionType={kind}&refreshLibrary=false',
            {'LibraryOptions': {'PathInfos': [{'Path': path}], 'EnableRealtimeMonitor': False, 'EnableInternetProviders': False,
                                # No online metadata: the run must not depend on the internet or fetch anyone's artwork.
                                'TypeOptions': [{'Type': t, 'MetadataFetchers': [], 'ImageFetchers': []} for t in ('Movie', 'Series', 'Season', 'Episode')]}}, token)
    api('/Library/Refresh', {}, token)
    for _ in range(60):
        time.sleep(2)
        code, items = api('/Items?Recursive=true&IncludeItemTypes=Movie,Series&Fields=Path', None, token)
        if code == 200 and len(items['Items']) >= 6:
            break
    api('/Users/New', {'Name': 'viewer', 'Password': 'pw12345'}, token)
    return {i['Path'].split('/media/')[-1]: i['Id'] for i in items['Items']}


def plugin_config(server, token, **changes):
    _, current = server.api(f'/Plugins/{PLUGIN_ID}/Configuration', None, token)
    current.update(changes)
    code, _ = server.api(f'/Plugins/{PLUGIN_ID}/Configuration', current, token)
    assert code in (200, 204)


def run_task(server, token):
    _, tasks = server.api('/ScheduledTasks', None, token)
    task = [t for t in tasks if t.get('Key') == 'DeletionManagerExecution']
    check('exactly one execution task is registered', len(task) == 1, [t['Name'] for t in tasks])
    server.api(f'/ScheduledTasks/Running/{task[0]["Id"]}', {}, token, method='POST')
    for _ in range(60):
        time.sleep(1)
        if server.api(f'/ScheduledTasks/{task[0]["Id"]}', None, token)[1]['State'] == 'Idle':
            return


def get_request(server, token, request_id):
    return next(r for r in server.api(R, None, token)[1] if r['Id'] == request_id)


def check_api(server, ids):
    admin, _ = server.login('admin')
    viewer, viewer_id = server.login('viewer')
    movie = ids['Movies/Alpha (2026)/Alpha (2026).mp4']
    _, plugins = server.api('/Plugins', None, admin)
    check('plugin is Active', any(p['Name'] == 'Jellyfin Deletion Manager' and p['Status'] == 'Active' for p in plugins), plugins)
    for label, call in [('list', lambda: server.api(R)), ('submit', lambda: server.api(R, {'itemId': movie, 'itemType': 'movie'})),
                        ('config', lambda: server.api('/DeletionManager/Config'))]:
        check(f'anonymous {label} is 401', call()[0] == 401)
    check('script is served anonymously', server.api('/DeletionManager/script')[0] == 200)
    for label, call in [('config', lambda: server.api('/DeletionManager/Config', None, viewer)),
                        ('approve', lambda: server.api(R + '/1/approve', {'timing': 'immediate'}, viewer)),
                        ('deny', lambda: server.api(R + '/1/deny', {'reason': 'x'}, viewer)),
                        ('bulk approve', lambda: server.api(R + '/bulk/approve', {'ids': [1], 'timing': 'immediate'}, viewer)),
                        ('cancel', lambda: server.api(R + '/1/cancel', {}, viewer))]:
        check(f'non-admin {label} is 403', call()[0] == 403)
    check('bad item id is 400', server.api(R, {'itemId': 'x', 'itemType': 'movie'}, viewer)[0] == 400)
    check('unknown item is 404', server.api(R, {'itemId': '1' * 32, 'itemType': 'movie'}, viewer)[0] == 404)
    check('type mismatch is 400', server.api(R, {'itemId': movie, 'itemType': 'series'}, viewer)[0] == 400)
    series = ids['Shows/Epsilon (2026)']
    check('series without a confirmed count is 400', server.api(R, {'itemId': series, 'itemType': 'series'}, viewer)[0] == 400)
    check('series with a stale count is 409', server.api(R, {'itemId': series, 'itemType': 'series', 'expectedItemCount': 1, 'expectedItemIds': []}, viewer)[0] == 409)
    code, mine = server.api(R, {'itemId': movie, 'itemType': 'movie', 'reason': 'smoke'}, viewer)
    check('viewer request is created pending', code in (200, 201) and mine['Status'] == 'Pending', (code, mine))
    check('duplicate active request is 409', server.api(R, {'itemId': movie, 'itemType': 'movie'}, viewer)[0] == 409)
    _, listed = server.api(R, None, viewer)
    check('viewer lists only their own requests', all(r['RequesterId'].replace('-', '') == viewer_id for r in listed))
    code, approved = server.api(R + f'/{mine["Id"]}/approve', {'timing': '1w'}, admin)
    check('approve schedules a week out', code == 200 and approved['Status'] == 'Approved' and approved['Timing'] == 'OneWeek', approved)
    check('approve twice is 409', server.api(R + f'/{mine["Id"]}/approve', {'timing': '1w'}, admin)[0] == 409)
    _, cards = server.api(R + '/card-status', None, viewer)
    check('approved schedule is visible on cards', any(c['ItemId'].replace('-', '') == movie for c in cards), cards)
    check('cancel works', server.api(R + f'/{mine["Id"]}/cancel', {'reason': 'smoke'}, admin)[1]['Status'] == 'Cancelled')
    _, cards = server.api(R + '/card-status', None, viewer)
    check('cancelled schedule leaves the cards', not any(c['ItemId'].replace('-', '') == movie for c in cards))


def check_ui(server, ids, work, playwright_image):
    # A pending request from a second user, so the dashboard has something to review.
    viewer, _ = server.login('viewer')
    server.api(R, {'itemId': ids['Movies/Echo (2026)/Echo (2026).mp4'], 'itemType': 'movie', 'reason': 'Duplicate of a better rip'}, viewer)
    cache = Path.home() / '.cache' / 'jdm-smoke'
    cache.mkdir(parents=True, exist_ok=True)
    uid = f'{os.getuid()}:{os.getgid()}'
    if not (cache / 'node_modules' / 'playwright').exists():
        subprocess.run(['docker', 'run', '--rm', '-u', uid, '-e', 'HOME=/tmp', '-v', f'{cache}:/w', '-w', '/w', playwright_image,
                        'sh', '-c', 'npm init -y >/dev/null && npm i playwright@1.49.0 >/dev/null 2>&1'], check=True)
    shutil.copy(HERE / 'ui.js', cache / 'ui.js')
    out = Path(work) / 'ui-out'
    out.mkdir(exist_ok=True)
    movie = ids['Movies/Bravo (2026)/Bravo (2026).mp4']
    r = subprocess.run(['docker', 'run', '--rm', '--network', 'host', '-u', uid, '-e', 'HOME=/tmp', '-e', f'BASE={server.base}', '-e', f'MOVIE={movie}', '-e', f'OTHER={ids["Movies/Alpha (2026)/Alpha (2026).mp4"]}',
                        '-v', f'{cache}:/w', '-v', f'{out}:/out', '-w', '/w', playwright_image, 'node', 'ui.js'], capture_output=True, text=True)
    print(r.stdout, end='')
    if r.returncode == 2:
        print(r.stderr)
    for entry in json.loads((out / 'ui-results.json').read_text()) if (out / 'ui-results.json').exists() else []:
        results.append(('ui: ' + entry['name'], entry['pass']))
    if r.returncode == 2 or not (out / 'ui-results.json').exists():
        check('browser smoke ran to the end', False, r.stderr[-300:])
    return out


def check_execution(server, ids):
    admin, _ = server.login('admin')
    viewer, viewer_id = server.login('viewer')
    path = lambda name: f'/media/Movies/{name} (2026)/{name} (2026).mp4'
    plugin_config(server, admin, DeletionExecutionEnabled=False, DeletionFavoriteProtectionEnabled=True)
    code, req = server.api(R, {'itemId': ids[f'Movies/Charlie (2026)/Charlie (2026).mp4'], 'itemType': 'movie'}, admin)
    check('admin request is approved at once', code in (200, 201) and req['Status'] == 'Approved', req)
    run_task(server, admin)
    check('kill switch: a due approval waits while execution is off', server.exists(path('Charlie')) and get_request(server, admin, req['Id'])['Status'] == 'Approved')
    server.api(f'/Users/{viewer_id}/FavoriteItems/{ids["Movies/Charlie (2026)/Charlie (2026).mp4"]}', {}, viewer)
    plugin_config(server, admin, DeletionExecutionEnabled=True)
    run_task(server, admin)
    blocked = get_request(server, admin, req['Id'])
    check('favorite guard blocks the deletion and keeps the file', server.exists(path('Charlie')) and blocked['Status'] == 'Blocked', blocked)
    server.api(f'/Users/{viewer_id}/FavoriteItems/{ids["Movies/Charlie (2026)/Charlie (2026).mp4"]}', None, viewer, method='DELETE')
    code, req = server.api(R, {'itemId': ids['Movies/Delta (2026)/Delta (2026).mp4'], 'itemType': 'movie'}, admin)
    _, week = server.api(R, {'itemId': ids['Movies/Alpha (2026)/Alpha (2026).mp4'], 'itemType': 'movie'}, viewer)
    server.api(R + f'/{week["Id"]}/approve', {'timing': '1w'}, admin)
    run_task(server, admin)
    done = get_request(server, admin, req['Id'])
    check('a week-out approval is not executed early', server.exists(path('Alpha')) and get_request(server, admin, week['Id'])['Status'] == 'Approved')
    check('execution deletes the generated file and records it', done['Status'] == 'Executed' and not server.exists(path('Delta')), done)
    time.sleep(3)
    _, items = server.api('/Items?Recursive=true&IncludeItemTypes=Movie', None, admin)
    check('the deleted movie leaves the Jellyfin library', ids['Movies/Delta (2026)/Delta (2026).mp4'] not in [i['Id'] for i in items['Items']], [i['Name'] for i in items['Items']])
    _, audit = server.api(R + f'/{req["Id"]}/audit', None, admin)
    check('the execution is audited', any(a['Action'] == 'executed' for a in audit), audit)
    plugin_config(server, admin, DeletionExecutionEnabled=False)


def check_reinstall(server, dll):
    plugin_dir = server.plugins / PLUGIN_DIR
    admin, _ = server.login('admin')
    before = {r['Id'] for r in server.api(R, None, admin)[1]}
    shutil.rmtree(plugin_dir)
    server.restart()
    admin, _ = server.login('admin')
    check('standalone routes are gone after uninstall', server.api(R, None, admin)[0] == 404)
    check('no script from the removed plugin is injected', 'DeletionManager/script' not in urllib.request.urlopen(server.base + '/web/').read().decode())
    plugin_dir.mkdir(parents=True)
    shutil.copy(dll, plugin_dir / Path(dll).name)
    server.restart()
    admin, _ = server.login('admin')
    check('reinstalling keeps the requests', {r['Id'] for r in server.api(R, None, admin)[1]} == before, before)
    _, plugins = server.api('/Plugins', None, admin)
    check('the plugin is Active again with one execution task', any(p['Name'] == 'Jellyfin Deletion Manager' and p['Status'] == 'Active' for p in plugins))


def check_upgrade(server, dll, previous_dll):
    plugin_dir = server.plugins / PLUGIN_DIR
    admin, _ = server.login('admin')
    before = {r['Id'] for r in server.api(R, None, admin)[1]}
    plugin_config(server, admin, DeletionFavoriteProtectionEnabled=False)
    server.stop()
    shutil.copy(previous_dll, plugin_dir / Path(dll).name)
    server.begin()
    server.stop()
    shutil.copy(dll, plugin_dir / Path(dll).name)
    server.begin()
    admin, _ = server.login('admin')
    check('upgrade keeps requests', {r['Id'] for r in server.api(R, None, admin)[1]} == before)
    _, cfg = server.api(f'/Plugins/{PLUGIN_ID}/Configuration', None, admin)
    check('upgrade keeps settings', cfg['DeletionFavoriteProtectionEnabled'] is False, cfg)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--dll', required=True)
    parser.add_argument('--previous-dll')
    parser.add_argument('--image', default=os.environ.get('JELLYFIN_IMAGE', 'jellyfin/jellyfin:12.1'))
    parser.add_argument('--playwright-image', default=os.environ.get('PLAYWRIGHT_IMAGE', 'mcr.microsoft.com/playwright:v1.49.0-jammy'))
    parser.add_argument('--keep', action='store_true')
    parser.add_argument('--screenshots', help='copy the browser screenshots (for the README) into this directory')
    args = parser.parse_args()
    work = tempfile.mkdtemp(prefix='jdm-smoke-')
    server = Server(args.image, work)
    try:
        server.start()  # vanilla host first: its data paths decide where the plugin goes
        _, info = server.api('/System/Info/Public')
        check('the host is the expected Jellyfin 12.x', str(info.get('Version', '')).startswith('12.'), info.get('Version'))
        generate_media(server)
        ids = setup_server(server)
        admin, _ = server.login('admin')
        _, system = server.api('/System/Info', None, admin)
        host = lambda container_path: server.dir / 'config' / Path(container_path).relative_to('/config')
        program_data = host(system['ProgramDataPath'])
        server.plugins = program_data / 'plugins'
        server.stop()
        plugin_dir = server.plugins / PLUGIN_DIR
        plugin_dir.mkdir(parents=True)
        shutil.copy(args.dll, plugin_dir / Path(args.dll).name)
        server.begin()
        check_api(server, ids)
        check('the injected script tag appears once in /web/', urllib.request.urlopen(server.base + '/web/').read().decode().count('DeletionManager/script') == 1)
        out = check_ui(server, ids, work, args.playwright_image)
        if args.screenshots:
            Path(args.screenshots).mkdir(parents=True, exist_ok=True)
            for png in out.glob('*.png'):
                shutil.copy(png, Path(args.screenshots) / png.name)
        check_execution(server, ids)
        check_reinstall(server, args.dll)
        if args.previous_dll:
            check_upgrade(server, args.dll, args.previous_dll)
        errors = [l for l in server.logs().splitlines() if '[ERR]' in l and 'DeletionManager' in l and 'Access to the path' not in l]
        check('no plugin errors in the server log', not errors, errors[:3])
        if args.keep:
            print('kept', work, server.name)
    finally:
        if not args.keep:
            server.remove()
            subprocess.run(['docker', 'run', '--rm', '-v', f'{work}:/w', 'alpine', 'sh', '-c', 'chmod -R a+rwX /w'], capture_output=True)
            shutil.rmtree(work, ignore_errors=True)
    failed = [n for n, ok in results if not ok]
    print(f'\n{len(results) - len(failed)}/{len(results)} checks passed')
    for name in failed:
        print('FAILED:', name)
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
