# Moving from the V1.0 fork

V1.0 was a fork of Jellyfin Enhanced with the deletion feature built in. This plugin replaces it. Your requests and history can be imported, and nothing in the fork's data is changed.

## Steps

1. Install this plugin and restart Jellyfin. Leave **Enable physical deletion** off.
2. Open Dashboard, Plugins, Jellyfin Deletion Manager, and choose **Import requests from V1.0**. The result shows how many requests and history entries came in.
3. Open **Deletion Requests** and review the queue.
   - Series and season requests made before the fork stored a scope confirmation are marked **Blocked**; ask for them again.
   - Approvals that are already due will run as soon as deletion is enabled. The settings page says how many.
4. Uninstall the V1.0 fork and restart Jellyfin. While the fork is loaded, this plugin will not delete anything, because two executors must never act on the same approvals.
5. Turn **Enable physical deletion** on.

While both are installed you will see two top-bar entries, two "Request Deletion" menu rows and two sets of badges, one of each from each plugin. They read separate databases. This ends when the fork is removed.

## What the import does

- Reads the fork's database at `<jellyfin data>/data/plugins/Jellyfin Enhanced/deletion-manager.db` through SQLite's backup interface, so rows still in its write-ahead log are included. The file is never modified.
- Keeps request ids, requesters, approvers, schedules, reasons, scope fingerprints and history.
- Refuses to import into a plugin that already has its own requests (the ids would mix).
- Can be repeated. Rows already imported are left as they are, even if an administrator has since acted on them. A row that changed in the fork's database after the import is reported as a conflict and not applied.

## Rolling back

Uninstall this plugin and reinstall the V1.0 fork. It reads its own database, which the import never touched. Requests made in this plugin after the import are not copied back.

The plugin's own data stays on disk when it is uninstalled (`<jellyfin data>/data/plugins/DeletionManager/`); delete that folder to remove it.
