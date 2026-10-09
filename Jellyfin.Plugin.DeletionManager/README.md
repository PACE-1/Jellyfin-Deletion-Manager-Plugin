# Jellyfin Deletion Manager

A Jellyfin plugin for requesting, reviewing, scheduling and safely running media deletions. It works on a vanilla Jellyfin server and needs no other plugin.

- **Request:** a "Request Deletion" button on movie, series, season and episode pages and in the item menu, with an exact item count and an optional reason.
- **Review:** a "Deletion Requests" dashboard (My Requests, Pending, Approved, History) with search, filters, bulk approve and deny, and a per-request timeline.
- **Schedule:** approve for now, 1 week, 2 weeks or 1 month. Approved requests can be cancelled until they run. Approved media shows a countdown on its native library cards for everyone with access to it.
- **Safety:** physical deletion is **off by default**. When on, items that any user has favorited or that are playing are never deleted, and a request is re-checked against the current library contents before it runs.

## Requirements

Jellyfin **12.1** (.NET 10). Jellyfin 10.11 is not supported: the plugin does not load there (the server logs the reason and nothing else changes).

## Install

1. **From a plugin catalog:** in Jellyfin, Dashboard, Plugins, Repositories, add the catalog URL from the release page, then install "Jellyfin Deletion Manager" from the catalog and restart Jellyfin.
2. **By hand:** download `jellyfin-deletion-manager_<version>.zip` from the release page, check it against `SHA256SUMS`, unpack it into a new folder `<jellyfin data>/plugins/Jellyfin Deletion Manager_<version>/`, and restart Jellyfin.

The plugin adds its script to the web app at request time. Nothing is written to Jellyfin's web folder, and no File Transformation or JavaScript Injector plugin is needed.

## Settings

Dashboard, Plugins, Jellyfin Deletion Manager.

| Setting | Default | Meaning |
|---|---|---|
| Enable physical deletion | off | Approved requests are only deleted while this is on. Turning it off stops all deletion at the next run. |
| Protect favorited items | on | A request whose items include a favorite of any user is blocked, not deleted. |

Scheduled deletions run from the task "Process Media Deletion Requests" (every 15 minutes).

## Moving from the V1.0 fork

V1.0 was a fork of Jellyfin Enhanced with this feature built in. To move to this plugin:

1. Install this plugin and restart. Leave physical deletion off.
2. Open the plugin settings and choose **Import requests from V1.0**. This copies requests and history (with their ids, schedules, reasons and scope confirmations) from the fork's database. The fork's database is never changed, and importing again is safe.
3. Open the dashboard and review the queue. Legacy series and season requests that have no saved scope confirmation are marked Blocked and need a new request. Approvals that are already due run as soon as physical deletion is enabled; the settings page tells you how many.
4. Uninstall the V1.0 fork and restart Jellyfin. While the fork is loaded, this plugin refuses to delete anything, because two executors must never act on the same approvals.
5. Turn physical deletion on.

While both are installed you will see two entries in the top bar, two "Request Deletion" menu rows and two sets of badges. This ends when the fork is removed.

**Rolling back:** uninstall this plugin and reinstall the V1.0 fork. The fork reads its own database, which the import never touched. Requests created in this plugin after the import are not copied back.

## Where data is kept

`<jellyfin data>/data/plugins/DeletionManager/deletion-manager.db` (SQLite). Uninstalling the plugin keeps it; delete the folder to remove it. Settings are in Jellyfin's usual plugin configuration folder.

## Building and checking

```bash
python3 scripts/package-deletion-manager.py          # dist/: zip, SHA256SUMS, catalog manifest
dotnet test tests/Jellyfin.Plugin.DeletionManager.Tests
npm ci --prefix tests/javascript && npm test --prefix tests/javascript
python3 tests/smoke/smoke.py --dll <path to the built DLL> [--fork-dll <V1.0 fork DLL>] [--previous-dll <older DLL>]
```

The smoke test starts a clean Jellyfin container with generated media and runs the whole matrix, including physical deletion on generated files only.

## Licence

GPL-3.0. Some code is adapted from Jellyfin Enhanced; see `NOTICE.md`.
