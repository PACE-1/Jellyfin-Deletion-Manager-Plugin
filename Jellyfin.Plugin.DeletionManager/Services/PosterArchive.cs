using System;
using System.IO;
using System.Linq;
using Jellyfin.Data.Enums;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.DeletionManager.Services;

/// <summary>Keeps a copy of each deleted item's poster so executed request cards still show what was removed.</summary>
public sealed class PosterArchive
{
    private readonly string _directory;
    private readonly Logger _logger;

    public PosterArchive(IApplicationPaths applicationPaths, Logger logger)
    {
        _directory = Path.Combine(applicationPaths.DataPath, "plugins", "DeletionManager", "posters");
        _logger = logger;
    }

    /// <summary>Best effort. A missing poster must never block a deletion.</summary>
    public void Save(long requestId, BaseItem item)
    {
        try
        {
            var source = FindPoster(item);
            if (source is null) return;
            Directory.CreateDirectory(_directory);
            File.Copy(source, Path.Combine(_directory, $"{requestId}{Path.GetExtension(source).ToLowerInvariant()}"), overwrite: true);
        }
        catch (Exception ex)
        {
            _logger.Warning($"[Deletion] Poster for request {requestId} was not kept: {ex.GetType().Name}: {ex.Message}");
        }
    }

    public string? TryGetPath(long requestId)
        => Directory.Exists(_directory) ? Directory.EnumerateFiles(_directory, $"{requestId}.*").FirstOrDefault() : null;

    // Seasons and episodes often have no poster of their own; the series poster still identifies them.
    private static string? FindPoster(BaseItem item)
    {
        foreach (var candidate in new BaseItem?[] { item, (item as Season)?.Series, (item as Episode)?.Series })
        {
            var path = candidate?.GetImagePath(ImageType.Primary, 0);
            if (!string.IsNullOrEmpty(path) && File.Exists(path)) return path;
        }

        return null;
    }
}
