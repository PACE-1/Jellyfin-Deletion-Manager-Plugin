# Making a release

1. Set the new version in `Jellyfin.Plugin.DeletionManager/DeletionManager.csproj` (`AssemblyVersion` and `FileVersion`, four numbers, for example `1.1.1.0`). Update the `meta.json` text in `scripts/package-deletion-manager.py` if the description changed.
2. Run the three test suites (see [TESTING.md](TESTING.md)). For a release also run the smoke test against the built DLL, and against the previous release's DLL with `--previous-dll` to prove an upgrade keeps data.
3. Build the files locally if you want to inspect them first:

   ```bash
   python3 scripts/package-deletion-manager.py --repo <owner>/<repo> --merge-into manifest.json
   ```

   This writes `dist/jellyfin-deletion-manager_<version>.zip`, `dist/SHA256SUMS` and `dist/manifest.json`. The build is reproducible: the same source gives the same zip.
4. Merge to `main`, then push a tag that matches the version: `git tag v1.1.1.0 && git push origin v1.1.1.0`.
5. The **Release** workflow checks the tag against the project version, runs the tests, builds the zip, publishes a GitHub release with the zip, `SHA256SUMS` and `manifest.json`, and adds the new version to `manifest.json` on `main`. If `main` is protected, that last step fails: open a pull request that replaces `manifest.json` with the one attached to the release.
6. On a clean Jellyfin 12.1 instance, add the catalog URL, install the plugin from the catalog, restart, and check that the plugin is Active and the dashboard loads.

The catalog entry's `targetAbi` is `12.1.0.0`: the plugin is validated on Jellyfin 12.1 only. Raise or add targets only after running the smoke test on that Jellyfin version.
