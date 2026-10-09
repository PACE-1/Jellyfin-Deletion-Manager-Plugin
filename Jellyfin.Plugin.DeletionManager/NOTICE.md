# Notice

Copyright (C) 2026 PACE

Jellyfin Deletion Manager is free software, licensed under the GNU General Public License, version 3 (see `LICENSE`). You may use, change, fork and share it under that licence. Anyone who distributes it, changed or not, must keep this notice and the copyright lines, say what they changed, and pass on the same licence and the source.

## Code adapted from Jellyfin Enhanced

Some parts are adapted from [Jellyfin Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced) by n00bcodr and its contributors (GPL-3.0), reduced to what this plugin needs. The upstream copyright and licence terms apply to them. Thank you to that project.

| Here | Adapted from | What it is |
|---|---|---|
| `Services/ScriptInjectionStartupFilter.cs` | `Services/ScriptInjectionStartupFilter.cs` | Request-time injection of the script tag into the web app's `index.html` |
| `Helpers/UserHelper.cs` | `Helpers/UserHelper.cs` | Reading the signed-in user from the request claims |
| `Web/jdm-core.js` | `js/core/session.js`, `js/core/navigation.js`, `js/core/dom-observer.js`, `js/enhanced/native-tabs.js`, `js/enhanced/homeremoval/features-remove-home.js` | Identity transitions, history patching, shared observer, Home tab entry with the Jellyfin 12 header fallback, native action-sheet row |
| `Web/deletion-dashboard-page.js` | `js/enhanced/bookmarks/bookmarks-library-page.js` | The pushState mount pattern for a standalone page |

Everything else is this project's own code.

## Third-party packages

- Microsoft.Data.Sqlite (MIT)
- Jellyfin.Controller and Jellyfin.Model (GPL-2.0-or-later, referenced at build time; supplied by the server at run time)
