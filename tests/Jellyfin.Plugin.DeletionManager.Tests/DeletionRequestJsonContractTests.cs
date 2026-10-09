using System.Text.Json;
using Jellyfin.Plugin.DeletionManager.Model;

namespace Jellyfin.Plugin.DeletionManager.Tests;

public sealed class DeletionRequestJsonContractTests
{
    [Fact]
    public void StatusAndTimingSerializeAsStableStrings()
    {
        var request = new DeletionRequest
        {
            Id = 42,
            JellyfinItemId = Guid.Parse("11111111-1111-1111-1111-111111111111"),
            ItemName = "Test Movie",
            ItemType = "movie",
            ItemCount = 1,
            RequesterId = Guid.Parse("22222222-2222-2222-2222-222222222222"),
            RequesterName = "tester",
            Source = "jellyfin",
            Status = DeletionRequestStatus.Approved,
            Timing = DeletionTiming.OneWeek,
            CreatedAt = DateTimeOffset.Parse("2026-01-01T00:00:00Z")
        };

        var json = JsonSerializer.Serialize(request);

        Assert.Contains("\"Status\":\"Approved\"", json);
        Assert.Contains("\"Timing\":\"OneWeek\"", json);
        Assert.DoesNotContain("\"Status\":1", json);
    }
}
