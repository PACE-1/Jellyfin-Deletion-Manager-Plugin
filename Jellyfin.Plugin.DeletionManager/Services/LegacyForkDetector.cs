namespace Jellyfin.Plugin.DeletionManager.Services;

/// <summary>
/// Detects the V1.0 Jellyfin Enhanced fork, which owns its own deletion executor and database.
/// Two executors must never act on the same approvals, so this plugin does not execute while the
/// fork is loaded. The fork shares the upstream Enhanced plugin id, so the check looks for the
/// fork's executor type rather than the plugin id.
/// </summary>
public static class LegacyForkDetector
{
    private const string ForkExecutorType = "Jellyfin.Plugin.JellyfinEnhanced.Services.DeletionExecutionService";

    public static bool IsForkExecutorLoaded()
    {
        foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
        {
            if (assembly.IsDynamic) continue;
            try
            {
                if (assembly.GetType(ForkExecutorType, throwOnError: false) is not null) return true;
            }
            catch (Exception)
            {
                // An assembly that cannot be inspected is not the fork.
            }
        }
        return false;
    }
}
