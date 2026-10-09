using Jellyfin.Plugin.DeletionManager.Model;

namespace Jellyfin.Plugin.DeletionManager.Tests;

public sealed class DeletionRequestContractTests
{
    [Theory]
    [InlineData("movie")]
    [InlineData("series")]
    [InlineData("season")]
    [InlineData("episode")]
    public void SupportedItemTypesAreAccepted(string itemType)
    {
        Assert.True(DeletionRequestContract.TryParseItemType(itemType, out var parsed));
        Assert.Equal(itemType, parsed);
    }

    [Theory]
    [InlineData("", false)]
    [InlineData("collection", false)]
    [InlineData("MOVIE", true)]
    [InlineData(" episode ", true)]
    public void UnsupportedItemTypesAreRejected(string itemType, bool expected)
    {
        Assert.Equal(expected, DeletionRequestContract.TryParseItemType(itemType, out _));
    }

    [Theory]
    [InlineData("immediate", DeletionTiming.Immediate)]
    [InlineData("1w", DeletionTiming.OneWeek)]
    [InlineData("2w", DeletionTiming.TwoWeeks)]
    [InlineData("1mo", DeletionTiming.OneMonth)]
    public void SupportedTimingsAreAccepted(string value, DeletionTiming expected)
    {
        Assert.True(DeletionRequestContract.TryParseTiming(value, out var parsed));
        Assert.Equal(expected, parsed);
    }

    [Theory]
    [InlineData("")]
    [InlineData("1d")]
    [InlineData("weekly")]
    [InlineData("immediate-now")]
    public void UnsupportedTimingsAreRejected(string value)
    {
        Assert.False(DeletionRequestContract.TryParseTiming(value, out _));
    }
}
