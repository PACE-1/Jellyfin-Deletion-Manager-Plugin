using System;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.DeletionManager.Model;

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum DeletionRequestStatus
{
    Pending,
    Approved,
    Denied,
    Executed,
    Failed,
    Blocked,
    Cancelled
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum DeletionTiming
{
    Immediate,
    OneWeek,
    TwoWeeks,
    OneMonth
}

public sealed record DeletionRequest
{
    public long Id { get; init; }
    public Guid JellyfinItemId { get; init; }
    public string ItemName { get; init; } = string.Empty;
    public string ItemType { get; init; } = string.Empty;
    public int ItemCount { get; init; }
    public Guid RequesterId { get; init; }
    public string RequesterName { get; init; } = string.Empty;
    public string Source { get; init; } = "jellyfin";
    public DeletionRequestStatus Status { get; init; }
    public DeletionTiming? Timing { get; init; }
    public DateTimeOffset? ExecuteAt { get; init; }
    public Guid? ApprovedBy { get; init; }
    public DateTimeOffset? ApprovedAt { get; init; }
    public DateTimeOffset? ExecutedAt { get; init; }
    public string? FailureReason { get; init; }
    public string? RequesterReason { get; init; }
    public string? ScopeFingerprint { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
}

public sealed record DeletionAuditEntry
{
    public long Id { get; init; }
    public long RequestId { get; init; }
    public string Action { get; init; } = string.Empty;
    public string? Reason { get; init; }
    public DateTimeOffset OccurredAt { get; init; }
}
