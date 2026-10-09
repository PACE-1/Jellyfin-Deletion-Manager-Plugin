using Jellyfin.Plugin.DeletionManager.Model;
using Jellyfin.Plugin.DeletionManager.Services;
using MediaBrowser.Common.Configuration;
using Moq;

namespace Jellyfin.Plugin.DeletionManager.Tests;

public sealed class DeletionDueRequestDispatcherTests : IDisposable
{
    private readonly string _dataPath = Path.Combine(Path.GetTempPath(), "deletion-manager-dispatcher-tests", Guid.NewGuid().ToString("N"));
    private readonly DeletionRequestStore _store;

    public DeletionDueRequestDispatcherTests()
    {
        var applicationPaths = new Mock<IApplicationPaths>();
        applicationPaths.SetupGet(paths => paths.DataPath).Returns(_dataPath);
        _store = new DeletionRequestStore(applicationPaths.Object);
    }

    [Fact]
    public void DispatcherOnlyReadsDueRequests()
    {
        var now = DateTimeOffset.Parse("2026-09-23T12:00:00Z");
        var request = _store.Create(new DeletionRequest
        {
            JellyfinItemId = Guid.NewGuid(),
            ItemName = "Test Movie",
            ItemType = "movie",
            ItemCount = 1,
            RequesterId = Guid.NewGuid(),
            RequesterName = "tester",
            Status = DeletionRequestStatus.Approved,
            Timing = DeletionTiming.Immediate,
            ExecuteAt = now,
            CreatedAt = now.AddMinutes(-1)
        });

        var dispatcher = new DeletionDueRequestDispatcher(_store);
        var due = dispatcher.ListDue(now);

        var found = Assert.Single(due);
        Assert.Equal(request.Id, found.Id);
        Assert.Equal(DeletionRequestStatus.Approved, _store.Get(request.Id)!.Status);
    }

    public void Dispose()
    {
        if (Directory.Exists(_dataPath)) Directory.Delete(_dataPath, recursive: true);
    }
}
