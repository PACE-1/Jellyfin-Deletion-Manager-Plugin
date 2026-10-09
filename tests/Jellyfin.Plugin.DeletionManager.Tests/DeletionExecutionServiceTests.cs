using Jellyfin.Plugin.DeletionManager.Configuration;
using Jellyfin.Plugin.DeletionManager.Model;
using Jellyfin.Plugin.DeletionManager.Services;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace Jellyfin.Plugin.DeletionManager.Tests;

public sealed class DeletionExecutionServiceTests : IDisposable
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-09-23T12:00:00Z");
    private readonly string _dataPath = Path.Combine(Path.GetTempPath(), "deletion-manager-execution-tests", Guid.NewGuid().ToString("N"));
    private readonly DeletionRequestStore _store;
    private readonly Logger _logger;
    private readonly Mock<ILibraryManager> _libraryManager = new();
    private readonly Mock<IDeletionGuardProvider> _guards = new();
    private readonly Mock<IDeletionDueRequestDispatcher> _dispatcher = new();
    private readonly PluginConfiguration _configuration = new() { DeletionExecutionEnabled = true, DeletionFavoriteProtectionEnabled = true };

    public DeletionExecutionServiceTests()
    {
        Directory.CreateDirectory(_dataPath);
        var applicationPaths = new Mock<IApplicationPaths>();
        applicationPaths.SetupGet(paths => paths.DataPath).Returns(_dataPath);
        applicationPaths.SetupGet(paths => paths.LogDirectoryPath).Returns(_dataPath);
        _store = new DeletionRequestStore(applicationPaths.Object);
        _logger = new Logger(NullLoggerFactory.Instance);
        _guards.Setup(guards => guards.GetGuards(It.IsAny<BaseItem>())).Returns(new DeletionGuardContext(false, false, true));
        _libraryManager.Setup(library => library.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => new Movie { Id = id });
    }

    [Fact]
    public async Task DisabledExecutionLeavesDueRequestsUntouched()
    {
        _configuration.DeletionExecutionEnabled = false;
        var request = CreateDue();

        await Service().ExecuteDueAsync(Now, CancellationToken.None);

        Assert.Equal(DeletionRequestStatus.Approved, _store.Get(request.Id)!.Status);
        VerifyNothingDeleted();
    }

    [Fact]
    public async Task ReadyRequestIsDeletedAndMarkedExecuted()
    {
        var request = CreateDue();

        await Service().ExecuteDueAsync(Now, CancellationToken.None);

        Assert.Equal(DeletionRequestStatus.Executed, _store.Get(request.Id)!.Status);
        _libraryManager.Verify(library => library.DeleteItem(It.Is<BaseItem>(item => item.Id == request.JellyfinItemId), It.IsAny<DeleteOptions>()), Times.Once);
    }

    [Fact]
    public async Task FavoriteManualRequestIsBlockedAndNotDeleted()
    {
        var request = CreateDue();
        _guards.Setup(guards => guards.GetGuards(It.IsAny<BaseItem>())).Returns(new DeletionGuardContext(false, true, true));

        await Service().ExecuteDueAsync(Now, CancellationToken.None);

        Assert.Equal(DeletionRequestStatus.Blocked, _store.Get(request.Id)!.Status);
        VerifyNothingDeleted();
    }

    [Fact]
    public async Task PlayingRequestIsRequeuedAndNotDeleted()
    {
        var request = CreateDue();
        _guards.Setup(guards => guards.GetGuards(It.IsAny<BaseItem>())).Returns(new DeletionGuardContext(true, false, true));

        await Service().ExecuteDueAsync(Now, CancellationToken.None);

        var stored = _store.Get(request.Id)!;
        Assert.Equal(DeletionRequestStatus.Approved, stored.Status);
        Assert.True(stored.ExecuteAt > Now);
        VerifyNothingDeleted();
    }

    [Fact]
    public async Task RequestChangedAfterListDueIsSkippedAndRunContinues()
    {
        var stale = CreateDue();
        var next = CreateDue();
        // The dispatcher hands out a snapshot; the stored request moves on before execution reaches it.
        _dispatcher.Setup(dispatcher => dispatcher.ListDue(It.IsAny<DateTimeOffset>())).Returns(new[] { stale, next });
        _store.MarkBlocked(stale.Id, Now, "changed by another path");

        await Service().ExecuteDueAsync(Now, CancellationToken.None);

        Assert.Equal(DeletionRequestStatus.Blocked, _store.Get(stale.Id)!.Status);
        Assert.Equal(DeletionRequestStatus.Executed, _store.Get(next.Id)!.Status);
        _libraryManager.Verify(library => library.DeleteItem(It.Is<BaseItem>(item => item.Id == stale.JellyfinItemId), It.IsAny<DeleteOptions>()), Times.Never);
    }

    [Fact]
    public async Task StoreFailureOnOneRequestDoesNotAbortTheRun()
    {
        var missing = CreateDue();
        var next = CreateDue();
        _dispatcher.Setup(dispatcher => dispatcher.ListDue(It.IsAny<DateTimeOffset>())).Returns(new[] { missing, next });
        _store.MarkBlocked(missing.Id, Now, "changed by another path");
        // A missing item makes the service call MarkFailed, which throws because the request is no longer approved.
        _libraryManager.Setup(library => library.GetItemById(missing.JellyfinItemId)).Returns((BaseItem?)null);

        await Service().ExecuteDueAsync(Now, CancellationToken.None);

        Assert.Equal(DeletionRequestStatus.Executed, _store.Get(next.Id)!.Status);
    }

    [Fact]
    public async Task DeleteFailureMarksRequestFailed()
    {
        var request = CreateDue();
        _libraryManager.Setup(library => library.DeleteItem(It.IsAny<BaseItem>(), It.IsAny<DeleteOptions>())).Throws(new IOException("disk gone"));

        await Service().ExecuteDueAsync(Now, CancellationToken.None);

        var stored = _store.Get(request.Id)!;
        Assert.Equal(DeletionRequestStatus.Failed, stored.Status);
        Assert.Equal("disk gone", stored.FailureReason);
    }

    public void Dispose()
    {
        if (Directory.Exists(_dataPath)) Directory.Delete(_dataPath, recursive: true);
    }

    private DeletionExecutionService Service()
    {
        if (!_dispatcher.Setups.Any())
        {
            _dispatcher.Setup(dispatcher => dispatcher.ListDue(It.IsAny<DateTimeOffset>())).Returns((DateTimeOffset now) => _store.ListDue(now));
        }

        return new DeletionExecutionService(_dispatcher.Object, new DeletionExecutionBoundary(), _guards.Object, _store, _libraryManager.Object, _logger, () => _configuration);
    }

    private void VerifyNothingDeleted()
        => _libraryManager.Verify(library => library.DeleteItem(It.IsAny<BaseItem>(), It.IsAny<DeleteOptions>()), Times.Never);

    private DeletionRequest CreateDue()
    {
        var created = _store.Create(new DeletionRequest
        {
            JellyfinItemId = Guid.NewGuid(),
            ItemName = "Test Movie",
            ItemType = "movie",
            ItemCount = 1,
            RequesterId = Guid.NewGuid(),
            RequesterName = "tester",
            Status = DeletionRequestStatus.Pending,
            CreatedAt = Now.AddHours(-1)
        });
        _store.Approve(created.Id, DeletionTiming.Immediate, Guid.NewGuid(), Now);
        return _store.Get(created.Id)!;
    }
}
