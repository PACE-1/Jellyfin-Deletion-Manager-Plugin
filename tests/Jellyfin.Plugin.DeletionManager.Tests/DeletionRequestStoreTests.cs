using System.Text.Json;
using Jellyfin.Plugin.DeletionManager.Model;
using Jellyfin.Plugin.DeletionManager.Services;
using MediaBrowser.Common.Configuration;
using Microsoft.Data.Sqlite;
using Moq;

namespace Jellyfin.Plugin.DeletionManager.Tests;

public sealed class DeletionRequestStoreTests : IDisposable
{
    private readonly string _dataPath = Path.Combine(Path.GetTempPath(), "deletion-manager-tests", Guid.NewGuid().ToString("N"));
    private readonly DeletionRequestStore _store;

    public DeletionRequestStoreTests()
    {
        var applicationPaths = new Mock<IApplicationPaths>();
        applicationPaths.SetupGet(paths => paths.DataPath).Returns(_dataPath);
        _store = new DeletionRequestStore(applicationPaths.Object);
    }

    [Fact]
    public void CreateRoundTripsAllRequestFields()
    {
        var request = NewRequest();

        var created = _store.Create(request);
        var loaded = _store.Get(created.Id);

        Assert.NotNull(loaded);
        Assert.Equal(created, loaded);
    }

    [Fact]
    public void ListByRequesterDoesNotExposeOtherUsersRequests()
    {
        var requester = Guid.NewGuid();
        var otherRequester = Guid.NewGuid();
        _store.Create(NewRequest(requester));
        _store.Create(NewRequest(otherRequester));

        var results = _store.List(requester);

        var request = Assert.Single(results);
        Assert.Equal(requester, request.RequesterId);
    }

    [Fact]
    public void ApproveOnlyTransitionsPendingRequests()
    {
        var request = _store.Create(NewRequest());
        var approver = Guid.NewGuid();
        var executeAt = DateTimeOffset.UtcNow.AddDays(7);

        _store.Approve(request.Id, DeletionTiming.OneWeek, approver, executeAt);
        var approved = _store.Get(request.Id);
        Assert.NotNull(approved);

        Assert.Equal(DeletionRequestStatus.Approved, approved!.Status);
        Assert.Equal(DeletionTiming.OneWeek, approved.Timing);
        Assert.Equal(approver, approved.ApprovedBy);
        Assert.Equal(executeAt, approved.ExecuteAt);
        Assert.Throws<InvalidOperationException>(() => _store.Deny(request.Id, approver, "too late"));
    }

    [Fact]
    public void DenyRecordsReasonAndPreventsApproval()
    {
        var request = _store.Create(NewRequest());
        var approver = Guid.NewGuid();

        _store.Deny(request.Id, approver, "Keep this title");
        var denied = _store.Get(request.Id);
        Assert.NotNull(denied);

        Assert.Equal(DeletionRequestStatus.Denied, denied!.Status);
        Assert.Equal("Keep this title", denied.FailureReason);
        Assert.Equal(approver, denied.ApprovedBy);
        Assert.Throws<InvalidOperationException>(() => _store.Approve(request.Id, DeletionTiming.Immediate, approver, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void ListDueReturnsOnlyApprovedRequestsPastTheirExecutionTimeInOrder()
    {
        var now = DateTimeOffset.Parse("2026-09-23T12:00:00Z");
        var laterDue = _store.Create(NewRequest());
        var earlierDue = _store.Create(NewRequest());
        var future = _store.Create(NewRequest());
        var denied = _store.Create(NewRequest());
        var approver = Guid.NewGuid();

        _store.Approve(laterDue.Id, DeletionTiming.Immediate, approver, now.AddMinutes(-1));
        _store.Approve(earlierDue.Id, DeletionTiming.Immediate, approver, now.AddMinutes(-5));
        _store.Approve(future.Id, DeletionTiming.OneWeek, approver, now.AddMinutes(1));
        _store.Deny(denied.Id, approver, "not approved");

        var due = _store.ListDue(now);

        Assert.Collection(due,
            request => Assert.Equal(earlierDue.Id, request.Id),
            request => Assert.Equal(laterDue.Id, request.Id));
    }

    [Fact]
    public void ExecutionTransitionsWriteAuditEntries()
    {
        var now = DateTimeOffset.Parse("2026-09-23T12:00:00Z");
        var executed = _store.Create(NewRequest());
        var failed = _store.Create(NewRequest());
        var requeued = _store.Create(NewRequest());
        var approver = Guid.NewGuid();
        _store.Approve(executed.Id, DeletionTiming.Immediate, approver, now);
        _store.Approve(failed.Id, DeletionTiming.Immediate, approver, now);
        _store.Approve(requeued.Id, DeletionTiming.Immediate, approver, now);

        _store.MarkExecuted(executed.Id, now);
        _store.MarkFailed(failed.Id, now, "permission denied");
        _store.Requeue(requeued.Id, now.AddMinutes(15), now, "currently playing");

        Assert.Equal("executed", Assert.Single(_store.ListAudit(executed.Id)).Action);
        Assert.Equal("failed", Assert.Single(_store.ListAudit(failed.Id)).Action);
        var requeueAudit = Assert.Single(_store.ListAudit(requeued.Id));
        Assert.Equal("requeued", requeueAudit.Action);
        Assert.Equal("currently playing", requeueAudit.Reason);
        Assert.Equal(DeletionRequestStatus.Approved, _store.Get(requeued.Id)!.Status);
    }

    [Fact]
    public void CreateRoundTripsRequesterReason()
    {
        var withReason = _store.Create(NewRequest() with { RequesterReason = "space needed" });
        var loadedWithReason = _store.Get(withReason.Id);
        Assert.NotNull(loadedWithReason);
        Assert.Equal("space needed", loadedWithReason!.RequesterReason);

        var withoutReason = _store.Create(NewRequest());
        var loadedWithoutReason = _store.Get(withoutReason.Id);
        Assert.NotNull(loadedWithoutReason);
        Assert.Null(loadedWithoutReason!.RequesterReason);
    }

    [Fact]
    public void InitializeMigratesLegacySchemaWithoutRequesterReason()
    {
        var legacyDataPath = Path.Combine(Path.GetTempPath(), "deletion-manager-tests-legacy", Guid.NewGuid().ToString("N"));
        try
        {
            var directory = Path.Combine(legacyDataPath, "plugins", "DeletionManager");
            Directory.CreateDirectory(directory);
            var dbPath = Path.Combine(directory, "deletion-manager.db");

            using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            {
                DataSource = dbPath,
                Mode = SqliteOpenMode.ReadWriteCreate,
                Cache = SqliteCacheMode.Shared
            }.ToString()))
            {
                connection.Open();
                using var create = connection.CreateCommand();
                create.CommandText = """
                    CREATE TABLE deletion_requests (
                      id INTEGER PRIMARY KEY AUTOINCREMENT,
                      jellyfin_item_id TEXT NOT NULL,
                      item_name TEXT NOT NULL,
                      item_type TEXT NOT NULL,
                      item_count INTEGER NOT NULL,
                      requester_id TEXT NOT NULL,
                      requester_name TEXT NOT NULL,
                      source TEXT NOT NULL,
                      status TEXT NOT NULL,
                      timing TEXT NULL,
                      execute_at TEXT NULL,
                      approved_by TEXT NULL,
                      approved_at TEXT NULL,
                      executed_at TEXT NULL,
                      failure_reason TEXT NULL,
                      created_at TEXT NOT NULL
                    );
                    CREATE TABLE deletion_audit (
                      id INTEGER PRIMARY KEY AUTOINCREMENT,
                      request_id INTEGER NOT NULL,
                      action TEXT NOT NULL,
                      reason TEXT NULL,
                      occurred_at TEXT NOT NULL,
                      FOREIGN KEY(request_id) REFERENCES deletion_requests(id)
                    );
                    """;
                create.ExecuteNonQuery();

                using var insert = connection.CreateCommand();
                insert.CommandText = """
                    INSERT INTO deletion_requests
                      (jellyfin_item_id, item_name, item_type, item_count, requester_id, requester_name,
                       source, status, timing, execute_at, approved_by, approved_at, executed_at,
                       failure_reason, created_at)
                    VALUES ($item_id, 'Legacy Movie', 'movie', 1, $requester_id, 'legacy-tester',
                            'jellyfin', 'pending', NULL, NULL, NULL, NULL, NULL, NULL, $created_at);
                    """;
                insert.Parameters.AddWithValue("$item_id", Guid.NewGuid().ToString("N"));
                insert.Parameters.AddWithValue("$requester_id", Guid.NewGuid().ToString("N"));
                insert.Parameters.AddWithValue("$created_at", DateTimeOffset.UtcNow.ToString("O"));
                insert.ExecuteNonQuery();
            }

            var applicationPaths = new Mock<IApplicationPaths>();
            applicationPaths.SetupGet(paths => paths.DataPath).Returns(legacyDataPath);
            var migratedStore = new DeletionRequestStore(applicationPaths.Object);

            var loaded = migratedStore.Get(1);
            Assert.NotNull(loaded);
            Assert.Null(loaded!.RequesterReason);

            var created = migratedStore.Create(NewRequest() with { RequesterReason = "space needed" });
            var reloaded = migratedStore.Get(created.Id);
            Assert.NotNull(reloaded);
            Assert.Equal("space needed", reloaded!.RequesterReason);
        }
        finally
        {
            if (Directory.Exists(legacyDataPath)) Directory.Delete(legacyDataPath, recursive: true);
        }
    }

    [Fact]
    public void MarkBlockedWritesDistinctStatusAndAudit()
    {
        var request = _store.Create(NewRequest());
        var approver = Guid.NewGuid();
        var now = DateTimeOffset.Parse("2026-09-23T12:00:00Z");
        _store.Approve(request.Id, DeletionTiming.Immediate, approver, now);

        _store.MarkBlocked(request.Id, now, "favorite");

        var blocked = _store.Get(request.Id);
        Assert.NotNull(blocked);
        Assert.Equal(DeletionRequestStatus.Blocked, blocked!.Status);
        Assert.Equal("favorite", blocked.FailureReason);
        var audit = Assert.Single(_store.ListAudit(request.Id));
        Assert.Equal("blocked", audit.Action);

        Assert.Throws<InvalidOperationException>(() => _store.MarkBlocked(request.Id, now, "favorite"));
    }

    [Fact]
    public void BlockedSerializesAsString()
    {
        var request = NewRequest() with { Status = DeletionRequestStatus.Blocked };

        var json = JsonSerializer.Serialize(request);

        Assert.Contains("\"Status\":\"Blocked\"", json);
    }

    public void Dispose()
    {
        if (Directory.Exists(_dataPath)) Directory.Delete(_dataPath, recursive: true);
    }

    private static DeletionRequest NewRequest(Guid? requesterId = null) => new()
    {
        JellyfinItemId = Guid.NewGuid(),
        ItemName = "Test Movie",
        ItemType = "movie",
        ItemCount = 1,
        RequesterId = requesterId ?? Guid.NewGuid(),
        RequesterName = "tester",
        Source = "jellyfin",
        Status = DeletionRequestStatus.Pending,
        CreatedAt = DateTimeOffset.UtcNow
    };
}
