# Testing

| Suite | Command | What it covers |
|---|---|---|
| Backend | `dotnet test tests/Jellyfin.Plugin.DeletionManager.Tests` | Store, authorization, validation, execution and guards, script injection |
| Browser UI | `npm ci --prefix tests/javascript --ignore-scripts && npm test --prefix tests/javascript` | The UI modules and the browser runtime in jsdom |
| Smoke | `python3 tests/smoke/smoke.py --dll <path to Jellyfin.Plugin.DeletionManager.dll>` | A clean Jellyfin container, end to end |

## Smoke test

It starts a vanilla Jellyfin container (default image `jellyfin/jellyfin:12.1`; set `JELLYFIN_IMAGE` or `--image` for another), generates media with ffmpeg, creates an administrator and a second user, installs the plugin and checks, in order:

- install, one execution task, the script tag injected once, anonymous and non-administrator access to every protected route
- request validation, scope confirmation, per-user visibility, approve, cancel, schedule visibility on library cards
- the browser UI in headless Chromium, including signing out and in as another user without a page reload and a phone-width layout
- physical deletion on the generated files: the off switch, the favorite guard, a week-out approval not running early, the audit row, the item leaving the library
- uninstall (routes and script gone), reinstall (data kept), and optionally an upgrade from an older build (`--previous-dll`)

It needs Docker and network access to pull the Jellyfin and Playwright images. Everything it creates is removed at the end (`--keep` leaves it, `--screenshots DIR` saves the browser screenshots). It deletes generated files only and never touches a real library.

The exit status is 0 only when every check passes.
