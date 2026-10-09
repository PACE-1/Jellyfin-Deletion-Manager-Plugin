using System;

namespace Jellyfin.Plugin.DeletionManager.Model;

public static class DeletionRequestContract
{
    private static readonly string[] AllowedItemTypes = ["movie", "series", "season", "episode"];

    public static bool TryParseItemType(string? value, out string itemType)
    {
        itemType = value?.Trim().ToLowerInvariant() ?? string.Empty;
        return Array.IndexOf(AllowedItemTypes, itemType) >= 0;
    }

    public static bool TryParseTiming(string? value, out DeletionTiming timing)
    {
        timing = default;
        return value?.Trim().ToLowerInvariant() switch
        {
            "immediate" => Set(DeletionTiming.Immediate, out timing),
            "1w" => Set(DeletionTiming.OneWeek, out timing),
            "2w" => Set(DeletionTiming.TwoWeeks, out timing),
            "1mo" => Set(DeletionTiming.OneMonth, out timing),
            _ => false
        };
    }

    private static bool Set(DeletionTiming value, out DeletionTiming target)
    {
        target = value;
        return true;
    }
}
