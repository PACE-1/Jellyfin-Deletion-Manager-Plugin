using Jellyfin.Plugin.DeletionManager.Model;
using Jellyfin.Plugin.DeletionManager.Services;
using MediaBrowser.Common.Configuration;
using Microsoft.Data.Sqlite;
using Moq;

namespace Jellyfin.Plugin.DeletionManager.Tests;

public sealed class DeletionLifecycleRegressionTests : IDisposable
{
    private readonly string _dataPath = Path.Combine(Path.GetTempPath(), "deletion-lifecycle-tests", Guid.NewGuid().ToString("N"));
    private readonly Mock<IApplicationPaths> _paths = new();
    private readonly DeletionRequestStore _store;

    public DeletionLifecycleRegressionTests()
    {
        _paths.SetupGet(p => p.DataPath).Returns(_dataPath);
        _store = new DeletionRequestStore(_paths.Object);
    }

    private static DeletionRequest Request(Guid? user = null) => new()
    {
        JellyfinItemId = Guid.NewGuid(), ItemName = "Synthetic movie", ItemType = "movie", ItemCount = 1,
        RequesterId = user ?? Guid.NewGuid(), RequesterName = "viewer", CreatedAt = DateTimeOffset.UtcNow,
        Status = DeletionRequestStatus.Pending, ScopeFingerprint = "reviewed-scope"
    };

    [Fact]
    public void LifecycleAuditPersistsActorsAndScheduleWithoutDuplicatingIdempotentSubmission()
    {
        var request = Request();
        var created = _store.Create(request);
        Assert.Equal(created.Id, _store.Create(request).Id);
        var actor = Guid.NewGuid();
        var scheduled = DateTimeOffset.UtcNow.AddDays(7);
        _store.Approve(created.Id, DeletionTiming.OneWeek, actor, scheduled);
        _store.Cancel(created.Id, DateTimeOffset.UtcNow, "Cancelled", actor);
        var reopened = new DeletionRequestStore(_paths.Object);
        var rows = reopened.ListAudit(created.Id);
        Assert.Equal(new[] { "submitted", "approved", "cancelled" }, rows.Select(r => r.Action));
        Assert.Equal(request.RequesterId, rows[0].ActorId);
        Assert.Equal(actor, rows[1].ActorId);
        Assert.Equal(actor, rows[2].ActorId);
        Assert.Contains("OneWeek", rows[1].Reason);
        Assert.Contains(scheduled.ToString("O"), rows[1].Reason);
        Assert.Throws<InvalidOperationException>(() => _store.Deny(created.Id, actor, "late"));
        Assert.Equal(3, _store.ListAudit(created.Id).Count);
    }

    [Fact]
    public void DenialIsDurablyAuditedWithReasonAndActor()
    {
        var created = _store.Create(Request());
        var actor = Guid.NewGuid();
        _store.Deny(created.Id, actor, "Keep this title");
        var row = Assert.Single(_store.ListAudit(created.Id), r => r.Action == "denied");
        Assert.Equal(actor, row.ActorId);
        Assert.Equal("Keep this title", row.Reason);
    }

    [Fact]
    public void RequestLimitIsPerUserAllowsRetriesAndReleasesCompletedSlots()
    {
        var request = Request();
        var created = _store.Create(request, 1);
        Assert.Equal(created.Id, _store.Create(request, 1).Id);
        Assert.Throws<DeletionRequestLimitException>(() => _store.Create(Request(request.RequesterId), 1));
        _store.Create(Request(), 1);
        _store.Deny(created.Id, Guid.NewGuid(), "done");
        _store.Create(Request(request.RequesterId), 1);
        Assert.Equal(3, _store.List().Count);
    }

    [Fact]
    public async Task ConcurrentRequestsCannotExceedTheQuota()
    {
        var user = Guid.NewGuid();
        var results = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() =>
        {
            try { _store.Create(Request(user), 2); return true; }
            catch (DeletionRequestLimitException) { return false; }
        })));
        Assert.Equal(2, results.Count(r => r));
        Assert.Equal(2, _store.List(user).Count);
    }

    [Fact]
    public void ConfirmedDeletionCompletesOnlyMatchingActiveScopes()
    {
        var first = _store.Create(Request());
        var same = _store.Create(Request() with { JellyfinItemId = first.JellyfinItemId });
        var changed = _store.Create(Request() with { JellyfinItemId = first.JellyfinItemId, ScopeFingerprint = "different-scope" });
        var denied = _store.Create(Request() with { JellyfinItemId = first.JellyfinItemId });
        _store.Deny(denied.Id, Guid.NewGuid(), "keep");
        var now = DateTimeOffset.UtcNow;
        _store.Approve(first.Id, DeletionTiming.Immediate, Guid.NewGuid(), now);
        _store.Approve(same.Id, DeletionTiming.OneWeek, Guid.NewGuid(), now.AddDays(7));
        _store.MarkExecuted(first.Id, now);
        _store.CompleteMatchingRequests(first, now);
        Assert.Equal(DeletionRequestStatus.Executed, _store.Get(same.Id)!.Status);
        Assert.Equal(DeletionRequestStatus.Pending, _store.Get(changed.Id)!.Status);
        Assert.Equal(DeletionRequestStatus.Denied, _store.Get(denied.Id)!.Status);
        Assert.Contains("another request", _store.Get(same.Id)!.FailureReason);
        _store.CompleteMatchingRequests(first, now);
        Assert.Single(_store.ListAudit(same.Id), r => r.Action == "executed");
    }

    [Fact]
    public void OlderAuditSchemaGainsActorColumnAndKeepsHistory()
    {
        var created = _store.Create(Request());
        var database = Path.Combine(_dataPath, "plugins", "DeletionManager", "deletion-manager.db");
        using (var connection = new SqliteConnection($"Data Source={database}"))
        {
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "ALTER TABLE deletion_audit DROP COLUMN actor_id";
            command.ExecuteNonQuery();
        }
        var reopened = new DeletionRequestStore(_paths.Object);
        var row = Assert.Single(reopened.ListAudit(created.Id));
        Assert.Equal("submitted", row.Action);
        Assert.Null(row.ActorId);
        reopened.Deny(created.Id, Guid.NewGuid(), "keep");
        Assert.Equal(2, reopened.ListAudit(created.Id).Count);
    }

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        if (Directory.Exists(_dataPath)) Directory.Delete(_dataPath, true);
    }
}
