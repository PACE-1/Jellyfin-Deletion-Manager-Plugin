# How it works

## Pieces

| Part | Where | Job |
|---|---|---|
| Plugin shell | `Plugin.cs`, `PluginServiceRegistrator.cs` | Identity, settings page, service registration |
| Request store | `Services/DeletionRequestStore.cs` | SQLite database (write-ahead log mode) of requests, audit rows and import records |
| Controllers | `Controllers/` | `DeletionManager/Requests` API, admin config and import, the script endpoint |
| Execution | `Services/DeletionExecution*.cs`, `ScheduledTasks/` | A scheduled task (every 15 minutes) that runs due approvals behind the guards |
| Guards | `Services/DeletionGuardProvider.cs`, `DeletionScope.cs` | Favorites and playback checks, and the scope a request covers |
| Browser UI | `Web/` | The dashboard, request dialog, top-bar entry, card badges and item-menu row |
| Injection | `Services/ScriptInjectionStartupFilter.cs`, `WebAssetBundle.cs` | Adds one script tag to the web app's `index.html` at request time |

The browser files are embedded in the plugin and served as one script at `/DeletionManager/script`. Nothing is written to Jellyfin's web folder and no other plugin is involved.

## Request life

`Pending` or `Approved` (an administrator's own request is approved at once) → `Executed`, or `Denied`, `Cancelled`, `Blocked` or `Failed`. Approval sets a time (now, 1 week, 2 weeks or 1 month). A request for a series or season carries a fingerprint of the exact episodes the requester confirmed; if the library changed, it must be confirmed again.

## Safety rules

- Physical deletion is off until an administrator turns it on, and turning it off stops everything at the next run.
- A guard that cannot be read counts as "do not delete".
- Items any user has favorited, or that are playing, are skipped (the favorite guard can be switched off in settings).
- Non-administrators see only their own requests. Approved schedules are visible to everyone who can see the item, without the requester.
- Every change to a request is an authenticated call checked on the server; the browser only hides buttons.
- Mutations are never retried automatically.

## Data

`<jellyfin data>/data/plugins/DeletionManager/deletion-manager.db`. Tables: `deletion_requests`, `deletion_audit`, and, after an import, `migration_log` and `migration_rows`.

## Browser runtime

`Web/jdm-core.js` is a small runtime (sign-in tracking, authenticated fetch, navigation events, one shared mutation observer, a toast, the Home tab entry with the Jellyfin 12 header fallback, native action-sheet rows). The other files build the UI on it. The bundle starts only after a user is signed in, and every per-user piece of state is cleared when the signed-in user changes, without a page reload.
