using System;
using System.Collections.Generic;
using Jellyfin.Plugin.DeletionManager.Model;

namespace Jellyfin.Plugin.DeletionManager.Services;

public interface IDeletionDueRequestDispatcher
{
    IReadOnlyList<DeletionRequest> ListDue(DateTimeOffset now);
}

public sealed class DeletionDueRequestDispatcher : IDeletionDueRequestDispatcher
{
    private readonly DeletionRequestStore _store;

    public DeletionDueRequestDispatcher(DeletionRequestStore store)
    {
        _store = store;
    }

    public IReadOnlyList<DeletionRequest> ListDue(DateTimeOffset now) => _store.ListDue(now);
}
