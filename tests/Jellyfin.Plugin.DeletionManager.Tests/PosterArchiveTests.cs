using Jellyfin.Data.Enums;
using Jellyfin.Plugin.DeletionManager.Services;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace Jellyfin.Plugin.DeletionManager.Tests;

public sealed class PosterArchiveTests : IDisposable
{
    private readonly string _dataPath = Path.Combine(Path.GetTempPath(), "deletion-manager-poster-tests", Guid.NewGuid().ToString("N"));
    private readonly PosterArchive _archive;

    public PosterArchiveTests()
    {
        Directory.CreateDirectory(_dataPath);
        var applicationPaths = new Mock<IApplicationPaths>();
        applicationPaths.SetupGet(paths => paths.DataPath).Returns(_dataPath);
        _archive = new PosterArchive(applicationPaths.Object, new Logger(NullLoggerFactory.Instance));
    }

    [Fact]
    public void PosterSurvivesDeletionOfTheOriginalFile()
    {
        var source = Path.Combine(_dataPath, "poster.jpg");
        File.WriteAllText(source, "image-bytes");
        var movie = new Movie { ImageInfos = [new ItemImageInfo { Type = ImageType.Primary, Path = source }] };

        _archive.Save(42, movie);
        File.Delete(source);

        var kept = _archive.TryGetPath(42);
        Assert.NotNull(kept);
        Assert.Equal("image-bytes", File.ReadAllText(kept!));
    }

    [Fact]
    public void ItemWithoutPosterIsSkippedWithoutError()
    {
        _archive.Save(43, new Movie());

        Assert.Null(_archive.TryGetPath(43));
    }

    public void Dispose()
    {
        if (Directory.Exists(_dataPath)) Directory.Delete(_dataPath, recursive: true);
    }
}
