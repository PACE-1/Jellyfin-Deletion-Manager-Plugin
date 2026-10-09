# Contributing

Forks and pull requests are welcome.

## Set up

You need the .NET 10 SDK, Node.js 20 or later, Python 3 and Docker (the last two only for the smoke test and packaging).

```bash
dotnet test tests/Jellyfin.Plugin.DeletionManager.Tests
npm ci --prefix tests/javascript --ignore-scripts && npm test --prefix tests/javascript
```

## Before you open a pull request

- Keep the change focused, and add or update a test that fails without it.
- Run both test suites above. For a change to deletion, authorization, import or the browser UI, also run the smoke test (see [docs/TESTING.md](docs/TESTING.md)); it deletes generated files only.
- Physical deletion must stay off by default and every guard must fail closed. A change that weakens either needs a clear reason in the pull request.
- New browser code goes in `Jellyfin.Plugin.DeletionManager/Web/` and must not depend on any other plugin. Element ids and classes use the `jdm-` prefix.

## Reporting a bug

Use the bug template. Say your Jellyfin version, how it is installed (official image, package, other), and include the relevant lines from the server log. Please do not paste media paths or user names you want to keep private.

## Licence

By contributing you agree that your work is licensed under GPL-3.0, like the rest of the project, and credited through the repository history.
