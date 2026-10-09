using System.Security.Claims;
using Jellyfin.Plugin.DeletionManager.Controllers;
using Jellyfin.Plugin.DeletionManager.Helpers;
using Jellyfin.Plugin.DeletionManager.Model;
using Jellyfin.Plugin.DeletionManager.Services;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace Jellyfin.Plugin.DeletionManager.Tests;

public sealed class DeletionRequestAuthenticatedContractTests : IDisposable
{
    private readonly Guid _userId = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private readonly string _dataPath = Path.Combine(Path.GetTempPath(), "deletion-manager-authenticated-tests", Guid.NewGuid().ToString("N"));
    private readonly DeletionRequestStore _store;
    private readonly Mock<IUserManager> _userManager = new();
    private readonly Mock<ILibraryManager> _libraryManager = new();

    public DeletionRequestAuthenticatedContractTests()
    {
        var applicationPaths = new Mock<IApplicationPaths>();
        applicationPaths.SetupGet(paths => paths.DataPath).Returns(_dataPath);
        _store = new DeletionRequestStore(applicationPaths.Object);
        _userManager.Setup(manager => manager.GetUserById(_userId)).Returns((Guid id) => (dynamic)CreateUser(id));
    }

    [Fact]
    public void AuthenticatedUserCanReadOnlyTheirOwnRequests()
    {
        _store.Create(NewRequest(_userId));
        _store.Create(NewRequest(Guid.NewGuid()));
        var controller = CreateController(_userId);

        var result = controller.List();

        var response = Assert.IsType<OkObjectResult>(result.Result);
        var requests = Assert.IsAssignableFrom<IReadOnlyList<DeletionRequest>>(response.Value);
        var request = Assert.Single(requests);
        Assert.Equal(_userId, request.RequesterId);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not-a-guid")]
    public void InvalidItemIdsReturnBadRequest(string itemId)
    {
        var controller = CreateController(_userId);

        var result = controller.Submit(new SubmitDeletionRequest { ItemId = itemId, ItemType = "movie" });

        Assert.IsType<BadRequestObjectResult>(result.Result);
    }

    [Fact]
    public void InvalidItemTypeReturnsBadRequest()
    {
        var controller = CreateController(_userId);

        var result = controller.Submit(new SubmitDeletionRequest
        {
            ItemId = Guid.NewGuid().ToString(),
            ItemType = "collection"
        });

        Assert.IsType<BadRequestObjectResult>(result.Result);
    }

    [Fact]
    public void NonAdminCannotApproveOrDeny()
    {
        var controller = CreateController(_userId);

        var approve = controller.Approve(1, new DecisionRequest { Timing = "immediate" });
        var deny = controller.Deny(1, new DecisionRequest { Reason = "not approved" });

        Assert.IsType<ForbidResult>(approve.Result);
        Assert.IsType<ForbidResult>(deny.Result);
    }

    [Fact]
    public void ApiKeyWithoutUserClaimCannotResolveRequester()
    {
        var principal = new ClaimsPrincipal(new ClaimsIdentity(authenticationType: "ApiKey"));

        Assert.Null(UserHelper.GetCurrentUserId(principal));
    }

    private DeletionRequestController CreateController(Guid userId)
    {
        var controller = new DeletionRequestController(_store, _userManager.Object, _libraryManager.Object);
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(
                    [new Claim("Jellyfin-UserId", userId.ToString())],
                    authenticationType: "Jellyfin"))
            }
        };
        return controller;
    }

    private static object CreateUser(Guid id)
    {
        var userType = typeof(IUserManager).GetMethod(nameof(IUserManager.GetUserById))!.ReturnType;
        var constructor = userType.GetConstructors().OrderBy(candidate => candidate.GetParameters().Length).First();
        var arguments = constructor.GetParameters().Select(parameter =>
            parameter.ParameterType == typeof(Guid) ? (object)id
            : parameter.ParameterType == typeof(string) ? (object)"requester"
            : parameter.HasDefaultValue ? parameter.DefaultValue!
            : parameter.ParameterType.IsValueType ? Activator.CreateInstance(parameter.ParameterType)!
            : null).ToArray();
        var user = constructor.Invoke(arguments);
        userType.GetProperty("Id")?.SetValue(user, id);
        userType.GetProperty("Username")?.SetValue(user, "requester");

        return user;
    }

    public void Dispose()
    {
        if (Directory.Exists(_dataPath)) Directory.Delete(_dataPath, recursive: true);
    }

    private static DeletionRequest NewRequest(Guid requesterId) => new()
    {
        JellyfinItemId = Guid.NewGuid(),
        ItemName = "Test Movie",
        ItemType = "movie",
        ItemCount = 1,
        RequesterId = requesterId,
        RequesterName = "requester",
        Status = DeletionRequestStatus.Pending,
        CreatedAt = DateTimeOffset.UtcNow
    };
}
