using Jellyfin.Plugin.DeletionManager.Controllers;
using Jellyfin.Plugin.DeletionManager.Services;
using MediaBrowser.Controller.Library;
using MediaBrowser.Common.Configuration;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace Jellyfin.Plugin.DeletionManager.Tests;

public sealed class DeletionRequestAuthorizationTests : IDisposable
{
    private readonly string _dataPath = Path.Combine(Path.GetTempPath(), "deletion-manager-auth-tests", Guid.NewGuid().ToString("N"));
    private readonly DeletionRequestController _controller;

    public DeletionRequestAuthorizationTests()
    {
        var applicationPaths = new Mock<IApplicationPaths>();
        applicationPaths.SetupGet(paths => paths.DataPath).Returns(_dataPath);
        var userManager = new Mock<IUserManager>();
        var libraryManager = new Mock<ILibraryManager>();
        _controller = new DeletionRequestController(
            new DeletionRequestStore(applicationPaths.Object),
            userManager.Object,
            libraryManager.Object);
    }

    [Fact]
    public void SubmitWithoutJellyfinUserReturnsUnauthorized()
    {
        var result = _controller.Submit(new SubmitDeletionRequest
        {
            ItemId = Guid.NewGuid().ToString(),
            ItemType = "movie"
        });

        Assert.IsType<UnauthorizedResult>(result.Result);
    }

    [Fact]
    public void ListWithoutJellyfinUserReturnsUnauthorized()
    {
        var result = _controller.List();

        Assert.IsType<UnauthorizedResult>(result.Result);
    }

    [Fact]
    public void GetWithoutJellyfinUserReturnsUnauthorized()
    {
        var result = _controller.Get(1);

        Assert.IsType<UnauthorizedResult>(result.Result);
    }

    [Fact]
    public void DecisionsWithoutJellyfinUserReturnForbid()
    {
        var approve = _controller.Approve(1, new DecisionRequest { Timing = "immediate" });
        var deny = _controller.Deny(1, new DecisionRequest { Reason = "not approved" });

        Assert.IsType<ForbidResult>(approve.Result);
        Assert.IsType<ForbidResult>(deny.Result);
    }

    public void Dispose()
    {
        if (Directory.Exists(_dataPath)) Directory.Delete(_dataPath, recursive: true);
    }
}
