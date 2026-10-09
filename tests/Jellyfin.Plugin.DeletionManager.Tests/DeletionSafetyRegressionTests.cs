using Jellyfin.Data;
using System.Security.Claims;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Interfaces;
using Jellyfin.Plugin.DeletionManager.Configuration;
using Jellyfin.Plugin.DeletionManager.Controllers;
using Jellyfin.Plugin.DeletionManager.Model;
using Jellyfin.Plugin.DeletionManager.Services;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace Jellyfin.Plugin.DeletionManager.Tests;

public sealed class DeletionSafetyRegressionTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "deletion-safety", Guid.NewGuid().ToString("N"));
    private readonly Mock<ILibraryManager> _library = new();
    private readonly Mock<IUserManager> _users = new();
    private readonly Mock<ISessionManager> _sessions = new();
    private readonly Mock<IUserDataManager> _userData = new();
    private readonly Mock<IDeletionGuardProvider> _guards = new();
    private readonly Dictionary<Guid, BaseItem> _items = new();
    private readonly List<BaseItem> _descendants = new();
    private readonly HashSet<Guid> _accessible = new();
    private readonly User _user;
    private readonly DeletionRequestStore _store;
    private readonly Logger _logger;
    private PluginConfiguration _config = new() { DeletionExecutionEnabled = true, DeletionFavoriteProtectionEnabled = true };
    private readonly DateTimeOffset _now = DateTimeOffset.UtcNow;

    public DeletionSafetyRegressionTests()
    {
        var paths = new Mock<IApplicationPaths>();
        paths.SetupGet(value => value.DataPath).Returns(_directory);
        paths.SetupGet(value => value.LogDirectoryPath).Returns(_directory);
        _store = new DeletionRequestStore(paths.Object);
        _logger = new Logger(NullLoggerFactory.Instance);
        var constructor = typeof(User).GetConstructors().OrderBy(value => value.GetParameters().Length).First();
        _user = (User)constructor.Invoke(constructor.GetParameters().Select(parameter =>
            parameter.ParameterType == typeof(Guid) ? (object)Guid.NewGuid()
            : parameter.ParameterType == typeof(string) ? "test"
            : parameter.HasDefaultValue ? parameter.DefaultValue
            : parameter.ParameterType.IsValueType ? Activator.CreateInstance(parameter.ParameterType) : null).ToArray());
        _user.Id = Guid.NewGuid();
        _user.Username = "test";
        ((IHasPermissions)_user).SetPermission(PermissionKind.IsAdministrator, false);
        ((IHasPermissions)_user).SetPermission(PermissionKind.EnableAllFolders, false);
        _users.Setup(value => value.GetUserById(_user.Id)).Returns(_user);
        _users.Setup(value => value.GetUsers()).Returns(new[] { _user });
        _library.Setup(value => value.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => _items.GetValueOrDefault(id));
        _library.Setup(value => value.GetItemList(It.IsAny<InternalItemsQuery>()))
            .Returns((InternalItemsQuery query) => _descendants.Where(value => query.IsVirtualItem != false || !value.IsVirtualItem).ToArray());
        _library.Setup(value => value.GetItemIds(It.IsAny<InternalItemsQuery>()))
            .Returns((InternalItemsQuery query) => query.User?.Id == _user.Id && query.ItemIds.Length == 0 && query.ParentId == Guid.Empty
                ? _accessible.ToArray() : Array.Empty<Guid>());
        _sessions.SetupGet(value => value.Sessions).Returns(Array.Empty<SessionInfo>());
        _guards.Setup(value => value.GetGuards(It.IsAny<BaseItem>())).Returns(new DeletionGuardContext(false, false, true));
    }

    private BaseItem Item(bool season = false)
    {
        BaseItem item = season ? new Season() : new Series();
        item.Id = Guid.NewGuid(); item.Name = "Show"; item.Path = "/media/show";
        Add(item);
        Add(new Episode { Id = Guid.NewGuid(), Name = "One", Path = "/media/show/one.mkv" }, descendant: true);
        Add(new Episode { Id = Guid.NewGuid(), Name = "Two", Path = "/media/show/two.mkv" }, descendant: true);
        return item;
    }

    private void Add(BaseItem item, bool descendant = false)
    {
        _items[item.Id] = item;
        _accessible.Add(item.Id);
        if (descendant) _descendants.Add(item);
    }

    private DeletionRequestController Controller() => new(_store, _users.Object, _library.Object)
    {
        ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("Jellyfin-UserId", _user.Id.ToString()) }, "Jellyfin"))
            }
        }
    };

    private SubmitDeletionRequest Submission(BaseItem item) => new()
    {
        ItemId = item.Id.ToString(), ItemType = item is Series ? "series" : item is Season ? "season" : "movie",
        ExpectedItemCount = item is Series or Season ? _descendants.OfType<Episode>().Count(value => !value.IsVirtualItem) : 1,
        ExpectedItemIds = _descendants.OfType<Episode>().Where(value => !value.IsVirtualItem).Select(value => value.Id).ToArray()
    };

    private DeletionRequest Due(BaseItem item, bool unconfirmed = false)
    {
        var scope = DeletionScope.Resolve(_library.Object, item);
        return _store.Create(new DeletionRequest
        {
            JellyfinItemId = item.Id, ItemName = item.Name ?? "Test", ItemType = item is Series ? "series" : item is Season ? "season" : "movie",
            ItemCount = scope.ItemCount(item), RequesterId = _user.Id, RequesterName = "test", Status = DeletionRequestStatus.Approved,
            CreatedAt = _now, ExecuteAt = _now, ScopeFingerprint = unconfirmed ? null : scope.Fingerprint
        });
    }

    [Fact]
    public void CardSchedulesIncludeOtherRequestersButOnlyVisibleAffectedItems()
    {
        var root = Item();
        var scope = DeletionScope.Resolve(_library.Object, root);
        _store.Create(new DeletionRequest
        {
            JellyfinItemId = root.Id, ItemName = "Private title", ItemType = "series", ItemCount = 2,
            RequesterId = Guid.NewGuid(), RequesterName = "Private requester", RequesterReason = "Private reason",
            Status = DeletionRequestStatus.Approved, ExecuteAt = _now.AddDays(7), CreatedAt = _now,
            ScopeFingerprint = scope.Fingerprint
        });
        _accessible.Remove(_descendants[1].Id);
        var result = Assert.IsType<OkObjectResult>(Controller().CardStatus().Result);
        var rows = Assert.IsType<DeletionCardStatus[]>(result.Value);
        Assert.Equal(2, rows.Length);
        Assert.Contains(rows, value => value.ItemId == root.Id);
        Assert.Contains(rows, value => value.ItemId == _descendants[0].Id);
        Assert.All(rows, value => Assert.Equal(_now.AddDays(7), value.ExecuteAt));
        Assert.Equal(new[] { "ExecuteAt", "ItemId" }, typeof(DeletionCardStatus).GetProperties().Select(value => value.Name).Order().ToArray());
        _accessible.Remove(root.Id);
        Assert.Empty(Assert.IsType<DeletionCardStatus[]>(Assert.IsType<OkObjectResult>(Controller().CardStatus().Result).Value));
    }

    [Fact]
    public void CardSchedulesIncludeMovieApprovalsWithoutAScopeFingerprint()
    {
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Movie", Path = "/media/movie.mkv" };
        Add(movie);
        Due(movie, unconfirmed: true);
        var rows = Assert.IsType<DeletionCardStatus[]>(Assert.IsType<OkObjectResult>(Controller().CardStatus().Result).Value);
        Assert.Equal(movie.Id, Assert.Single(rows).ItemId);
    }

    [Fact]
    public void CardSchedulesDisappearAfterScopeChangesOrBlocking()
    {
        var root = Item();
        var request = Due(root);
        Assert.NotEmpty(Assert.IsType<DeletionCardStatus[]>(Assert.IsType<OkObjectResult>(Controller().CardStatus().Result).Value));
        Add(new Episode { Id = Guid.NewGuid(), Path = "/media/show/new.mkv" }, descendant: true);
        Assert.Empty(Assert.IsType<DeletionCardStatus[]>(Assert.IsType<OkObjectResult>(Controller().CardStatus().Result).Value));
        _descendants.RemoveAt(_descendants.Count - 1);
        _store.MarkBlocked(request.Id, _now, "Blocked");
        Assert.Empty(Assert.IsType<DeletionCardStatus[]>(Assert.IsType<OkObjectResult>(Controller().CardStatus().Result).Value));
    }

    private DeletionExecutionService Service(IDeletionGuardProvider? guards = null, IDeletionDueRequestDispatcher? dispatcher = null) => new(
        dispatcher ?? new DeletionDueRequestDispatcher(_store), new DeletionExecutionBoundary(), guards ?? _guards.Object,
        _store, _library.Object, _logger, () => _config);

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task PlayingOrFavoriteDescendantProtectsSeriesAndSeason(bool season, bool favorite)
    {
        var parent = Item(season);
        var episode = _descendants[0];
        if (favorite)
        {
            _userData.Setup(value => value.GetUserData(_user, episode)).Returns(new UserItemData { Key = "test", IsFavorite = true });
        }
        else
        {
            _sessions.SetupGet(value => value.Sessions).Returns(new[]
            {
                new SessionInfo(_sessions.Object, NullLogger.Instance) { NowPlayingItem = new MediaBrowser.Model.Dto.BaseItemDto { Id = episode.Id } }
            });
        }
        var request = Due(parent);
        await Service(new DeletionGuardProvider(_sessions.Object, _users.Object, _userData.Object, _logger, _library.Object))
            .ExecuteDueAsync(_now, CancellationToken.None);
        var saved = _store.Get(request.Id)!;
        Assert.Equal(favorite ? DeletionRequestStatus.Blocked : DeletionRequestStatus.Approved, saved.Status);
        if (!favorite) Assert.True(saved.ExecuteAt > _now);
        _library.Verify(value => value.DeleteItem(It.IsAny<BaseItem>(), It.IsAny<DeleteOptions>()), Times.Never);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task UnchangedConfirmedParentCanExecute(bool season)
    {
        var parent = Item(season);
        var request = Due(parent);
        await Service().ExecuteDueAsync(_now, CancellationToken.None);
        Assert.Equal(DeletionRequestStatus.Executed, _store.Get(request.Id)!.Status);
        _library.Verify(value => value.DeleteItem(parent, It.Is<DeleteOptions>(options => options.DeleteFileLocation)), Times.Once);
    }

    [Theory]
    [InlineData("add")]
    [InlineData("replace")]
    [InlineData("path")]
    public async Task ScopeGrowthReplacementOrPathChangeBlocksExecution(string change)
    {
        var parent = Item();
        var request = Due(parent);
        if (change == "replace") _descendants.RemoveAt(0);
        if (change != "path") Add(new Episode { Id = Guid.NewGuid(), Path = "/media/show/new.mkv" }, true);
        else _descendants[0].Path = "/media/show/replaced.mkv";
        await Service().ExecuteDueAsync(_now, CancellationToken.None);
        Assert.Equal(DeletionRequestStatus.Blocked, _store.Get(request.Id)!.Status);
        _library.Verify(value => value.DeleteItem(It.IsAny<BaseItem>(), It.IsAny<DeleteOptions>()), Times.Never);
    }

    [Fact]
    public async Task ParentWithoutConfirmedScopeIsBlocked()
    {
        var request = Due(Item(), unconfirmed: true);
        await Service().ExecuteDueAsync(_now, CancellationToken.None);
        Assert.Equal(DeletionRequestStatus.Blocked, _store.Get(request.Id)!.Status);
        _library.Verify(value => value.DeleteItem(It.IsAny<BaseItem>(), It.IsAny<DeleteOptions>()), Times.Never);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SwitchOffOrConfigurationReplacementStopsNextDeletion(bool replace)
    {
        var first = new Movie { Id = Guid.NewGuid(), Name = "First" };
        var second = new Movie { Id = Guid.NewGuid(), Name = "Second" };
        Add(first); Add(second);
        var a = Due(first); var b = Due(second);
        _library.Setup(value => value.DeleteItem(first, It.IsAny<DeleteOptions>())).Callback(() =>
        {
            if (replace) _config = new PluginConfiguration { DeletionExecutionEnabled = false };
            else _config.DeletionExecutionEnabled = false;
        });
        await Service().ExecuteDueAsync(_now, CancellationToken.None);
        Assert.Equal(DeletionRequestStatus.Executed, _store.Get(a.Id)!.Status);
        Assert.Equal(DeletionRequestStatus.Approved, _store.Get(b.Id)!.Status);
        _library.Verify(value => value.DeleteItem(second, It.IsAny<DeleteOptions>()), Times.Never);
    }

    [Fact]
    public async Task StaleDueSnapshotDoesNotIgnoreRequeue()
    {
        var item = new Movie { Id = Guid.NewGuid() }; Add(item);
        var request = Due(item);
        var dispatcher = new Mock<IDeletionDueRequestDispatcher>();
        dispatcher.Setup(value => value.ListDue(_now)).Returns(new[] { request });
        _store.Requeue(request.Id, _now.AddMinutes(15), _now, "playing");
        await Service(dispatcher: dispatcher.Object).ExecuteDueAsync(_now, CancellationToken.None);
        Assert.Equal(DeletionRequestStatus.Approved, _store.Get(request.Id)!.Status);
        _library.Verify(value => value.DeleteItem(It.IsAny<BaseItem>(), It.IsAny<DeleteOptions>()), Times.Never);
    }

    [Fact]
    public void RestrictedRootIsNotDisclosedOrRequested()
    {
        var parent = Item(); _accessible.Clear();
        var controller = Controller();
        Assert.IsType<NotFoundResult>(controller.Scope(parent.Id.ToString(), "series").Result);
        Assert.IsType<NotFoundResult>(controller.Submit(Submission(parent)).Result);
        Assert.Empty(_store.List());
    }

    [Fact]
    public void PartiallyVisibleParentScopeIsForbidden()
    {
        var parent = Item(); _accessible.Remove(_descendants[0].Id);
        var controller = Controller();
        Assert.IsType<ForbidResult>(controller.Scope(parent.Id.ToString(), "series").Result);
        Assert.IsType<ForbidResult>(controller.Submit(Submission(parent)).Result);
        Assert.Empty(_store.List());
    }

    [Fact]
    public void SameCountDifferentEpisodeSelectionIsRejected()
    {
        var parent = Item();
        var body = Submission(parent);
        body.ExpectedItemIds![0] = Guid.NewGuid();
        Assert.IsType<ConflictObjectResult>(Controller().Submit(body).Result);
        Assert.Empty(_store.List());
    }

    [Fact]
    public void VisibleConfirmedParentSavesScopeAndRetryReturnsSameRequest()
    {
        var parent = Item(); var controller = Controller(); var body = Submission(parent);
        var created = Assert.IsType<DeletionRequest>(Assert.IsType<CreatedAtActionResult>(controller.Submit(body).Result).Value);
        var replay = Assert.IsType<DeletionRequest>(Assert.IsType<CreatedAtActionResult>(controller.Submit(body).Result).Value);
        Assert.Equal(created.Id, replay.Id);
        Assert.Equal(DeletionScope.Resolve(_library.Object, parent).Fingerprint, _store.Get(created.Id)!.ScopeFingerprint);
        Assert.Single(_store.List());
    }

    [Fact]
    public void ActiveRequestWithDifferentReasonReturnsConflict()
    {
        var parent = Item(); var controller = Controller();
        Assert.IsType<CreatedAtActionResult>(controller.Submit(Submission(parent)).Result);
        var conflict = new SubmitDeletionRequest { ItemId = parent.Id.ToString(), ItemType = "series", ExpectedItemCount = 2,
            ExpectedItemIds = _descendants.Select(value => value.Id).ToArray(), Reason = "different" };
        Assert.IsType<ConflictObjectResult>(controller.Submit(conflict).Result);
        Assert.Single(_store.List());
    }

    [Fact]
    public async Task ConcurrentDuplicateCreatesAreSerialized()
    {
        var item = new Movie { Id = Guid.NewGuid() }; Add(item);
        var source = new DeletionRequest { JellyfinItemId = item.Id, RequesterId = _user.Id, Status = DeletionRequestStatus.Pending, CreatedAt = _now };
        var requests = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() => _store.Create(source))));
        Assert.Single(requests.Select(value => value.Id).Distinct());
        Assert.Single(_store.List());
    }

    public void Dispose() => Directory.Delete(_directory, recursive: true);
}
