using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.DeletionManager.Configuration;

public class PluginConfiguration : BasePluginConfiguration
{
    public PluginConfiguration()
    {
        // Physical deletion stays off until an admin enables it after reviewing the queue.
        DeletionExecutionEnabled = false;
        DeletionFavoriteProtectionEnabled = true;
    }

    public bool DeletionExecutionEnabled { get; set; }
    public bool DeletionFavoriteProtectionEnabled { get; set; }
}
