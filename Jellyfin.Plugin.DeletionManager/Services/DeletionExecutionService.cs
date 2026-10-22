using System;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.DeletionManager.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Entities.TV;

namespace Jellyfin.Plugin.DeletionManager.Services;

public sealed class DeletionExecutionService
{
    private static readonly TimeSpan PlaybackRetryDelay = TimeSpan.FromMinutes(15);
    private readonly IDeletionDueRequestDispatcher _dispatcher;
    private readonly IDeletionExecutor _boundary;
    private readonly IDeletionGuardProvider _guards;
    private readonly DeletionRequestStore _store;
    private readonly ILibraryManager _libraryManager;
    private readonly IArrUnmonitorService _arr;
    private readonly PosterArchive? _posters;
    private readonly Logger _logger;
    private readonly Func<PluginConfiguration?> _configuration;
    private readonly SemaphoreSlim _executionLock = new(1, 1);

    public DeletionExecutionService(
        IDeletionDueRequestDispatcher dispatcher,
        IDeletionExecutor boundary,
        IDeletionGuardProvider guards,
        DeletionRequestStore store,
        ILibraryManager libraryManager,
        IArrUnmonitorService arr,
        PosterArchive posters,
        Logger logger)
        : this(dispatcher, boundary, guards, store, libraryManager, logger, () => Plugin.Instance?.Configuration, arr, posters)
    {
    }

    public DeletionExecutionService(
        IDeletionDueRequestDispatcher dispatcher,
        IDeletionExecutor boundary,
        IDeletionGuardProvider guards,
        DeletionRequestStore store,
        ILibraryManager libraryManager,
        Logger logger,
        Func<PluginConfiguration?> configuration,
        IArrUnmonitorService? arr = null,
        PosterArchive? posters = null)
    {
        _arr = arr ?? NoArrUnmonitorService.Instance;
        _posters = posters;
        _configuration = configuration;
        _dispatcher = dispatcher;
        _boundary = boundary;
        _guards = guards;
        _store = store;
        _libraryManager = libraryManager;
        _logger = logger;
    }

    public async Task ExecuteDueAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        await _executionLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_configuration()?.DeletionExecutionEnabled != true) return;
            foreach (var request in _dispatcher.ListDue(now))
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (_configuration()?.DeletionExecutionEnabled != true) break;
                try
                {
                    await ExecuteOneAsync(request, now, cancellationToken).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    _logger.Error($"[Deletion] Request {request.Id} was skipped: {ex.GetType().Name}: {ex.Message}");
                }
            }
        }
        finally
        {
            _executionLock.Release();
        }
    }

    private async Task ExecuteOneAsync(Model.DeletionRequest snapshot, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var request = _store.Get(snapshot.Id);
        if (request?.Status != Model.DeletionRequestStatus.Approved || !request.ExecuteAt.HasValue || request.ExecuteAt > now) return;
        var configuration = _configuration();
        if (configuration?.DeletionExecutionEnabled != true) return;
        var item = _libraryManager.GetItemById(request.JellyfinItemId);
        if (item is null)
        {
            _store.MarkFailed(request.Id, now, "The Jellyfin item no longer exists.");
            return;
        }

        var scope = DeletionScope.Resolve(_libraryManager, item);
        if ((item is Series or Season && request.ScopeFingerprint is null)
            || (request.ScopeFingerprint is not null && request.ScopeFingerprint != scope.Fingerprint))
        {
            _store.MarkBlocked(request.Id, now, "The deletion scope changed or has no saved confirmation. Submit a new request to review the current items.");
            return;
        }

        var guards = _guards.GetGuards(item) with
        {
            FavoriteProtectionEnabled = configuration.DeletionFavoriteProtectionEnabled
        };
        var decision = _boundary.Evaluate(request, now, guards);
        switch (decision.Disposition)
        {
            case DeletionExecutionDisposition.Requeue:
                _store.Requeue(request.Id, now.Add(PlaybackRetryDelay), now, decision.Reason);
                return;
            case DeletionExecutionDisposition.AwaitingFavoriteDecision:
                _store.HoldForFavorite(request.Id, now, decision.Reason);
                return;
            case DeletionExecutionDisposition.Blocked:
                _store.MarkBlocked(request.Id, now, decision.Reason);
                return;
            case DeletionExecutionDisposition.Ready:
                break;
            default:
                _logger.Warning($"[Deletion] Request {request.Id} was not executable: {decision.Reason}");
                return;
        }

        // Recheck the persisted approval/schedule and scope at the destructive boundary.
        var current = _store.Get(request.Id);
        if (current?.Status != Model.DeletionRequestStatus.Approved || current.ExecuteAt != request.ExecuteAt)
        {
            _logger.Info($"[Deletion] Request {request.Id} is no longer approved; skipped.");
            return;
        }

        configuration = _configuration();
        if (configuration?.DeletionExecutionEnabled != true) return;
        if (scope.Fingerprint != DeletionScope.Resolve(_libraryManager, item).Fingerprint)
        {
            _store.MarkBlocked(request.Id, now, "The deletion scope changed during execution. Submit a new request.");
            return;
        }
        guards = _guards.GetGuards(item);
        if (guards.IsPlaying)
        {
            _store.Requeue(request.Id, now.Add(PlaybackRetryDelay), now, "An affected item started playing during execution.");
            return;
        }
        configuration = _configuration();
        if (configuration?.DeletionExecutionEnabled != true) return;
        if (guards.IsFavorite && configuration.DeletionFavoriteProtectionEnabled && current.FavoriteDecision != Model.DeletionRequest.FavoriteAllowed)
        {
            _store.HoldForFavorite(request.Id, now, "An affected item is favorited. An admin must confirm that it should be deleted.");
            return;
        }

        // Scope queries can take time. A newly saved configuration must still
        // stop this operation, even if the configuration object was replaced.
        if (_configuration()?.DeletionExecutionEnabled != true) return;

        // Unmonitor first and fail closed: deleting files while Sonarr/Radarr still monitor them
        // would make them download the media again.
        try
        {
            await _arr.UnmonitorAsync(item, scope, configuration, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _store.Requeue(request.Id, now.Add(PlaybackRetryDelay), now, "Sonarr/Radarr could not be updated, so nothing was deleted. Check the connection settings.");
            _logger.Error($"[Deletion] Request {request.Id} not deleted, unmonitor failed: {ex.GetType().Name}: {ex.Message}");
            return;
        }

        // The item and its images are gone after DeleteItem, so keep the poster first.
        _posters?.Save(request.Id, item);

        try
        {
            _libraryManager.DeleteItem(item, new DeleteOptions { DeleteFileLocation = true });
        }
        catch (Exception ex)
        {
            _store.MarkFailed(request.Id, now, "Jellyfin could not delete the requested item. Check server storage and permissions.");
            _logger.Error($"[Deletion] Request {request.Id} failed: {ex.GetType().Name}: {ex.Message}");
            return;
        }

        _store.MarkExecuted(request.Id, now);
        _store.CompleteMatchingRequests(request, now);
        _logger.Info($"[Deletion] Executed request {request.Id} for item {request.JellyfinItemId}.");
    }
}
