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
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = Path.Combine(directory, "deletion-manager.db"),
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Shared
        }.ToString();
        Initialize();
    }

    public DeletionRequest Create(DeletionRequest request, int maxActiveRequests = 100)
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
        using (var count = connection.CreateCommand())
        {
            count.Transaction = transaction;
            count.CommandText = "SELECT COUNT(*) FROM deletion_requests WHERE requester_id = $user AND status IN ('pending', 'approved')";
            count.Parameters.AddWithValue("$user", request.RequesterId.ToString("N"));
            if ((long)count.ExecuteScalar()! >= maxActiveRequests)
                throw new DeletionRequestLimitException("You have reached the active request limit. Wait for existing requests to finish before submitting more.");
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
        InsertAudit(connection, transaction, id, "submitted", null, request.CreatedAt, request.RequesterId);
        if (request.Status == DeletionRequestStatus.Approved)
            InsertAudit(connection, transaction, id, "approved", ScheduleReason(request.Timing, request.ExecuteAt), request.ApprovedAt ?? request.CreatedAt, request.ApprovedBy);
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

    // Close only requests for the same reviewed scope after a confirmed successful deletion.
    // A missing library item alone is never proof that this plugin deleted it.
    public void CompleteMatchingRequests(DeletionRequest executed, DateTimeOffset occurredAt)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        var ids = new List<long>();
        using (var select = connection.CreateCommand())
        {
            select.Transaction = transaction;
            select.CommandText = "SELECT id FROM deletion_requests WHERE id <> $id AND jellyfin_item_id = $item AND scope_fingerprint IS $scope AND status IN ('pending', 'approved')";
            select.Parameters.AddWithValue("$id", executed.Id);
            select.Parameters.AddWithValue("$item", executed.JellyfinItemId.ToString("N"));
            select.Parameters.AddWithValue("$scope", (object?)executed.ScopeFingerprint ?? DBNull.Value);
            using var reader = select.ExecuteReader();
            while (reader.Read()) ids.Add(reader.GetInt64(0));
        }
        const string reason = "The same reviewed item was deleted by another request.";
        foreach (var id in ids)
        {
            using var update = connection.CreateCommand();
            update.Transaction = transaction;
            update.CommandText = "UPDATE deletion_requests SET status = 'executed', executed_at = $now, failure_reason = $reason WHERE id = $id";
            update.Parameters.AddWithValue("$id", id);
            update.Parameters.AddWithValue("$now", occurredAt.ToUniversalTime().ToString("O"));
            update.Parameters.AddWithValue("$reason", reason);
            update.ExecuteNonQuery();
            InsertAudit(connection, transaction, id, "executed", reason, occurredAt);
        }
        transaction.Commit();
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

    // Favorited items are never deleted on a schedule alone: the request leaves the schedule until an admin decides.
    public void HoldForFavorite(long id, DateTimeOffset occurredAt, string reason)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "UPDATE deletion_requests SET favorite_decision = $awaiting, execute_at = NULL, failure_reason = $reason WHERE id = $id AND status = $approved AND executed_at IS NULL";
        command.Parameters.AddWithValue("$awaiting", DeletionRequest.FavoriteAwaiting);
        command.Parameters.AddWithValue("$reason", reason);
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.AddWithValue("$approved", DeletionRequestStatus.Approved.ToString().ToLowerInvariant());
        if (command.ExecuteNonQuery() != 1) throw new InvalidOperationException("Request is missing or is no longer approved.");
        InsertAudit(connection, transaction, id, "favorite_held", reason, occurredAt);
        transaction.Commit();
    }

    /// <summary>Admin confirms deleting the favorited item: the request is due again and the favorite guard stays satisfied for it.</summary>
    public void AllowFavorite(long id, DateTimeOffset occurredAt, Guid actorId)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "UPDATE deletion_requests SET favorite_decision = $allowed, execute_at = $now, failure_reason = NULL WHERE id = $id AND status = $approved AND favorite_decision = $awaiting";
        command.Parameters.AddWithValue("$allowed", DeletionRequest.FavoriteAllowed);
        command.Parameters.AddWithValue("$awaiting", DeletionRequest.FavoriteAwaiting);
        command.Parameters.AddWithValue("$now", occurredAt.ToUniversalTime().ToString("O"));
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.AddWithValue("$approved", DeletionRequestStatus.Approved.ToString().ToLowerInvariant());
        if (command.ExecuteNonQuery() != 1) throw new InvalidOperationException("Request is missing or is not waiting for a favorite decision.");
        InsertAudit(connection, transaction, id, "favorite_allowed", "Admin confirmed deleting the favorited item.", occurredAt, actorId);
        transaction.Commit();
    }

    /// <summary>Admin keeps the favorited item: the request is closed without deleting anything.</summary>
    public void KeepFavorite(long id, DateTimeOffset occurredAt, Guid actorId, string reason)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "UPDATE deletion_requests SET status = $cancelled, failure_reason = $reason WHERE id = $id AND status = $approved AND favorite_decision = $awaiting";
        command.Parameters.AddWithValue("$cancelled", DeletionRequestStatus.Cancelled.ToString().ToLowerInvariant());
        command.Parameters.AddWithValue("$reason", reason);
        command.Parameters.AddWithValue("$awaiting", DeletionRequest.FavoriteAwaiting);
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.AddWithValue("$approved", DeletionRequestStatus.Approved.ToString().ToLowerInvariant());
        if (command.ExecuteNonQuery() != 1) throw new InvalidOperationException("Request is missing or is not waiting for a favorite decision.");
        InsertAudit(connection, transaction, id, "cancelled", reason, occurredAt, actorId);
        transaction.Commit();
    }

    public void Cancel(long id, DateTimeOffset occurredAt, string reason, Guid? actorId = null)
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

        InsertAudit(connection, transaction, id, "cancelled", reason, occurredAt, actorId);
        transaction.Commit();
    }

    public IReadOnlyList<DeletionAuditEntry> ListAudit(long requestId)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT id, request_id, action, reason, occurred_at, actor_id FROM deletion_audit WHERE request_id = $request_id ORDER BY occurred_at ASC, id ASC";
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
                OccurredAt = DateTimeOffset.Parse(reader.GetString(4)),
                ActorId = reader.IsDBNull(5) ? null : Guid.Parse(reader.GetString(5))
            });
        }

        return results;
    }

    private void UpdateDecision(long id, DeletionRequestStatus status, DeletionTiming? timing, Guid approverId, DateTimeOffset? executeAt, string? reason)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        var now = DateTimeOffset.UtcNow;
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            UPDATE deletion_requests
            SET status = $status, timing = $timing, approved_by = $approved_by,
                approved_at = $approved_at, execute_at = $execute_at, failure_reason = $failure_reason
            WHERE id = $id AND status = $pending;
            """;
        command.Parameters.AddWithValue("$status", status.ToString().ToLowerInvariant());
        command.Parameters.AddWithValue("$timing", (object?)timing?.ToString().ToLowerInvariant() ?? DBNull.Value);
        command.Parameters.AddWithValue("$approved_by", approverId.ToString("N"));
        command.Parameters.AddWithValue("$approved_at", now.ToString("O"));
        command.Parameters.AddWithValue("$execute_at", (object?)executeAt?.ToString("O") ?? DBNull.Value);
        command.Parameters.AddWithValue("$failure_reason", (object?)reason ?? DBNull.Value);
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.AddWithValue("$pending", DeletionRequestStatus.Pending.ToString().ToLowerInvariant());
        if (command.ExecuteNonQuery() != 1) throw new InvalidOperationException("Request is missing or is no longer pending.");
        InsertAudit(connection, transaction, id, status.ToString().ToLowerInvariant(),
            status == DeletionRequestStatus.Approved ? ScheduleReason(timing, executeAt) : reason, now, approverId);
        transaction.Commit();
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

    private static void InsertAudit(SqliteConnection connection, SqliteTransaction transaction, long id, string action, string? reason, DateTimeOffset occurredAt, Guid? actorId = null)
    {
        using var audit = connection.CreateCommand();
        audit.Transaction = transaction;
        audit.CommandText = "INSERT INTO deletion_audit (request_id, action, reason, occurred_at, actor_id) VALUES ($request_id, $action, $reason, $occurred_at, $actor_id)";
        audit.Parameters.AddWithValue("$request_id", id);
        audit.Parameters.AddWithValue("$action", action);
        audit.Parameters.AddWithValue("$reason", (object?)reason ?? DBNull.Value);
        audit.Parameters.AddWithValue("$occurred_at", occurredAt.ToUniversalTime().ToString("O"));
        audit.Parameters.AddWithValue("$actor_id", (object?)actorId?.ToString("N") ?? DBNull.Value);
        audit.ExecuteNonQuery();
    }

    private static string? ScheduleReason(DeletionTiming? timing, DateTimeOffset? executeAt)
        => timing.HasValue ? $"Timing: {timing}; scheduled for {executeAt:O}." : null;

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
            FavoriteDecision = ReadNullableString(reader, "favorite_decision"),
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
              actor_id TEXT NULL,
              FOREIGN KEY(request_id) REFERENCES deletion_requests(id)
            );
            CREATE INDEX IF NOT EXISTS ix_deletion_audit_request ON deletion_audit(request_id, occurred_at);
            """;
        command.ExecuteNonQuery();

        using (var check = connection.CreateCommand())
        {
            check.CommandText = "SELECT COUNT(*) FROM pragma_table_info('deletion_requests') WHERE name = 'favorite_decision'";
            if ((long)check.ExecuteScalar()! == 0)
            {
                using var alter = connection.CreateCommand();
                alter.CommandText = "ALTER TABLE deletion_requests ADD COLUMN favorite_decision TEXT NULL";
                alter.ExecuteNonQuery();
            }
        }

        using (var check = connection.CreateCommand())
        {
            check.CommandText = "SELECT COUNT(*) FROM pragma_table_info('deletion_audit') WHERE name = 'actor_id'";
            if ((long)check.ExecuteScalar()! == 0)
            {
                using var alter = connection.CreateCommand();
                alter.CommandText = "ALTER TABLE deletion_audit ADD COLUMN actor_id TEXT NULL";
                alter.ExecuteNonQuery();
            }
        }
    }
}
