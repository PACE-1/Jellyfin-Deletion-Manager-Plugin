using System.Security.Claims;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Interfaces;
using Jellyfin.Plugin.DeletionManager.Controllers;
using Jellyfin.Plugin.DeletionManager.Model;
using Jellyfin.Plugin.DeletionManager.Services;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace Jellyfin.Plugin.DeletionManager.Tests;

public sealed class DeletionRequestReasonAuditTests : IDisposable
{
    private readonly Guid _requesterId = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    private readonly Guid _otherUserId = Guid.Parse("cccccccc-cccc-cccc-cccc-cccccccccccc");
    private readonly Guid _adminId = Guid.Parse("dddddddd-dddd-dddd-dddd-dddddddddddd");
    private readonly string _dataPath = Path.Combine(Path.GetTempPath(), "deletion-manager-reason-audit-tests", Guid.NewGuid().ToString("N"));
    private readonly DeletionRequestStore _store;
    private readonly Mock<IUserManager> _userManager = new();
    private readonly Mock<ILibraryManager> _libraryManager = new();

    public DeletionRequestReasonAuditTests()
    {
        var applicationPaths = new Mock<IApplicationPaths>();
        applicationPaths.SetupGet(paths => paths.DataPath).Returns(_dataPath);
        _store = new DeletionRequestStore(applicationPaths.Object);

        _userManager.Setup(manager => manager.GetUserById(_requesterId)).Returns((Guid id) => (dynamic)CreateUser(id, "requester", isAdmin: false));
        _userManager.Setup(manager => manager.GetUserById(_otherUserId)).Returns((Guid id) => (dynamic)CreateUser(id, "other", isAdmin: false));
        _userManager.Setup(manager => manager.GetUserById(_adminId)).Returns((Guid id) => (dynamic)CreateUser(id, "admin", isAdmin: true));
    }

    [Fact]
    public void SubmitStoresTrimmedReason()
    {
        var itemId = Guid.NewGuid();
        _libraryManager.Setup(manager => manager.GetItemById(itemId)).Returns(new Movie { Id = itemId, Name = "Test Movie" });
        _libraryManager.Setup(manager => manager.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns(new[] { itemId });
        var controller = CreateController(_requesterId);

        var result = controller.Submit(new SubmitDeletionRequest { ItemId = itemId.ToString(), ItemType = "movie", Reason = "  old  " });

        var created = Assert.IsType<CreatedAtActionResult>(result.Result);
        var request = Assert.IsType<DeletionRequest>(created.Value);
        Assert.Equal("old", request.RequesterReason);
    }

    [Fact]
    public void SubmitBlankReasonStoresNull()
    {
        var itemId = Guid.NewGuid();
        _libraryManager.Setup(manager => manager.GetItemById(itemId)).Returns(new Movie { Id = itemId, Name = "Test Movie" });
        _libraryManager.Setup(manager => manager.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns(new[] { itemId });
        var controller = CreateController(_requesterId);

        var result = controller.Submit(new SubmitDeletionRequest { ItemId = itemId.ToString(), ItemType = "movie", Reason = "   " });

        var created = Assert.IsType<CreatedAtActionResult>(result.Result);
        var request = Assert.IsType<DeletionRequest>(created.Value);
        Assert.Null(request.RequesterReason);
    }

    [Fact]
    public void SubmitRejectsReasonOver2000Chars()
    {
        var itemId = Guid.NewGuid();
        _libraryManager.Setup(manager => manager.GetItemById(itemId)).Returns(new Movie { Id = itemId, Name = "Test Movie" });
        var controller = CreateController(_requesterId);
        var overLongReason = new string('x', 2001);

        var result = controller.Submit(new SubmitDeletionRequest { ItemId = itemId.ToString(), ItemType = "movie", Reason = overLongReason });

        Assert.IsType<BadRequestObjectResult>(result.Result);
        Assert.Empty(_store.List());
    }

    [Fact]
    public void AuditReturnsEntriesForRequester()
    {
        var request = _store.Create(NewRequest(_requesterId));
        var controller = CreateController(_requesterId);

        var result = controller.Audit(request.Id);

        var ok = Assert.IsType<OkObjectResult>(result.Result);
        Assert.IsAssignableFrom<IReadOnlyList<DeletionAuditEntry>>(ok.Value);
    }

    [Fact]
    public void AuditForbiddenForOtherNonAdmin()
    {
        var request = _store.Create(NewRequest(_requesterId));
        var controller = CreateController(_otherUserId);

        var result = controller.Audit(request.Id);

        Assert.IsType<ForbidResult>(result.Result);
    }

    [Fact]
    public void AuditAllowedForAdmin()
    {
        var request = _store.Create(NewRequest(_requesterId));
        var controller = CreateController(_adminId);

        var result = controller.Audit(request.Id);

        Assert.IsType<OkObjectResult>(result.Result);
    }

    [Fact]
    public void SeriesScopeSkipsMissingEpisodesAndMatchesSubmit()
    {
        var seriesId = Guid.NewGuid();
        _libraryManager.Setup(manager => manager.GetItemById(seriesId)).Returns(new Series { Id = seriesId, Name = "Test Series" });
        var episodes = Enumerable.Range(0, 4).Select(_ => (BaseItem)new Episode { Id = Guid.NewGuid() }).ToArray();
        // A visibility query must start at user roots; an unfiltered descendant query would include placeholders.
        _libraryManager.Setup(manager => manager.GetItemIds(It.IsAny<InternalItemsQuery>()))
            .Returns(episodes.Select(value => value.Id).Append(seriesId).ToArray());
        _libraryManager.Setup(manager => manager.GetItemList(It.IsAny<InternalItemsQuery>()))
            .Returns((InternalItemsQuery query) => query.IsVirtualItem == false ? episodes : episodes.Concat(new[] { (BaseItem)new Episode { Id = Guid.NewGuid(), IsVirtualItem = true } }).ToArray());
        var controller = CreateController(_requesterId);

        var scope = Assert.IsType<OkObjectResult>(controller.Scope(seriesId.ToString(), "series").Result);
        var itemCount = (int)scope.Value!.GetType().GetProperty("itemCount")!.GetValue(scope.Value)!;
        Assert.Equal(4, itemCount);

        var submit = controller.Submit(new SubmitDeletionRequest { ItemId = seriesId.ToString(), ItemType = "series", ExpectedItemCount = itemCount, ExpectedItemIds = episodes.Select(value => value.Id).ToArray() });
        Assert.IsType<CreatedAtActionResult>(submit.Result);
    }

    [Fact]
    public void AuditMissingRequestReturnsNotFound()
    {
        var controller = CreateController(_requesterId);

        var result = controller.Audit(9999);

        Assert.IsType<NotFoundResult>(result.Result);
    }

    [Theory]
    [InlineData("approve")]
    [InlineData("deny")]
    [InlineData("cancel")]
    public void MissingDecisionReturns404(string action)
    {
        var controller = CreateController(_adminId);
        var result = action switch
        {
            "approve" => controller.Approve(99999, new DecisionRequest { Timing = "1w" }),
            "deny" => controller.Deny(99999, new DecisionRequest()),
            _ => controller.Cancel(99999, null)
        };
        Assert.IsType<NotFoundObjectResult>(result.Result);
    }

    [Fact]
    public void SubmitReturns429WhenOrdinaryUserQuotaIsFull()
    {
        for (var i = 0; i < 100; i++) _store.Create(NewRequest(_requesterId));
        var item = new Movie { Id = Guid.NewGuid(), Name = "Synthetic movie" };
        _libraryManager.Setup(m => m.GetItemById(item.Id)).Returns(item);
        _libraryManager.Setup(m => m.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns(new[] { item.Id });
        var response = CreateController(_requesterId).Submit(new SubmitDeletionRequest { ItemId = item.Id.ToString(), ItemType = "movie" });
        Assert.Equal(429, Assert.IsType<ObjectResult>(response.Result).StatusCode);
        Assert.Equal(100, _store.List(_requesterId).Count);
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
