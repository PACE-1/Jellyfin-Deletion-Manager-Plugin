using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.DeletionManager.Services;

/// <summary>The library items and paths covered by a physical deletion.</summary>
public sealed record DeletionScope(IReadOnlyList<BaseItem> Items, Guid[] EpisodeIds, string Fingerprint)
{
    public static DeletionScope Resolve(ILibraryManager library, BaseItem item)
    {
        var items = new List<BaseItem> { item };
        if (item is Series or Season)
        {
            items.AddRange(library.GetItemList(new InternalItemsQuery
            {
                ParentId = item.Id,
                Recursive = true,
                IsVirtualItem = false
            }));
        }

        var ordered = items.DistinctBy(value => value.Id).OrderBy(value => value.Id).ToArray();
        var snapshot = JsonSerializer.Serialize(ordered.Select(value => new
        {
            value.Id,
            value.Path,
            Type = value.GetType().Name
        }));
        return new DeletionScope(ordered,
            ordered.OfType<Episode>().Select(value => value.Id).Order().ToArray(),
            Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(snapshot))));
    }

    public int ItemCount(BaseItem item) => item is Series or Season ? EpisodeIds.Length : 1;
}
