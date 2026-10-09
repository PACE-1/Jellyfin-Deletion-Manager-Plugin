using Jellyfin.Plugin.DeletionManager.Model;
using Jellyfin.Plugin.DeletionManager.Services;
using MediaBrowser.Common.Configuration;
using Microsoft.Data.Sqlite;
using Moq;

namespace Jellyfin.Plugin.DeletionManager.Tests;

public sealed class DeletionLegacyImportTests : IDisposable
{
    private readonly string _dataPath = Path.Combine(Path.GetTempPath(), "deletion-manager-tests", Guid.NewGuid().ToString("N"));
    private readonly string _legacyDirectory;
    private readonly string _legacyDb;
    private readonly DeletionRequestStore _store;

    public DeletionLegacyImportTests()
    {
        _legacyDirectory = Path.Combine(_dataPath, "plugins", "Jellyfin Enhanced");
        Directory.CreateDirectory(_legacyDirectory);
        _legacyDb = Path.Combine(_legacyDirectory, "deletion-manager.db");
        var paths = new Mock<IApplicationPaths>();
        paths.SetupGet(value => value.DataPath).Returns(_dataPath);
        _store = new DeletionRequestStore(paths.Object);
    }

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        if (Directory.Exists(_dataPath)) Directory.Delete(_dataPath, recursive: true);
    }

    [Fact]
    public void LegacySourcePathIsTheForksFixedDatabase()
    {
        Assert.Equal(_legacyDb, _store.LegacySourcePath);
    }

    [Fact]
    public void ImportsRowsThatOnlyExistInTheWalAndKeepsIdsAndAudit()
    {
        var requester = Guid.NewGuid();
        using var fork = CreateFork(withScopeColumns: true);
        // Keep the fork connection open and stop checkpointing: rows live only in deletion-manager.db-wal.
        Exec(fork, "PRAGMA wal_autocheckpoint = 0");
        InsertRequest(fork, 7, "Movie A", "movie", "approved", requester, scope: "ABC");
        InsertRequest(fork, 9, "Movie B", "movie", "executed", requester, scope: null);
        InsertAudit(fork, 1, 7, "approved");
        Assert.True(File.Exists(_legacyDb + "-wal") && new FileInfo(_legacyDb + "-wal").Length > 0);
        var before = File.ReadAllBytes(_legacyDb);

        var result = _store.ImportFromLegacy(_legacyDb, DateTimeOffset.UtcNow);

        Assert.Equal(2, result.RequestsImported);
        Assert.Equal(1, result.AuditImported);
        Assert.Empty(result.Conflicts);
        var imported = _store.Get(7);
        Assert.NotNull(imported);
        Assert.Equal("Movie A", imported!.ItemName);
        Assert.Equal(DeletionRequestStatus.Approved, imported.Status);
        Assert.Equal(requester, imported.RequesterId);
        Assert.Equal("ABC", imported.ScopeFingerprint);
        Assert.NotNull(_store.Get(9));
        Assert.Single(_store.ListAudit(7));
        Assert.Equal(before, File.ReadAllBytes(_legacyDb));
        // New requests continue after the highest imported id.
        var created = _store.Create(NewRequest());
        Assert.True(created.Id > 9);
    }

    [Fact]
    public void LegacyGroupRequestsWithoutScopeNeedRenewedConfirmation()
    {
        using var fork = CreateFork(withScopeColumns: false);
        InsertRequest(fork, 1, "Show", "series", "approved", Guid.NewGuid(), scope: null);
        InsertRequest(fork, 2, "Film", "movie", "approved", Guid.NewGuid(), scope: null);

        _store.ImportFromLegacy(_legacyDb, DateTimeOffset.UtcNow);

        Assert.Equal(DeletionRequestStatus.Blocked, _store.Get(1)!.Status);
        Assert.Equal(DeletionRequestStatus.Approved, _store.Get(2)!.Status);
    }

    [Fact]
    public void RepeatingTheImportIsHarmless()
    {
        using var fork = CreateFork(withScopeColumns: true);
        InsertRequest(fork, 1, "Movie A", "movie", "approved", Guid.NewGuid(), scope: null);
        InsertAudit(fork, 1, 1, "approved");
        _store.ImportFromLegacy(_legacyDb, DateTimeOffset.UtcNow);

        var second = _store.ImportFromLegacy(_legacyDb, DateTimeOffset.UtcNow);

        Assert.Equal(0, second.RequestsImported);
        Assert.Equal(0, second.AuditImported);
        Assert.Empty(second.Conflicts);
        Assert.Single(_store.List());
        Assert.Single(_store.ListAudit(1));
    }

    [Fact]
    public void RowsChangedHereAfterTheImportAreNotReportedAsConflictsOnARepeat()
    {
        using var fork = CreateFork(withScopeColumns: true);
        InsertRequest(fork, 1, "Show", "series", "approved", Guid.NewGuid(), scope: null);
        InsertRequest(fork, 2, "Film", "movie", "pending", Guid.NewGuid(), scope: "ABC");
        _store.ImportFromLegacy(_legacyDb, DateTimeOffset.UtcNow);
        // The import itself blocked row 1; an admin has since handled row 2 here.
        Assert.Equal(DeletionRequestStatus.Blocked, _store.Get(1)!.Status);
        _store.Deny(2, Guid.NewGuid(), "no");

        var second = _store.ImportFromLegacy(_legacyDb, DateTimeOffset.UtcNow);

        Assert.Empty(second.Conflicts);
        Assert.Equal(0, second.RequestsImported);
        Assert.Equal(DeletionRequestStatus.Blocked, _store.Get(1)!.Status);
        Assert.Equal(DeletionRequestStatus.Denied, _store.Get(2)!.Status);
        Assert.Single(_store.ListAudit(1));
    }

    [Fact]
    public void ALaterImportAddsNewRowsButNeverOverwritesChangedOnes()
    {
        using var fork = CreateFork(withScopeColumns: true);
        InsertRequest(fork, 1, "Movie A", "movie", "approved", Guid.NewGuid(), scope: null);
        _store.ImportFromLegacy(_legacyDb, DateTimeOffset.UtcNow);
        Exec(fork, "UPDATE deletion_requests SET status = 'cancelled' WHERE id = 1");
        InsertRequest(fork, 2, "Movie B", "movie", "pending", Guid.NewGuid(), scope: null);

        var result = _store.ImportFromLegacy(_legacyDb, DateTimeOffset.UtcNow);

        Assert.Equal(1, result.RequestsImported);
        Assert.Equal([1L], result.Conflicts);
        Assert.Equal(DeletionRequestStatus.Approved, _store.Get(1)!.Status);
        Assert.NotNull(_store.Get(2));
    }

    [Fact]
    public void RefusesToMixIdRangesWhenThePluginAlreadyHasItsOwnRequests()
    {
        _store.Create(NewRequest());
        using var fork = CreateFork(withScopeColumns: true);
        InsertRequest(fork, 1, "Movie A", "movie", "approved", Guid.NewGuid(), scope: null);

        Assert.Throws<InvalidOperationException>(() => _store.ImportFromLegacy(_legacyDb, DateTimeOffset.UtcNow));
        Assert.Single(_store.List());
    }

    [Fact]
    public void RejectsADatabaseThatIsNotADeletionDatabaseWithoutImportingAnything()
    {
        using (var other = new SqliteConnection($"Data Source={_legacyDb}"))
        {
            other.Open();
            Exec(other, "CREATE TABLE unrelated (id INTEGER)");
        }
        SqliteConnection.ClearAllPools();

        Assert.Throws<InvalidOperationException>(() => _store.ImportFromLegacy(_legacyDb, DateTimeOffset.UtcNow));
        Assert.Empty(_store.List());
    }

    [Fact]
    public void MissingSourceIsReported()
    {
        Assert.Throws<FileNotFoundException>(() => _store.ImportFromLegacy(Path.Combine(_dataPath, "nope.db"), DateTimeOffset.UtcNow));
    }

    private SqliteConnection CreateFork(bool withScopeColumns)
    {
        var connection = new SqliteConnection($"Data Source={_legacyDb};Pooling=False");
        connection.Open();
        Exec(connection, "PRAGMA journal_mode = WAL");
        Exec(connection, $"""
            CREATE TABLE deletion_requests (
              id INTEGER PRIMARY KEY AUTOINCREMENT, jellyfin_item_id TEXT NOT NULL, item_name TEXT NOT NULL,
              item_type TEXT NOT NULL, item_count INTEGER NOT NULL, requester_id TEXT NOT NULL, requester_name TEXT NOT NULL,
              source TEXT NOT NULL, status TEXT NOT NULL, timing TEXT NULL, execute_at TEXT NULL, approved_by TEXT NULL,
              approved_at TEXT NULL, executed_at TEXT NULL, failure_reason TEXT NULL{(withScopeColumns ? ", requester_reason TEXT NULL, scope_fingerprint TEXT NULL" : "")},
              created_at TEXT NOT NULL);
            CREATE TABLE deletion_audit (
              id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL, action TEXT NOT NULL, reason TEXT NULL,
              occurred_at TEXT NOT NULL, FOREIGN KEY(request_id) REFERENCES deletion_requests(id));
            """);
        return connection;
    }

    private static void InsertRequest(SqliteConnection connection, long id, string name, string type, string status, Guid requester, string? scope)
    {
        var hasScope = Columns(connection).Contains("scope_fingerprint");
        using var command = connection.CreateCommand();
        command.CommandText = $"""
            INSERT INTO deletion_requests (id, jellyfin_item_id, item_name, item_type, item_count, requester_id, requester_name, source, status, timing, execute_at, created_at{(hasScope ? ", scope_fingerprint" : "")})
            VALUES ($id, $item, $name, $type, 1, $requester, 'user', 'jellyfin', $status, 'immediate', '2026-10-01T00:00:00.0000000+00:00', '2026-09-30T00:00:00.0000000+00:00'{(hasScope ? ", $scope" : "")})
            """;
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.AddWithValue("$item", Guid.NewGuid().ToString("N"));
        command.Parameters.AddWithValue("$name", name);
        command.Parameters.AddWithValue("$type", type);
        command.Parameters.AddWithValue("$requester", requester.ToString("N"));
        command.Parameters.AddWithValue("$status", status);
        if (hasScope) command.Parameters.AddWithValue("$scope", (object?)scope ?? DBNull.Value);
        command.ExecuteNonQuery();
    }

    private static void InsertAudit(SqliteConnection connection, long id, long requestId, string action)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "INSERT INTO deletion_audit (id, request_id, action, reason, occurred_at) VALUES ($id, $request, $action, NULL, '2026-10-01T00:00:00.0000000+00:00')";
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.AddWithValue("$request", requestId);
        command.Parameters.AddWithValue("$action", action);
        command.ExecuteNonQuery();
    }

    private static HashSet<string> Columns(SqliteConnection connection)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA table_info(deletion_requests)";
        using var reader = command.ExecuteReader();
        var names = new HashSet<string>();
        while (reader.Read()) names.Add(reader.GetString(reader.GetOrdinal("name")));
        return names;
    }

    private static void Exec(SqliteConnection connection, string sql)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    private static DeletionRequest NewRequest() => new()
    {
        JellyfinItemId = Guid.NewGuid(),
        ItemName = "Own request",
        ItemType = "movie",
        ItemCount = 1,
        RequesterId = Guid.NewGuid(),
        RequesterName = "user",
        Source = "jellyfin",
        Status = DeletionRequestStatus.Pending,
        CreatedAt = DateTimeOffset.UtcNow
    };
}
