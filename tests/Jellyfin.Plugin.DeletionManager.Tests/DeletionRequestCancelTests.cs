using System.Security.Claims;
using System.Text.Json;
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

public sealed class DeletionRequestCancelStoreTests : IDisposable
{
    private readonly string _dataPath = Path.Combine(Path.GetTempPath(), "deletion-manager-cancel-store-tests", Guid.NewGuid().ToString("N"));
    private readonly DeletionRequestStore _store;

    public DeletionRequestCancelStoreTests()
    {
        var applicationPaths = new Mock<IApplicationPaths>();
        applicationPaths.SetupGet(paths => paths.DataPath).Returns(_dataPath);
        _store = new DeletionRequestStore(applicationPaths.Object);
    }

    [Fact]
    public void CancelApprovedFutureRequestTransitionsToCancelled()
    {
        var request = _store.Create(NewRequest());
        var approver = Guid.NewGuid();
        var now = DateTimeOffset.Parse("2026-09-24T12:00:00Z");
        _store.Approve(request.Id, DeletionTiming.OneWeek, approver, now.AddDays(7));

        _store.Cancel(request.Id, now, "Cancelled by admin");

        var cancelled = _store.Get(request.Id);
        Assert.NotNull(cancelled);
        Assert.Equal(DeletionRequestStatus.Cancelled, cancelled!.Status);
        Assert.Equal("Cancelled by admin", cancelled.FailureReason);
        var audit = _store.ListAudit(request.Id);
        Assert.Single(audit, entry => entry.Action == "cancelled");
    }

    [Fact]
    public void CancelRejectsPendingRequest()
    {
        var request = _store.Create(NewRequest());

        Assert.Throws<InvalidOperationException>(() => _store.Cancel(request.Id, DateTimeOffset.UtcNow, "Cancelled by admin"));
        Assert.DoesNotContain(_store.ListAudit(request.Id), entry => entry.Action == "cancelled");
    }

    [Fact]
    public void CancelRejectsPastDueRequest()
    {
        var request = _store.Create(NewRequest());
        var approver = Guid.NewGuid();
        var now = DateTimeOffset.Parse("2026-09-24T12:00:00Z");
        _store.Approve(request.Id, DeletionTiming.Immediate, approver, now.AddMonths(-1));

        Assert.Throws<InvalidOperationException>(() => _store.Cancel(request.Id, now, "Cancelled by admin"));
        Assert.DoesNotContain(_store.ListAudit(request.Id), entry => entry.Action == "cancelled");
    }

    [Fact]
    public void CancelRejectsExecutedRequest()
    {
        var request = _store.Create(NewRequest());
        var approver = Guid.NewGuid();
        var now = DateTimeOffset.Parse("2026-09-24T12:00:00Z");
        _store.Approve(request.Id, DeletionTiming.Immediate, approver, now.AddDays(7));
        _store.MarkExecuted(request.Id, now);

        Assert.Throws<InvalidOperationException>(() => _store.Cancel(request.Id, now, "Cancelled by admin"));
        var audit = _store.ListAudit(request.Id);
        Assert.DoesNotContain(audit, entry => entry.Action == "cancelled");
    }

    [Fact]
    public void CancelRejectsMissingId()
    {
        Assert.Throws<InvalidOperationException>(() => _store.Cancel(9999, DateTimeOffset.UtcNow, "Cancelled by admin"));
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

public sealed class DeletionRequestCancelControllerTests : IDisposable
{
    private readonly Guid _adminId = Guid.Parse("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");
    private readonly Guid _userId = Guid.Parse("ffffffff-ffff-ffff-ffff-ffffffffffff");
    private readonly string _dataPath = Path.Combine(Path.GetTempPath(), "deletion-manager-cancel-controller-tests", Guid.NewGuid().ToString("N"));
    private readonly DeletionRequestStore _store;
    private readonly Mock<IUserManager> _userManager = new();
    private readonly Mock<ILibraryManager> _libraryManager = new();

    public DeletionRequestCancelControllerTests()
    {
        var applicationPaths = new Mock<IApplicationPaths>();
        applicationPaths.SetupGet(paths => paths.DataPath).Returns(_dataPath);
        _store = new DeletionRequestStore(applicationPaths.Object);

        _userManager.Setup(manager => manager.GetUserById(_adminId)).Returns((Guid id) => (dynamic)CreateUser(id, "admin", isAdmin: true));
        _userManager.Setup(manager => manager.GetUserById(_userId)).Returns((Guid id) => (dynamic)CreateUser(id, "user", isAdmin: false));
    }

    [Fact]
    public void NonAdminCancelIsForbidden()
    {
        var request = ApprovedRequest();
        var controller = CreateController(_userId);

        var result = controller.Cancel(request.Id, null);

        Assert.IsType<ForbidResult>(result.Result);
    }

    [Fact]
    public void AdminCancelReturnsCancelledRequest()
    {
        var request = ApprovedRequest();
        var controller = CreateController(_adminId);

        var result = controller.Cancel(request.Id, null);

        var ok = Assert.IsType<OkObjectResult>(result.Result);
        var cancelled = Assert.IsType<DeletionRequest>(ok.Value);
        Assert.Equal(DeletionRequestStatus.Cancelled, cancelled.Status);
        var audit = _store.ListAudit(request.Id);
        Assert.StartsWith("Cancelled by admin", audit[^1].Reason);
    }

    [Fact]
    public void AdminCancelOfPendingReturnsConflict()
    {
        var request = _store.Create(NewRequest());
        var controller = CreateController(_adminId);

        var result = controller.Cancel(request.Id, null);

        Assert.IsType<ConflictObjectResult>(result.Result);
    }

    [Fact]
    public void CancelReasonOver2000CharsReturnsBadRequest()
    {
        var request = ApprovedRequest();
        var controller = CreateController(_adminId);
        var overLongReason = new string('x', 2001);

        var result = controller.Cancel(request.Id, new CancelRequest { Reason = overLongReason });

        Assert.IsType<BadRequestObjectResult>(result.Result);
    }

    [Fact]
    public void CancelledSerializesAsString()
    {
        var request = NewRequest() with { Status = DeletionRequestStatus.Cancelled };

        var json = JsonSerializer.Serialize(request);

        Assert.Contains("\"Status\":\"Cancelled\"", json);
    }

    private DeletionRequest ApprovedRequest()
    {
        var request = _store.Create(NewRequest());
        _store.Approve(request.Id, DeletionTiming.OneWeek, Guid.NewGuid(), DateTimeOffset.UtcNow.AddDays(7));
        return request;
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
