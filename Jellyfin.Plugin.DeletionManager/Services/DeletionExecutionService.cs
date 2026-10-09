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
    private readonly Logger _logger;
    private readonly Func<PluginConfiguration?> _configuration;
    private readonly Func<bool> _forkExecutorLoaded;
    private readonly SemaphoreSlim _executionLock = new(1, 1);

    public DeletionExecutionService(
        IDeletionDueRequestDispatcher dispatcher,
        IDeletionExecutor boundary,
        IDeletionGuardProvider guards,
        DeletionRequestStore store,
        ILibraryManager libraryManager,
        Logger logger)
        : this(dispatcher, boundary, guards, store, libraryManager, logger, () => Plugin.Instance?.Configuration, LegacyForkDetector.IsForkExecutorLoaded)
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
        Func<bool>? forkExecutorLoaded = null)
    {
        _configuration = configuration;
        _forkExecutorLoaded = forkExecutorLoaded ?? (() => false);
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
            if (_forkExecutorLoaded())
            {
                _logger.Warning("[Deletion] The V1.0 Jellyfin Enhanced fork is still loaded; execution is paused so two executors never act on the same approvals. Uninstall the fork, then restart.");
                return;
            }
            foreach (var request in _dispatcher.ListDue(now))
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (_configuration()?.DeletionExecutionEnabled != true) break;
                try
                {
                    ExecuteOne(request, now);
                }
                catch (Exception ex)
                {
                    _logger.Error($"[Deletion] Request {request.Id} was skipped: {ex.Message}");
                }
            }
        }
        finally
        {
            _executionLock.Release();
        }
    }

    private void ExecuteOne(Model.DeletionRequest snapshot, DateTimeOffset now)
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
        if (guards.IsFavorite && configuration.DeletionFavoriteProtectionEnabled)
        {
            _store.MarkBlocked(request.Id, now, "A user has marked an affected item as a favorite.");
            return;
        }

        // Scope queries can take time. A newly saved configuration must still
        // stop this operation, even if the configuration object was replaced.
        if (_configuration()?.DeletionExecutionEnabled != true) return;

        try
        {
            _libraryManager.DeleteItem(item, new DeleteOptions { DeleteFileLocation = true });
        }
        catch (Exception ex)
        {
            _store.MarkFailed(request.Id, now, ex.Message);
            _logger.Error($"[Deletion] Request {request.Id} failed: {ex.Message}");
            return;
        }

        _store.MarkExecuted(request.Id, now);
        _logger.Info($"[Deletion] Executed request {request.Id} for item {request.JellyfinItemId}.");
    }
}
