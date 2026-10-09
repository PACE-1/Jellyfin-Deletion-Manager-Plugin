using System.Security.Claims;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Interfaces;
using Jellyfin.Plugin.DeletionManager.Controllers;
using Jellyfin.Plugin.DeletionManager.Model;
using Jellyfin.Plugin.DeletionManager.Services;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace Jellyfin.Plugin.DeletionManager.Tests;

public sealed class DeletionRequestBulkTests : IDisposable
{
    private readonly Guid _adminId = Guid.Parse("11111111-2222-3333-4444-555555555555");
    private readonly Guid _userId = Guid.Parse("66666666-7777-8888-9999-000000000000");
    private readonly string _dataPath = Path.Combine(Path.GetTempPath(), "deletion-manager-bulk-tests", Guid.NewGuid().ToString("N"));
    private readonly DeletionRequestStore _store;
    private readonly Mock<IUserManager> _userManager = new();
    private readonly Mock<ILibraryManager> _libraryManager = new();

    public DeletionRequestBulkTests()
    {
        var applicationPaths = new Mock<IApplicationPaths>();
        applicationPaths.SetupGet(paths => paths.DataPath).Returns(_dataPath);
        _store = new DeletionRequestStore(applicationPaths.Object);

        _userManager.Setup(manager => manager.GetUserById(_adminId)).Returns((Guid id) => (dynamic)CreateUser(id, "admin", isAdmin: true));
        _userManager.Setup(manager => manager.GetUserById(_userId)).Returns((Guid id) => (dynamic)CreateUser(id, "user", isAdmin: false));
    }

    [Fact]
    public void BulkApproveNonAdminForbidden()
    {
        var controller = CreateController(_userId);

        var result = controller.BulkApprove(new BulkDecisionRequest { Ids = [1], Timing = "1w" });

        Assert.IsType<ForbidResult>(result.Result);
    }

    [Fact]
    public void BulkDenyNonAdminForbidden()
    {
        var controller = CreateController(_userId);

        var result = controller.BulkDeny(new BulkDecisionRequest { Ids = [1] });

        Assert.IsType<ForbidResult>(result.Result);
    }

    [Fact]
    public void BulkApproveEmptyIdsBadRequest()
    {
        var controller = CreateController(_adminId);

        var result = controller.BulkApprove(new BulkDecisionRequest { Ids = [], Timing = "1w" });

        Assert.IsType<BadRequestObjectResult>(result.Result);
    }

    [Fact]
    public void BulkApproveOver100IdsBadRequest()
    {
        var controller = CreateController(_adminId);
        var ids = Enumerable.Range(1, 101).Select(i => (long)i).ToArray();

        var result = controller.BulkApprove(new BulkDecisionRequest { Ids = ids, Timing = "1w" });

        Assert.IsType<BadRequestObjectResult>(result.Result);
    }

    [Fact]
    public void BulkApproveInvalidTimingBadRequest()
    {
        var controller = CreateController(_adminId);

        var result = controller.BulkApprove(new BulkDecisionRequest { Ids = [1], Timing = "3w" });

        Assert.IsType<BadRequestObjectResult>(result.Result);
    }

    [Fact]
    public void BulkApproveMixedBatch()
    {
        var pendingA = _store.Create(NewRequest());
        var pendingB = _store.Create(NewRequest());
        var alreadyDenied = _store.Create(NewRequest());
        _store.Deny(alreadyDenied.Id, _adminId, "no");
        var controller = CreateController(_adminId);

        var result = controller.BulkApprove(new BulkDecisionRequest
        {
            Ids = [pendingA.Id, pendingB.Id, alreadyDenied.Id, 999999],
            Timing = "1w"
        });

        var ok = Assert.IsType<OkObjectResult>(result.Result);
        var response = Assert.IsType<BulkDecisionResponse>(ok.Value);
        Assert.Equal(4, response.Results.Count);
        Assert.Equal(pendingA.Id, response.Results[0].Id);
        Assert.Equal(pendingB.Id, response.Results[1].Id);
        Assert.Equal(alreadyDenied.Id, response.Results[2].Id);
        Assert.Equal(999999, response.Results[3].Id);

        Assert.True(response.Results[0].Succeeded);
        Assert.Equal(DeletionRequestStatus.Approved, response.Results[0].Request!.Status);
        Assert.Equal(DeletionTiming.OneWeek, response.Results[0].Request!.Timing);

        Assert.True(response.Results[1].Succeeded);
        Assert.Equal(DeletionRequestStatus.Approved, response.Results[1].Request!.Status);
        Assert.Equal(DeletionTiming.OneWeek, response.Results[1].Request!.Timing);

        Assert.False(response.Results[2].Succeeded);
        Assert.False(string.IsNullOrEmpty(response.Results[2].Message));

        Assert.False(response.Results[3].Succeeded);
        Assert.False(string.IsNullOrEmpty(response.Results[3].Message));
    }

    [Fact]
    public void BulkApproveDeduplicatesIds()
    {
        var pending = _store.Create(NewRequest());
        var controller = CreateController(_adminId);

        var result = controller.BulkApprove(new BulkDecisionRequest { Ids = [pending.Id, pending.Id], Timing = "1w" });

        var ok = Assert.IsType<OkObjectResult>(result.Result);
        var response = Assert.IsType<BulkDecisionResponse>(ok.Value);
        Assert.Single(response.Results);
    }

    [Fact]
    public void BulkDenyRecordsReason()
    {
        var pendingA = _store.Create(NewRequest());
        var pendingB = _store.Create(NewRequest());
        var controller = CreateController(_adminId);

        var result = controller.BulkDeny(new BulkDecisionRequest { Ids = [pendingA.Id, pendingB.Id], Reason = "dupes" });

        var ok = Assert.IsType<OkObjectResult>(result.Result);
        var response = Assert.IsType<BulkDecisionResponse>(ok.Value);
        Assert.All(response.Results, r => Assert.True(r.Succeeded));
        Assert.All(response.Results, r => Assert.Equal(DeletionRequestStatus.Denied, r.Request!.Status));
        Assert.All(response.Results, r => Assert.Equal("dupes", r.Request!.FailureReason));
    }

    [Fact]
    public void BulkDenyReasonOver2000CharsBadRequest()
    {
        var pending = _store.Create(NewRequest());
        var controller = CreateController(_adminId);
        var overLongReason = new string('x', 2001);

        var result = controller.BulkDeny(new BulkDecisionRequest { Ids = [pending.Id], Reason = overLongReason });

        Assert.IsType<BadRequestObjectResult>(result.Result);
    }

    [Fact]
    public void SingleDenyReasonOver2000CharsBadRequest()
    {
        var pending = _store.Create(NewRequest());
        var controller = CreateController(_adminId);
        var overLongReason = new string('x', 2001);

        var result = controller.Deny(pending.Id, new DecisionRequest { Reason = overLongReason });

        Assert.IsType<BadRequestObjectResult>(result.Result);
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

    private static object CreateUser(Guid id, string username, bool isAdmin)
    {
        var userType = typeof(IUserManager).GetMethod(nameof(IUserManager.GetUserById))!.ReturnType;
        var constructor = userType.GetConstructors().OrderBy(candidate => candidate.GetParameters().Length).First();
        var arguments = constructor.GetParameters().Select(parameter =>
            parameter.ParameterType == typeof(Guid) ? (object)id
            : parameter.ParameterType == typeof(string) ? (object)username
            : parameter.HasDefaultValue ? parameter.DefaultValue!
            : parameter.ParameterType.IsValueType ? Activator.CreateInstance(parameter.ParameterType)!
            : null).ToArray();
        var user = constructor.Invoke(arguments);
        userType.GetProperty("Id")?.SetValue(user, id);
        userType.GetProperty("Username")?.SetValue(user, username);

        ((IHasPermissions)user).SetPermission(PermissionKind.IsAdministrator, isAdmin);

        return user;
    }

    public void Dispose()
    {
        if (Directory.Exists(_dataPath)) Directory.Delete(_dataPath, recursive: true);
    }

    private static DeletionRequest NewRequest() => new()
    {
        JellyfinItemId = Guid.NewGuid(),
        ItemName = "Test Movie",
        ItemType = "movie",
        ItemCount = 1,
        RequesterId = Guid.NewGuid(),
        RequesterName = "tester",
        Source = "jellyfin",
        Status = DeletionRequestStatus.Pending,
        CreatedAt = DateTimeOffset.UtcNow
    };
}
