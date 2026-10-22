using Jellyfin.Plugin.DeletionManager.Model;
using Jellyfin.Plugin.DeletionManager.Services;

namespace Jellyfin.Plugin.DeletionManager.Tests;

public sealed class DeletionExecutionBoundaryTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-09-23T12:00:00Z");
    private readonly DeletionExecutionBoundary _boundary = new();

    [Fact]
    public void PendingRequestsCannotExecute()
    {
        var decision = _boundary.Evaluate(Request(DeletionRequestStatus.Pending, Now), Now, Guards());

        Assert.Equal(DeletionExecutionDisposition.NotApproved, decision.Disposition);
    }

    [Fact]
    public void FutureRequestsWaitUntilDue()
    {
        var decision = _boundary.Evaluate(Request(DeletionRequestStatus.Approved, Now.AddMinutes(1)), Now, Guards());

        Assert.Equal(DeletionExecutionDisposition.NotDue, decision.Disposition);
    }

    [Fact]
    public void DueRequestWithNoSafetyConflictIsReady()
    {
        var decision = _boundary.Evaluate(Request(DeletionRequestStatus.Approved, Now), Now, Guards());

        Assert.Equal(DeletionExecutionDisposition.Ready, decision.Disposition);
    }

    [Fact]
    public void PlayingItemIsRequeued()
    {
        var decision = _boundary.Evaluate(Request(DeletionRequestStatus.Approved, Now), Now, Guards(isPlaying: true));

        Assert.Equal(DeletionExecutionDisposition.Requeue, decision.Disposition);
    }

    [Fact]
    public void FavoriteRuleRequestWaitsForAdminDecisionWhenProtectionIsEnabled()
    {
        var decision = _boundary.Evaluate(Request(DeletionRequestStatus.Approved, Now, source: "rule"), Now, Guards(isFavorite: true));

        Assert.Equal(DeletionExecutionDisposition.AwaitingFavoriteDecision, decision.Disposition);
    }

    [Fact]
    public void FavoriteManualRequestWaitsForAdminDecisionWhenProtectionIsEnabled()
    {
        var decision = _boundary.Evaluate(Request(DeletionRequestStatus.Approved, Now, source: "jellyfin"), Now, Guards(isFavorite: true));

        Assert.Equal(DeletionExecutionDisposition.AwaitingFavoriteDecision, decision.Disposition);
    }

    [Fact]
    public void FavoriteRequestProceedsOnceAdminAllowedIt()
    {
        var request = Request(DeletionRequestStatus.Approved, Now, source: "jellyfin") with { FavoriteDecision = DeletionRequest.FavoriteAllowed };

        var decision = _boundary.Evaluate(request, Now, Guards(isFavorite: true));

        Assert.Equal(DeletionExecutionDisposition.Ready, decision.Disposition);
    }

    [Fact]
    public void FavoriteManualRequestCanProceedWhenProtectionIsDisabled()
    {
        var decision = _boundary.Evaluate(Request(DeletionRequestStatus.Approved, Now, source: "jellyfin"), Now, Guards(isFavorite: true, favoriteProtectionEnabled: false));

        Assert.Equal(DeletionExecutionDisposition.Ready, decision.Disposition);
    }

    [Fact]
    public void FavoriteRuleRequestCanProceedWhenProtectionIsDisabled()
    {
        var decision = _boundary.Evaluate(Request(DeletionRequestStatus.Approved, Now, source: "rule"), Now, Guards(isFavorite: true, favoriteProtectionEnabled: false));

        Assert.Equal(DeletionExecutionDisposition.Ready, decision.Disposition);
    }

    private static DeletionGuardContext Guards(bool isPlaying = false, bool isFavorite = false, bool favoriteProtectionEnabled = true)
        => new(isPlaying, isFavorite, favoriteProtectionEnabled);

    private static DeletionRequest Request(DeletionRequestStatus status, DateTimeOffset? executeAt, string source = "jellyfin")
        => new()
        {
            JellyfinItemId = Guid.NewGuid(),
            ItemName = "Test Movie",
            ItemType = "movie",
            ItemCount = 1,
            RequesterId = Guid.NewGuid(),
            RequesterName = "tester",
            Source = source,
            Status = status,
            ExecuteAt = executeAt,
            CreatedAt = Now.AddHours(-1)
        };
}
