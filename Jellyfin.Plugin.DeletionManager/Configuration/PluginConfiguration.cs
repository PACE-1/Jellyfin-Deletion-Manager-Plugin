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

    // Optional. When a URL and API key are both set, deleted media is unmonitored there first
    // (the series/movie entry stays) so Sonarr/Radarr do not download it again.
    public string SonarrUrl { get; set; } = string.Empty;
    public string SonarrApiKey { get; set; } = string.Empty;
    public string RadarrUrl { get; set; } = string.Empty;
    public string RadarrApiKey { get; set; } = string.Empty;
}
