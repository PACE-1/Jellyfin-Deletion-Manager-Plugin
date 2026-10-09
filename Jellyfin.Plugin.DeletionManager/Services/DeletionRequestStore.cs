using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;
using MediaBrowser.Common.Configuration;
using Jellyfin.Plugin.DeletionManager.Model;

namespace Jellyfin.Plugin.DeletionManager.Services;

public sealed class DeletionRequestStore
{
    private readonly string _connectionString;
    private readonly string _directory;

    public DeletionRequestStore(IApplicationPaths applicationPaths)
    {
        var directory = Path.Combine(applicationPaths.DataPath, "plugins", "DeletionManager");
        Directory.CreateDirectory(directory);
        _directory = directory;
        LegacySourcePath = Path.Combine(applicationPaths.DataPath, "plugins", "Jellyfin Enhanced", "deletion-manager.db");
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = Path.Combine(directory, "deletion-manager.db"),
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Shared
        }.ToString();
        Initialize();
    }

    /// <summary>Database of the V1.0 Jellyfin Enhanced fork. Fixed path: import never reads a caller-supplied file.</summary>
    public string LegacySourcePath { get; }

    public DeletionRequest Create(DeletionRequest request)
    {
        using var connection = Open();
        // An immediate writer transaction serializes submissions, including retries
        // whose first response was lost. Historical requests never prevent a new one.
        using var transaction = connection.BeginTransaction();
        using (var existing = connection.CreateCommand())
        {
            existing.Transaction = transaction;
            existing.CommandText = "SELECT * FROM deletion_requests WHERE requester_id = $user AND jellyfin_item_id = $item AND status IN ('pending', 'approved') ORDER BY id LIMIT 1";
            existing.Parameters.AddWithValue("$user", request.RequesterId.ToString("N"));
            existing.Parameters.AddWithValue("$item", request.JellyfinItemId.ToString("N"));
            using var reader = existing.ExecuteReader();
            if (reader.Read())
            {
                var saved = Read(reader);
                if (saved.ItemType != request.ItemType || saved.ItemCount != request.ItemCount
                    || saved.ScopeFingerprint != request.ScopeFingerprint || saved.RequesterReason != request.RequesterReason)
                {
                    throw new InvalidOperationException("An active request already exists for this item with a different scope or reason. Review that request first.");
                }
                return saved;
            }
        }
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            INSERT INTO deletion_requests
              (jellyfin_item_id, item_name, item_type, item_count, requester_id, requester_name,
               source, status, timing, execute_at, approved_by, approved_at, executed_at,
               failure_reason, requester_reason, scope_fingerprint, created_at)
            VALUES ($item_id, $item_name, $item_type, $item_count, $requester_id, $requester_name,
                    $source, $status, $timing, $execute_at, $approved_by, $approved_at,
                    $executed_at, $failure_reason, $requester_reason, $scope_fingerprint, $created_at);
            SELECT last_insert_rowid();
            """;
        Bind(command, request);
        var id = (long)(command.ExecuteScalar() ?? throw new InvalidOperationException("Request insert returned no id."));
        transaction.Commit();
        return request with { Id = id };
    }

    public DeletionRequest? Get(long id)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT * FROM deletion_requests WHERE id = $id";
        command.Parameters.AddWithValue("$id", id);
        using var reader = command.ExecuteReader();
        return reader.Read() ? Read(reader) : null;
    }

    public IReadOnlyList<DeletionRequest> List(Guid? requesterId = null)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = requesterId.HasValue
            ? "SELECT * FROM deletion_requests WHERE requester_id = $requester_id ORDER BY created_at DESC"
            : "SELECT * FROM deletion_requests ORDER BY created_at DESC";
        if (requesterId.HasValue) command.Parameters.AddWithValue("$requester_id", requesterId.Value.ToString("N"));
        return ReadAll(command);
    }

    public IReadOnlyList<DeletionRequest> ListDue(DateTimeOffset now)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT * FROM deletion_requests
            WHERE status = $approved AND execute_at IS NOT NULL AND execute_at <= $now
            ORDER BY execute_at ASC, id ASC
            """;
        command.Parameters.AddWithValue("$approved", DeletionRequestStatus.Approved.ToString().ToLowerInvariant());
        command.Parameters.AddWithValue("$now", now.ToUniversalTime().ToString("O"));
        return ReadAll(command);
    }

    public void Approve(long id, DeletionTiming timing, Guid approverId, DateTimeOffset executeAt)
    {
        UpdateDecision(id, DeletionRequestStatus.Approved, timing, approverId, executeAt, null);
    }

    public void Deny(long id, Guid approverId, string? reason)
    {
        UpdateDecision(id, DeletionRequestStatus.Denied, null, approverId, null, reason);
    }

    public void MarkExecuted(long id, DateTimeOffset executedAt)
    {
        UpdateExecution(id, "executed", executedAt, null, null);
    }

    public void MarkFailed(long id, DateTimeOffset failedAt, string reason)
    {
        UpdateExecution(id, "failed", failedAt, null, reason);
    }

    public void MarkBlocked(long id, DateTimeOffset occurredAt, string reason)
    {
        UpdateExecution(id, "blocked", occurredAt, null, reason);
    }

    public void Requeue(long id, DateTimeOffset nextAttemptAt, DateTimeOffset occurredAt, string reason)
    {
        UpdateExecution(id, "requeued", occurredAt, nextAttemptAt, reason);
    }

    public void Cancel(long id, DateTimeOffset occurredAt, string reason)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            UPDATE deletion_requests
            SET status = $status, failure_reason = $failure_reason
            WHERE id = $id AND status = $approved AND executed_at IS NULL
              AND execute_at IS NOT NULL AND execute_at > $now
            """;
        command.Parameters.AddWithValue("$status", DeletionRequestStatus.Cancelled.ToString().ToLowerInvariant());
        command.Parameters.AddWithValue("$failure_reason", reason);
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.AddWithValue("$approved", DeletionRequestStatus.Approved.ToString().ToLowerInvariant());
        command.Parameters.AddWithValue("$now", occurredAt.ToUniversalTime().ToString("O"));
        if (command.ExecuteNonQuery() != 1) throw new InvalidOperationException("Request is missing, not approved, already due, or already executed.");

        InsertAudit(connection, transaction, id, "cancelled", reason, occurredAt);
        transaction.Commit();
    }

    public IReadOnlyList<DeletionAuditEntry> ListAudit(long requestId)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT id, request_id, action, reason, occurred_at FROM deletion_audit WHERE request_id = $request_id ORDER BY occurred_at ASC, id ASC";
        command.Parameters.AddWithValue("$request_id", requestId);
        using var reader = command.ExecuteReader();
        var results = new List<DeletionAuditEntry>();
        while (reader.Read())
        {
            results.Add(new DeletionAuditEntry
            {
                Id = reader.GetInt64(0),
                RequestId = reader.GetInt64(1),
                Action = reader.GetString(2),
                Reason = reader.IsDBNull(3) ? null : reader.GetString(3),
                OccurredAt = DateTimeOffset.Parse(reader.GetString(4))
            });
        }

        return results;
    }

    private void UpdateDecision(long id, DeletionRequestStatus status, DeletionTiming? timing, Guid approverId, DateTimeOffset? executeAt, string? reason)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE deletion_requests
            SET status = $status, timing = $timing, approved_by = $approved_by,
                approved_at = $approved_at, execute_at = $execute_at, failure_reason = $failure_reason
            WHERE id = $id AND status = $pending;
            """;
        command.Parameters.AddWithValue("$status", status.ToString().ToLowerInvariant());
        command.Parameters.AddWithValue("$timing", (object?)timing?.ToString().ToLowerInvariant() ?? DBNull.Value);
        command.Parameters.AddWithValue("$approved_by", approverId.ToString("N"));
        command.Parameters.AddWithValue("$approved_at", DateTimeOffset.UtcNow.ToString("O"));
        command.Parameters.AddWithValue("$execute_at", (object?)executeAt?.ToString("O") ?? DBNull.Value);
        command.Parameters.AddWithValue("$failure_reason", (object?)reason ?? DBNull.Value);
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.AddWithValue("$pending", DeletionRequestStatus.Pending.ToString().ToLowerInvariant());
        if (command.ExecuteNonQuery() != 1) throw new InvalidOperationException("Request is missing or is no longer pending.");
    }

    private void UpdateExecution(long id, string action, DateTimeOffset occurredAt, DateTimeOffset? nextAttemptAt, string? reason)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = action == "requeued"
            ? "UPDATE deletion_requests SET execute_at = $execute_at, failure_reason = $failure_reason WHERE id = $id AND status = $approved"
            : "UPDATE deletion_requests SET status = $status, executed_at = $executed_at, failure_reason = $failure_reason WHERE id = $id AND status = $approved";
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.AddWithValue("$approved", DeletionRequestStatus.Approved.ToString().ToLowerInvariant());
        command.Parameters.AddWithValue("$status", action);
        command.Parameters.AddWithValue("$executed_at", occurredAt.ToUniversalTime().ToString("O"));
        command.Parameters.AddWithValue("$execute_at", (object?)nextAttemptAt?.ToUniversalTime().ToString("O") ?? DBNull.Value);
        command.Parameters.AddWithValue("$failure_reason", (object?)reason ?? DBNull.Value);
        if (command.ExecuteNonQuery() != 1) throw new InvalidOperationException("Request is missing or is no longer approved.");

        InsertAudit(connection, transaction, id, action, reason, occurredAt);
        transaction.Commit();
    }

    private static void InsertAudit(SqliteConnection connection, SqliteTransaction transaction, long id, string action, string? reason, DateTimeOffset occurredAt)
    {
        using var audit = connection.CreateCommand();
        audit.Transaction = transaction;
        audit.CommandText = "INSERT INTO deletion_audit (request_id, action, reason, occurred_at) VALUES ($request_id, $action, $reason, $occurred_at)";
        audit.Parameters.AddWithValue("$request_id", id);
        audit.Parameters.AddWithValue("$action", action);
        audit.Parameters.AddWithValue("$reason", (object?)reason ?? DBNull.Value);
        audit.Parameters.AddWithValue("$occurred_at", occurredAt.ToUniversalTime().ToString("O"));
        audit.ExecuteNonQuery();
    }

    private static List<DeletionRequest> ReadAll(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var results = new List<DeletionRequest>();
        while (reader.Read()) results.Add(Read(reader));
        return results;
    }

    private SqliteConnection Open()
    {
        var connection = new SqliteConnection(_connectionString);
        connection.Open();
        return connection;
    }

    private static void Bind(SqliteCommand command, DeletionRequest request)
    {
        command.Parameters.AddWithValue("$item_id", request.JellyfinItemId.ToString("N"));
        command.Parameters.AddWithValue("$item_name", request.ItemName);
        command.Parameters.AddWithValue("$item_type", request.ItemType);
        command.Parameters.AddWithValue("$item_count", request.ItemCount);
        command.Parameters.AddWithValue("$requester_id", request.RequesterId.ToString("N"));
        command.Parameters.AddWithValue("$requester_name", request.RequesterName);
        command.Parameters.AddWithValue("$source", request.Source);
        command.Parameters.AddWithValue("$status", request.Status.ToString().ToLowerInvariant());
        command.Parameters.AddWithValue("$timing", (object?)request.Timing?.ToString().ToLowerInvariant() ?? DBNull.Value);
        command.Parameters.AddWithValue("$execute_at", (object?)request.ExecuteAt?.ToString("O") ?? DBNull.Value);
        command.Parameters.AddWithValue("$approved_by", (object?)request.ApprovedBy?.ToString("N") ?? DBNull.Value);
        command.Parameters.AddWithValue("$approved_at", (object?)request.ApprovedAt?.ToString("O") ?? DBNull.Value);
        command.Parameters.AddWithValue("$executed_at", (object?)request.ExecutedAt?.ToString("O") ?? DBNull.Value);
        command.Parameters.AddWithValue("$failure_reason", (object?)request.FailureReason ?? DBNull.Value);
        command.Parameters.AddWithValue("$requester_reason", (object?)request.RequesterReason ?? DBNull.Value);
        command.Parameters.AddWithValue("$scope_fingerprint", (object?)request.ScopeFingerprint ?? DBNull.Value);
        command.Parameters.AddWithValue("$created_at", request.CreatedAt.ToString("O"));
    }

    private static DeletionRequest Read(SqliteDataReader reader)
    {
        return new DeletionRequest
        {
            Id = reader.GetInt64(reader.GetOrdinal("id")),
            JellyfinItemId = Guid.Parse(reader.GetString(reader.GetOrdinal("jellyfin_item_id"))),
            ItemName = reader.GetString(reader.GetOrdinal("item_name")),
            ItemType = reader.GetString(reader.GetOrdinal("item_type")),
            ItemCount = reader.GetInt32(reader.GetOrdinal("item_count")),
            RequesterId = Guid.Parse(reader.GetString(reader.GetOrdinal("requester_id"))),
            RequesterName = reader.GetString(reader.GetOrdinal("requester_name")),
            Source = reader.GetString(reader.GetOrdinal("source")),
            Status = Enum.Parse<DeletionRequestStatus>(reader.GetString(reader.GetOrdinal("status")), true),
            Timing = ReadNullableEnum<DeletionTiming>(reader, "timing"),
            ExecuteAt = ReadNullableDate(reader, "execute_at"),
            ApprovedBy = ReadNullableGuid(reader, "approved_by"),
            ApprovedAt = ReadNullableDate(reader, "approved_at"),
            ExecutedAt = ReadNullableDate(reader, "executed_at"),
            FailureReason = ReadNullableString(reader, "failure_reason"),
            RequesterReason = ReadNullableString(reader, "requester_reason"),
            ScopeFingerprint = ReadNullableString(reader, "scope_fingerprint"),
            CreatedAt = DateTimeOffset.Parse(reader.GetString(reader.GetOrdinal("created_at")))
        };
    }

    private static T? ReadNullableEnum<T>(SqliteDataReader reader, string name) where T : struct => reader.IsDBNull(reader.GetOrdinal(name)) ? null : Enum.Parse<T>(reader.GetString(reader.GetOrdinal(name)), true);
    private static DateTimeOffset? ReadNullableDate(SqliteDataReader reader, string name) => reader.IsDBNull(reader.GetOrdinal(name)) ? null : DateTimeOffset.Parse(reader.GetString(reader.GetOrdinal(name)));
    private static Guid? ReadNullableGuid(SqliteDataReader reader, string name) => reader.IsDBNull(reader.GetOrdinal(name)) ? null : Guid.Parse(reader.GetString(reader.GetOrdinal(name)));
    private static string? ReadNullableString(SqliteDataReader reader, string name) => reader.IsDBNull(reader.GetOrdinal(name)) ? null : reader.GetString(reader.GetOrdinal(name));

    private void Initialize()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS deletion_requests (
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
              requester_reason TEXT NULL,
              scope_fingerprint TEXT NULL,
              created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_deletion_requests_status ON deletion_requests(status, created_at);
            CREATE INDEX IF NOT EXISTS ix_deletion_requests_requester ON deletion_requests(requester_id, created_at);
            CREATE TABLE IF NOT EXISTS deletion_audit (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              request_id INTEGER NOT NULL,
              action TEXT NOT NULL,
              reason TEXT NULL,
              occurred_at TEXT NOT NULL,
              FOREIGN KEY(request_id) REFERENCES deletion_requests(id)
            );
            CREATE INDEX IF NOT EXISTS ix_deletion_audit_request ON deletion_audit(request_id, occurred_at);
            CREATE TABLE IF NOT EXISTS migration_log (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              source_path TEXT NOT NULL,
              source_checksum TEXT NOT NULL,
              requests_imported INTEGER NOT NULL,
              audit_imported INTEGER NOT NULL,
              conflicts TEXT NOT NULL,
              imported_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS migration_rows (
              request_id INTEGER PRIMARY KEY,
              source_hash TEXT NOT NULL
            );
            """;
        command.ExecuteNonQuery();

        EnsureColumn(connection, "requester_reason");
        EnsureColumn(connection, "scope_fingerprint");
        BlockUnconfirmedGroupRequests(connection);
    }

    private static void BlockUnconfirmedGroupRequests(SqliteConnection connection)
    {
        using var transaction = connection.BeginTransaction();
        var ids = new List<long>();
        using (var select = connection.CreateCommand())
        {
            select.Transaction = transaction;
            select.CommandText = "SELECT id FROM deletion_requests WHERE item_type IN ('series', 'season') AND scope_fingerprint IS NULL AND status IN ('pending', 'approved')";
            using var reader = select.ExecuteReader();
            while (reader.Read()) ids.Add(reader.GetInt64(0));
        }
        var now = DateTimeOffset.UtcNow;
        const string reason = "This legacy group request has no saved scope confirmation. Submit a new request to review the current items.";
        foreach (var id in ids)
        {
            using var update = connection.CreateCommand();
            update.Transaction = transaction;
            update.CommandText = "UPDATE deletion_requests SET status = 'blocked', failure_reason = $reason WHERE id = $id";
            update.Parameters.AddWithValue("$reason", reason);
            update.Parameters.AddWithValue("$id", id);
            update.ExecuteNonQuery();
            InsertAudit(connection, transaction, id, "blocked", reason, now);
        }
        transaction.Commit();
    }

    // CREATE TABLE IF NOT EXISTS does not add columns to an existing database.
    // Preserve old requests while adding the fixed columns supplied by Initialize.
    private static void EnsureColumn(SqliteConnection connection, string name)
    {
        using var check = connection.CreateCommand();
        check.CommandText = "PRAGMA table_info(deletion_requests)";
        using var reader = check.ExecuteReader();
        var exists = false;
        while (reader.Read())
        {
            if (string.Equals(reader.GetString(reader.GetOrdinal("name")), name, StringComparison.OrdinalIgnoreCase))
            {
                exists = true;
                break;
            }
        }

        reader.Close();

        if (!exists)
        {
            using var alter = connection.CreateCommand();
            // name is supplied only by Initialize's fixed column list.
            alter.CommandText = $"ALTER TABLE deletion_requests ADD COLUMN {name} TEXT NULL";
            alter.ExecuteNonQuery();
        }
    }

    private static readonly string[] RequestColumns =
    [
        "id", "jellyfin_item_id", "item_name", "item_type", "item_count", "requester_id", "requester_name",
        "source", "status", "timing", "execute_at", "approved_by", "approved_at", "executed_at",
        "failure_reason", "requester_reason", "scope_fingerprint", "created_at"
    ];

    private static readonly string[] AuditColumns = ["id", "request_id", "action", "reason", "occurred_at"];

    /// <summary>
    /// One-time, repeatable import from the V1.0 fork database. Takes a consistent copy through SQLite's
    /// online backup API (so committed WAL content is included), validates it, then inserts requests and
    /// audit rows with their original ids in one transaction. The source is never modified, rows already
    /// present are never overwritten (differing ids are reported as conflicts), and every row is
    /// re-read and compared before commit.
    /// </summary>
    public DeletionImportResult ImportFromLegacy(string sourcePath, DateTimeOffset now)
    {
        if (!File.Exists(sourcePath)) throw new FileNotFoundException("No V1.0 deletion database was found to import.", sourcePath);
        var temp = Path.Combine(_directory, $"import-{Guid.NewGuid():N}.db");
        try
        {
            using (var source = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = sourcePath, Mode = SqliteOpenMode.ReadOnly }.ToString()))
            using (var copy = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = temp, Mode = SqliteOpenMode.ReadWriteCreate, Pooling = false }.ToString()))
            {
                source.Open();
                copy.Open();
                source.BackupDatabase(copy);
            }

            List<object?[]> requests, audit;
            using (var copy = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = temp, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString()))
            {
                copy.Open();
                using (var check = copy.CreateCommand())
                {
                    check.CommandText = "PRAGMA integrity_check";
                    var result = check.ExecuteScalar() as string;
                    if (!string.Equals(result, "ok", StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException($"The V1.0 database copy failed its integrity check: {result}");
                }
                requests = ReadRows(copy, "deletion_requests", RequestColumns, optional: ["requester_reason", "scope_fingerprint"]);
                audit = ReadRows(copy, "deletion_audit", AuditColumns, optional: []);
            }

            var checksum = Checksum(requests, audit);
            using var connection = Open();
            using var transaction = connection.BeginTransaction();
            var existingIds = new Dictionary<long, object?[]>();
            foreach (var row in ReadRows(connection, "deletion_requests", RequestColumns, optional: [], transaction))
                existingIds[Convert.ToInt64(row[0], CultureInfo.InvariantCulture)] = row;
            var hasPriorImport = Scalar(connection, transaction, "SELECT COUNT(*) FROM migration_log") > 0;
            if (existingIds.Count > 0 && !hasPriorImport)
                throw new InvalidOperationException("This plugin already has its own requests, so a V1.0 import would mix two id ranges. Import into a fresh install.");

            // What each imported row looked like in the source. A repeat import compares the source with this
            // snapshot, so a row the admin has since approved, denied or blocked here is not a conflict; only a
            // row that changed in the V1.0 database after the earlier import is.
            var importedHashes = new Dictionary<long, string>();
            using (var hashes = connection.CreateCommand())
            {
                hashes.Transaction = transaction;
                hashes.CommandText = "SELECT request_id, source_hash FROM migration_rows";
                using var reader = hashes.ExecuteReader();
                while (reader.Read()) importedHashes[reader.GetInt64(0)] = reader.GetString(1);
            }

            var conflicts = new List<long>();
            var inserted = new HashSet<long>();
            var importedRequests = 0;
            foreach (var row in requests)
            {
                var id = Convert.ToInt64(row[0], CultureInfo.InvariantCulture);
                if (existingIds.TryGetValue(id, out var present))
                {
                    var differs = importedHashes.TryGetValue(id, out var snapshot)
                        ? !string.Equals(snapshot, RowHash(row), StringComparison.Ordinal)
                        : !RowsEqual(present, row);
                    if (differs) conflicts.Add(id);
                    continue;
                }
                Insert(connection, transaction, "deletion_requests", RequestColumns, row);
                using (var snapshotCommand = connection.CreateCommand())
                {
                    snapshotCommand.Transaction = transaction;
                    snapshotCommand.CommandText = "INSERT INTO migration_rows (request_id, source_hash) VALUES ($id, $hash)";
                    snapshotCommand.Parameters.AddWithValue("$id", id);
                    snapshotCommand.Parameters.AddWithValue("$hash", RowHash(row));
                    snapshotCommand.ExecuteNonQuery();
                }
                inserted.Add(id);
                importedRequests++;
            }

            var existingAudit = new HashSet<long>();
            using (var audits = connection.CreateCommand())
            {
                audits.Transaction = transaction;
                audits.CommandText = "SELECT id FROM deletion_audit";
                using var reader = audits.ExecuteReader();
                while (reader.Read()) existingAudit.Add(reader.GetInt64(0));
            }
            var importedAudit = 0;
            foreach (var row in audit)
            {
                if (existingAudit.Contains(Convert.ToInt64(row[0], CultureInfo.InvariantCulture))) continue;
                if (conflicts.Contains(Convert.ToInt64(row[1], CultureInfo.InvariantCulture))) continue;
                Insert(connection, transaction, "deletion_audit", AuditColumns, row);
                importedAudit++;
            }

            // Row-level verification against the validated copy before anything is committed.
            var after = new Dictionary<long, object?[]>();
            foreach (var row in ReadRows(connection, "deletion_requests", RequestColumns, optional: [], transaction))
                after[Convert.ToInt64(row[0], CultureInfo.InvariantCulture)] = row;
            foreach (var row in requests)
            {
                var id = Convert.ToInt64(row[0], CultureInfo.InvariantCulture);
                if (!inserted.Contains(id)) continue;
                if (!after.TryGetValue(id, out var saved) || !RowsEqual(saved, row))
                    throw new InvalidOperationException($"Import verification failed for request {id}; nothing was imported.");
            }

            using (var log = connection.CreateCommand())
            {
                log.Transaction = transaction;
                log.CommandText = "INSERT INTO migration_log (source_path, source_checksum, requests_imported, audit_imported, conflicts, imported_at) VALUES ($path, $checksum, $requests, $audit, $conflicts, $at)";
                log.Parameters.AddWithValue("$path", sourcePath);
                log.Parameters.AddWithValue("$checksum", checksum);
                log.Parameters.AddWithValue("$requests", importedRequests);
                log.Parameters.AddWithValue("$audit", importedAudit);
                log.Parameters.AddWithValue("$conflicts", string.Join(",", conflicts));
                log.Parameters.AddWithValue("$at", now.ToUniversalTime().ToString("O"));
                log.ExecuteNonQuery();
            }
            transaction.Commit();
            // Group requests without a saved scope confirmation need renewed confirmation.
            BlockUnconfirmedGroupRequests(connection);
            return new DeletionImportResult(importedRequests, importedAudit, conflicts, checksum);
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            foreach (var suffix in new[] { "", "-wal", "-shm", "-journal" })
            {
                try { File.Delete(temp + suffix); } catch (IOException) { /* best-effort temp cleanup */ }
            }
        }
    }

    private static List<object?[]> ReadRows(SqliteConnection connection, string table, string[] columns, string[] optional, SqliteTransaction? transaction = null)
    {
        var present = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        using (var info = connection.CreateCommand())
        {
            info.Transaction = transaction;
            info.CommandText = $"PRAGMA table_info({table})";
            using var reader = info.ExecuteReader();
            while (reader.Read()) present.Add(reader.GetString(reader.GetOrdinal("name")));
        }
        foreach (var column in columns)
        {
            if (!present.Contains(column) && Array.IndexOf(optional, column) < 0)
                throw new InvalidOperationException($"The V1.0 database has no {table}.{column}; it is not a deletion database this version can import.");
        }
        var select = string.Join(", ", columns.Select(column => present.Contains(column) ? column : "NULL"));
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"SELECT {select} FROM {table} ORDER BY id";
        using var rows = command.ExecuteReader();
        var result = new List<object?[]>();
        while (rows.Read())
        {
            var values = new object?[columns.Length];
            for (var index = 0; index < columns.Length; index++) values[index] = rows.IsDBNull(index) ? null : rows.GetValue(index);
            result.Add(values);
        }
        return result;
    }

    private static void Insert(SqliteConnection connection, SqliteTransaction transaction, string table, string[] columns, object?[] row)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"INSERT INTO {table} ({string.Join(", ", columns)}) VALUES ({string.Join(", ", columns.Select((_, index) => "$p" + index))})";
        for (var index = 0; index < columns.Length; index++) command.Parameters.AddWithValue("$p" + index, row[index] ?? DBNull.Value);
        command.ExecuteNonQuery();
    }

    private static long Scalar(SqliteConnection connection, SqliteTransaction transaction, string sql)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        return Convert.ToInt64(command.ExecuteScalar(), CultureInfo.InvariantCulture);
    }

    private static string Canonical(object? value) => value is null ? "\u0000" : Convert.ToString(value, CultureInfo.InvariantCulture) ?? "\u0000";

    private static bool RowsEqual(object?[] left, object?[] right)
    {
        if (left.Length != right.Length) return false;
        for (var index = 0; index < left.Length; index++)
            if (!string.Equals(Canonical(left[index]), Canonical(right[index]), StringComparison.Ordinal)) return false;
        return true;
    }

    private static string RowHash(object?[] row)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('|', row.Select(Canonical)))));

    private static string Checksum(List<object?[]> requests, List<object?[]> audit)
    {
        var text = new StringBuilder();
        foreach (var row in requests) text.Append("R|").AppendJoin('|', row.Select(Canonical)).Append('\n');
        foreach (var row in audit) text.Append("A|").AppendJoin('|', row.Select(Canonical)).Append('\n');
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text.ToString())));
    }
}

public sealed record DeletionImportResult(int RequestsImported, int AuditImported, IReadOnlyList<long> Conflicts, string SourceChecksum);
