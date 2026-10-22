using System;
using System.IO;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.DeletionManager.Helpers;
using Jellyfin.Plugin.DeletionManager.Model;
using Jellyfin.Plugin.DeletionManager.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.DeletionManager.Controllers;

[ApiController]
[Authorize]
[Route("DeletionManager/Requests")]
public sealed class DeletionRequestController : ControllerBase
{
    private const int MaxReasonLength = 2000;
    private const int MaxBulkBatchSize = 100;

    private readonly DeletionRequestStore _store;
    private readonly IUserManager _userManager;
    private readonly ILibraryManager _libraryManager;
    private readonly PosterArchive? _posters;

    public DeletionRequestController(DeletionRequestStore store, IUserManager userManager, ILibraryManager libraryManager, PosterArchive? posters = null)
    {
        _posters = posters;
        _store = store;
        _userManager = userManager;
        _libraryManager = libraryManager;
    }

    [HttpPost]
    public ActionResult<DeletionRequest> Submit([FromBody] SubmitDeletionRequest request)
    {
        if (!TryGetCurrentUser(out var userId, out var userName)) return Unauthorized();
        if (!Guid.TryParse(request.ItemId, out var itemId)) return BadRequest(new { message = "itemId must be a Jellyfin item id." });
        if (!DeletionRequestContract.TryParseItemType(request.ItemType, out var itemType)) return BadRequest(new { message = "itemType must be movie, series, season, or episode." });

        if (!TryCapReason(request.Reason, out var trimmedReason, out var reasonError)) return BadRequest(new { message = reasonError });

        var item = _libraryManager.GetItemById(itemId);
        if (item is null) return NotFound(new { message = "Jellyfin item was not found." });
        var accessible = AccessibleItems(userId);
        if (!accessible.Contains(item.Id)) return NotFound();
        if (!MatchesType(item, itemType)) return BadRequest(new { message = "itemType does not match the Jellyfin item." });

        var scope = DeletionScope.Resolve(_libraryManager, item);
        if (!scope.Items.All(value => accessible.Contains(value.Id))) return Forbid();
        var itemCount = scope.ItemCount(item);
        if (itemType is "series" or "season" && request.ExpectedItemCount is null)
        {
            return BadRequest(new { message = "expectedItemCount is required for series and season requests." });
        }

        if (request.ExpectedItemCount.HasValue && request.ExpectedItemCount.Value != itemCount)
        {
            return Conflict(new { message = "The item count changed. Refresh the scope confirmation before submitting." });
        }

        if (itemType is "series" or "season")
        {
            if (request.ExpectedItemIds is null) return BadRequest(new { message = "expectedItemIds is required for series and season requests." });
            if (!request.ExpectedItemIds.Order().SequenceEqual(scope.EpisodeIds))
            {
                return Conflict(new { message = "The episode selection changed. Refresh the scope confirmation before submitting." });
            }
        }

        var isAdmin = IsAdmin(userId);
        var now = DateTimeOffset.UtcNow;
        try
        {
            var created = _store.Create(new DeletionRequest
            {
                JellyfinItemId = itemId,
                ItemName = item.Name,
                ItemType = itemType,
                ItemCount = itemCount,
                RequesterId = userId,
                RequesterName = userName,
                Status = isAdmin ? DeletionRequestStatus.Approved : DeletionRequestStatus.Pending,
                Timing = isAdmin ? DeletionTiming.Immediate : null,
                ExecuteAt = isAdmin ? now : null,
                ApprovedBy = isAdmin ? userId : null,
                ApprovedAt = isAdmin ? now : null,
                RequesterReason = trimmedReason,
                ScopeFingerprint = scope.Fingerprint,
                CreatedAt = now
            }, isAdmin ? int.MaxValue : 100);
            return CreatedAtAction(nameof(Get), new { id = created.Id }, created);
        }
        catch (DeletionRequestLimitException ex)
        {
            return StatusCode(429, new { message = ex.Message });
        }
        catch (InvalidOperationException ex)
        {
            return Conflict(new { message = ex.Message });
        }
    }

    [HttpGet]
    public ActionResult<IReadOnlyList<DeletionRequest>> List()
    {
        if (!TryGetCurrentUser(out var userId, out _)) return Unauthorized();
        return Ok(IsAdmin(userId) ? _store.List() : _store.List(userId));
    }

    /// <summary>Returns the server's item count so the confirm modal and Submit use the same number.</summary>
    // Shared library badges expose schedules, never requesters or reasons.
    [HttpGet("card-status")]
    public ActionResult<IReadOnlyList<DeletionCardStatus>> CardStatus()
    {
        if (!TryGetCurrentUser(out var userId, out _)) return Unauthorized();
        var accessible = AccessibleItems(userId);
        var schedules = new Dictionary<Guid, DateTimeOffset>();
        foreach (var request in _store.List().Where(value => value.Status == DeletionRequestStatus.Approved
            && value.ExecuteAt.HasValue && !value.ExecutedAt.HasValue))
        {
            var item = _libraryManager.GetItemById(request.JellyfinItemId);
            if (item is null || !accessible.Contains(item.Id)) continue;
            var scope = DeletionScope.Resolve(_libraryManager, item);
            // A changed scope will be blocked by execution; don't label newly
            // added media as approved for deletion.
            if ((item is Series or Season && request.ScopeFingerprint is null)
                || (request.ScopeFingerprint is not null && request.ScopeFingerprint != scope.Fingerprint)) continue;
            foreach (var affected in scope.Items.Where(value => accessible.Contains(value.Id)))
            {
                var executeAt = request.ExecuteAt!.Value;
                if (!schedules.TryGetValue(affected.Id, out var previous) || executeAt < previous)
                    schedules[affected.Id] = executeAt;
            }
        }
        return Ok(schedules.Select(value => new DeletionCardStatus { ItemId = value.Key, ExecuteAt = value.Value }).ToArray());
    }

    [HttpGet("scope")]
    public ActionResult<object> Scope([FromQuery] string? itemId, [FromQuery] string? itemType)
    {
        if (!TryGetCurrentUser(out var userId, out _)) return Unauthorized();
        if (!Guid.TryParse(itemId, out var id)) return BadRequest(new { message = "itemId must be a Jellyfin item id." });
        if (!DeletionRequestContract.TryParseItemType(itemType, out var type)) return BadRequest(new { message = "itemType must be movie, series, season, or episode." });

        var item = _libraryManager.GetItemById(id);
        if (item is null) return NotFound(new { message = "Jellyfin item was not found." });
        var accessible = AccessibleItems(userId);
        if (!accessible.Contains(item.Id)) return NotFound();
        if (!MatchesType(item, type)) return BadRequest(new { message = "itemType does not match the Jellyfin item." });

        var scope = DeletionScope.Resolve(_libraryManager, item);
        if (!scope.Items.All(value => accessible.Contains(value.Id))) return Forbid();
        return Ok(new { itemCount = scope.ItemCount(item), itemIds = scope.EpisodeIds });
    }

    [HttpGet("{id:long}")]
    public ActionResult<DeletionRequest> Get(long id)
    {
        return CheckReadAccess(id, out var request) ?? Ok(request);
    }

    [HttpGet("{id:long}/audit")]
    public ActionResult<IReadOnlyList<DeletionAuditEntry>> Audit(long id)
    {
        return CheckReadAccess(id, out _) ?? Ok(_store.ListAudit(id));
    }

    /// <summary>Poster kept when the item was deleted, since Jellyfin no longer has it.</summary>
    [HttpGet("{id:long}/poster")]
    public ActionResult Poster(long id)
    {
        var denied = CheckReadAccess(id, out _);
        if (denied is not null) return denied;
        var path = _posters?.TryGetPath(id);
        if (path is null) return NotFound();
        return PhysicalFile(path, new Microsoft.AspNetCore.StaticFiles.FileExtensionContentTypeProvider().TryGetContentType(path, out var type) ? type : "application/octet-stream");
    }

    /// <summary>Requester-or-admin guard for reads. Returns null when allowed.</summary>
    private ActionResult? CheckReadAccess(long id, out DeletionRequest? request)
    {
        request = null;
        if (!TryGetCurrentUser(out var userId, out _)) return Unauthorized();
        request = _store.Get(id);
        if (request is null) return NotFound();
        if (!IsAdmin(userId) && request.RequesterId != userId) return Forbid();
        return null;
    }

    [HttpPost("{id:long}/approve")]
    public ActionResult<DeletionRequest> Approve(long id, [FromBody] DecisionRequest decision)
    {
        if (!TryGetCurrentUser(out var approverId, out _) || !IsAdmin(approverId)) return Forbid();
        if (!DeletionRequestContract.TryParseTiming(decision.Timing, out var timing)) return BadRequest(new { message = "timing must be immediate, 1w, 2w, or 1mo." });
        var executeAt = ComputeExecuteAt(timing, DateTimeOffset.UtcNow);
        return Decide(id, () => _store.Approve(id, timing, approverId, executeAt));
    }

    [HttpPost("{id:long}/deny")]
    public ActionResult<DeletionRequest> Deny(long id, [FromBody] DecisionRequest decision)
    {
        if (!TryGetCurrentUser(out var approverId, out _) || !IsAdmin(approverId)) return Forbid();
        if (!TryCapReason(decision.Reason, out var trimmedReason, out var reasonError)) return BadRequest(new { message = reasonError });
        return Decide(id, () => _store.Deny(id, approverId, trimmedReason));
    }

    [HttpPost("bulk/approve")]
    public ActionResult<BulkDecisionResponse> BulkApprove([FromBody] BulkDecisionRequest request)
    {
        if (!TryGetCurrentUser(out var approverId, out _) || !IsAdmin(approverId)) return Forbid();
        if (!TryPrepareBulkIds(request.Ids, out var ids, out var idsError)) return BadRequest(new { message = idsError });
        if (!DeletionRequestContract.TryParseTiming(request.Timing, out var timing)) return BadRequest(new { message = "timing must be immediate, 1w, 2w, or 1mo." });

        var executeAt = ComputeExecuteAt(timing, DateTimeOffset.UtcNow);
        return Ok(RunBulk(ids, id => _store.Approve(id, timing, approverId, executeAt)));
    }

    [HttpPost("bulk/deny")]
    public ActionResult<BulkDecisionResponse> BulkDeny([FromBody] BulkDecisionRequest request)
    {
        if (!TryGetCurrentUser(out var approverId, out _) || !IsAdmin(approverId)) return Forbid();
        if (!TryPrepareBulkIds(request.Ids, out var ids, out var idsError)) return BadRequest(new { message = idsError });
        if (!TryCapReason(request.Reason, out var trimmedReason, out var reasonError)) return BadRequest(new { message = reasonError });

        return Ok(RunBulk(ids, id => _store.Deny(id, approverId, trimmedReason)));
    }

    /// <summary>Applies a store transition; a state-machine violation maps to 409.</summary>
    private ActionResult<DeletionRequest> Decide(long id, Action transition)
    {
        if (_store.Get(id) is null) return NotFound(new { message = "Deletion request was not found." });
        try
        {
            transition();
            return Ok(_store.Get(id));
        }
        catch (InvalidOperationException ex)
        {
            return Conflict(new { message = ex.Message });
        }
    }

    /// <summary>Applies a transition per id, collecting per-item success or failure.</summary>
    private BulkDecisionResponse RunBulk(IReadOnlyList<long> ids, Action<long> transition)
    {
        var results = new List<BulkDecisionResult>(ids.Count);
        foreach (var id in ids)
        {
            try
            {
                transition(id);
                results.Add(new BulkDecisionResult { Id = id, Succeeded = true, Request = _store.Get(id) });
            }
            catch (InvalidOperationException ex)
            {
                results.Add(new BulkDecisionResult { Id = id, Succeeded = false, Message = ex.Message });
            }
        }

        return new BulkDecisionResponse { Results = results };
    }

    private static DateTimeOffset ComputeExecuteAt(DeletionTiming timing, DateTimeOffset now) => timing switch
    {
        DeletionTiming.Immediate => now,
        DeletionTiming.OneWeek => now.AddDays(7),
        DeletionTiming.TwoWeeks => now.AddDays(14),
        DeletionTiming.OneMonth => now.AddMonths(1),
        _ => now
    };

    private static bool TryCapReason(string? reason, out string? trimmedReason, out string error)
    {
        trimmedReason = reason?.Trim();
        if (string.IsNullOrEmpty(trimmedReason)) trimmedReason = null;
        if (trimmedReason is not null && trimmedReason.Length > MaxReasonLength)
        {
            error = "reason must be 2000 characters or fewer.";
            return false;
        }

        error = string.Empty;
        return true;
    }

    private static bool TryPrepareBulkIds(long[]? ids, out IReadOnlyList<long> prepared, out string error)
    {
        var distinct = (ids ?? Array.Empty<long>()).Distinct().ToArray();
        if (distinct.Length == 0)
        {
            prepared = Array.Empty<long>();
            error = "ids must contain at least one request id.";
            return false;
        }

        if (distinct.Length > MaxBulkBatchSize)
        {
            prepared = Array.Empty<long>();
            error = "ids may contain at most 100 request ids.";
            return false;
        }

        prepared = distinct;
        error = string.Empty;
        return true;
    }

    [HttpPost("{id:long}/cancel")]
    public ActionResult<DeletionRequest> Cancel(long id, [FromBody] CancelRequest? body)
    {
        if (!TryGetCurrentUser(out var adminId, out var adminName) || !IsAdmin(adminId)) return Forbid();
        if (!TryCapReason(body?.Reason, out var trimmedReason, out var reasonError)) return BadRequest(new { message = reasonError });

        var auditReason = "Cancelled by " + adminName;
        if (trimmedReason is not null) auditReason += ": " + trimmedReason;
        return Decide(id, () => _store.Cancel(id, DateTimeOffset.UtcNow, auditReason, adminId));
    }

    private bool TryGetCurrentUser(out Guid userId, out string userName)
    {
        var resolved = UserHelper.GetCurrentUserId(User);
        if (!resolved.HasValue || resolved.Value == Guid.Empty)
        {
            userId = Guid.Empty;
            userName = string.Empty;
            return false;
        }
        var user = _userManager.GetUserById(resolved.Value);
        userId = resolved.Value;
        userName = user?.Username ?? User.Identity?.Name ?? "Unknown";
        return user is not null;
    }

    private bool IsAdmin(Guid userId)
    {
        var user = _userManager.GetUserById(userId);
        return user is not null && user.HasPermission(PermissionKind.IsAdministrator);
    }

    private static bool MatchesType(BaseItem item, string itemType) => itemType switch
    {
        "movie" => item is Movie,
        "series" => item is Series,
        "season" => item is Season,
        "episode" => item is Episode,
        _ => false
    };

    private HashSet<Guid> AccessibleItems(Guid userId)
    {
        var user = _userManager.GetUserById(userId);
        if (user is null) return [];
        // ItemIds/ParentId bypass Jellyfin's allowed-library root expansion.
        // Start from the user's visible roots, then intersect the deletion scope.
        return _libraryManager.GetItemIds(new InternalItemsQuery(user)
        {
            Recursive = true,
        }).ToHashSet();
    }


    /// <summary>Execution switch state for the dashboard banner. Admin only.</summary>
    [HttpGet("~/DeletionManager/Config")]
    [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
    public ActionResult GetConfig()
    {
        if (!TryGetCurrentUser(out var adminId, out _) || !IsAdmin(adminId)) return Forbid();
        return Ok(new { DeletionExecutionEnabled = Plugin.Instance?.Configuration.DeletionExecutionEnabled ?? false });
    }
}

public sealed class DeletionCardStatus
{
    public Guid ItemId { get; init; }
    public DateTimeOffset ExecuteAt { get; init; }
}

public sealed class SubmitDeletionRequest
{
    public string ItemId { get; init; } = string.Empty;
    public string ItemType { get; init; } = string.Empty;
    public int? ExpectedItemCount { get; init; }
    public Guid[]? ExpectedItemIds { get; init; }
    public string? Reason { get; init; }
}

public sealed class DecisionRequest
{
    public string? Timing { get; init; }
    public string? Reason { get; init; }
}

public sealed class CancelRequest
{
    public string? Reason { get; init; }
}

public sealed class BulkDecisionRequest
{
    public long[]? Ids { get; init; }
    public string? Timing { get; init; }
    public string? Reason { get; init; }
}

public sealed class BulkDecisionResult
{
    public long Id { get; init; }
    public bool Succeeded { get; init; }
    public string? Message { get; init; }
    public DeletionRequest? Request { get; init; }
}

public sealed class BulkDecisionResponse
{
    public IReadOnlyList<BulkDecisionResult> Results { get; init; } = Array.Empty<BulkDecisionResult>();
}
