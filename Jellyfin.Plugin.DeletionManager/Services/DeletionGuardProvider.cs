using System;
using System.Linq;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;

namespace Jellyfin.Plugin.DeletionManager.Services;

public interface IDeletionGuardProvider
{
    DeletionGuardContext GetGuards(BaseItem item);
}

public sealed class DeletionGuardProvider : IDeletionGuardProvider
{
    private readonly ISessionManager _sessionManager;
    private readonly IUserManager _userManager;
    private readonly IUserDataManager _userDataManager;
    private readonly Logger _logger;
    private readonly ILibraryManager _libraryManager;

    public DeletionGuardProvider(
        ISessionManager sessionManager,
        IUserManager userManager,
        IUserDataManager userDataManager,
        Logger logger,
        ILibraryManager libraryManager)
    {
        _sessionManager = sessionManager;
        _userManager = userManager;
        _userDataManager = userDataManager;
        _logger = logger;
        _libraryManager = libraryManager;
    }

    public DeletionGuardContext GetGuards(BaseItem item)
    {
        try
        {
            var scope = DeletionScope.Resolve(_libraryManager, item);
            var ids = scope.Items.Select(value => value.Id).ToHashSet();
            var isPlaying = _sessionManager.Sessions.Any(session =>
                session.NowPlayingItem is { } playing && ids.Contains(playing.Id));
            var isFavorite = _userManager.GetUsers().Any(user => scope.Items.Any(value => IsFavorite(user, value)));
            return new DeletionGuardContext(isPlaying, isFavorite, FavoriteProtectionEnabled: true);
        }
        catch (Exception ex)
        {
            // A guard failure must stop a destructive operation rather than fail open.
            _logger.Error($"[Deletion] Safety guard lookup failed for {item.Id}: {ex.Message}");
            return new DeletionGuardContext(IsPlaying: true, IsFavorite: false, FavoriteProtectionEnabled: true);
        }
    }

    private bool IsFavorite(User user, BaseItem item)
        => _userDataManager.GetUserData(user, item)?.IsFavorite == true;
}
