using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.DeletionManager.Services;

/// <summary>Thin wrapper that writes to Jellyfin's own log under this plugin's category.</summary>
public class Logger
{
    private readonly ILogger _logger;

    public Logger(ILoggerFactory loggerFactory)
    {
        _logger = loggerFactory.CreateLogger("Jellyfin.Plugin.DeletionManager");
    }

    public void Info(string message) => _logger.LogInformation("{Message}", message);

    public void Warning(string message) => _logger.LogWarning("{Message}", message);

    public void Error(string message) => _logger.LogError("{Message}", message);
}
