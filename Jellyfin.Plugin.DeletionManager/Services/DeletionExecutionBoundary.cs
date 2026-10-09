using System;
using Jellyfin.Plugin.DeletionManager.Model;

namespace Jellyfin.Plugin.DeletionManager.Services;

public enum DeletionExecutionDisposition
{
    NotApproved,
    NotDue,
    Ready,
    Requeue,
    Blocked
}

public sealed record DeletionGuardContext(bool IsPlaying, bool IsFavorite, bool FavoriteProtectionEnabled);

public sealed record DeletionExecutionDecision(DeletionExecutionDisposition Disposition, string Reason);

public interface IDeletionExecutor
{
    DeletionExecutionDecision Evaluate(DeletionRequest request, DateTimeOffset now, DeletionGuardContext guards);
}

public sealed class DeletionExecutionBoundary : IDeletionExecutor
{
    public DeletionExecutionDecision Evaluate(DeletionRequest request, DateTimeOffset now, DeletionGuardContext guards)
    {
        if (request.Status != DeletionRequestStatus.Approved)
        {
            return new(DeletionExecutionDisposition.NotApproved, "Only approved requests can enter execution.");
        }

        if (!request.ExecuteAt.HasValue || request.ExecuteAt.Value > now)
        {
            return new(DeletionExecutionDisposition.NotDue, "The request is not due for execution.");
        }

        if (guards.IsPlaying)
        {
            return new(DeletionExecutionDisposition.Requeue, "The requested item is currently playing.");
        }

        // Favorite protection applies to every request source, as the "Protect favorites" setting promises.
        if (guards.IsFavorite && guards.FavoriteProtectionEnabled)
        {
            return new(DeletionExecutionDisposition.Blocked, "A user has marked this item as a favorite.");
        }

        return new(DeletionExecutionDisposition.Ready, "The request passed the execution boundary.");
    }
}
