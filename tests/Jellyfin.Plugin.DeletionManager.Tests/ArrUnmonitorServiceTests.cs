using System.Net;
using System.Text;
using Jellyfin.Plugin.DeletionManager.Configuration;
using Jellyfin.Plugin.DeletionManager.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace Jellyfin.Plugin.DeletionManager.Tests;

public sealed class ArrUnmonitorServiceTests
{
    private readonly List<(HttpMethod Method, string Url, string Body)> _calls = new();
    private readonly Dictionary<string, string> _responses = new();
    private readonly PluginConfiguration _configuration = new()
    {
        SonarrUrl = "http://sonarr:8989/", SonarrApiKey = "s-key", RadarrUrl = "http://radarr:7878", RadarrApiKey = "r-key"
    };

    [Fact]
    public async Task MovieIsUnmonitoredNotRemoved()
    {
        var movie = new Movie { Id = Guid.NewGuid(), ProviderIds = new Dictionary<string, string> { ["Tmdb"] = "603" } };
        _responses["GET http://radarr:7878/api/v3/movie?tmdbId=603"] = """[{"id":7}]""";

        await Service().UnmonitorAsync(movie, Scope(movie), _configuration, CancellationToken.None);

        Assert.Contains(_calls, c => c.Method == HttpMethod.Put && c.Url.EndsWith("/api/v3/movie/editor") && c.Body.Contains("\"monitored\":false") && c.Body.Contains("[7]"));
        Assert.DoesNotContain(_calls, c => c.Method == HttpMethod.Delete);
    }

    [Fact]
    public async Task SeriesEpisodesAndSeriesAreUnmonitoredNotRemoved()
    {
        var series = new Series { Id = Guid.NewGuid(), ProviderIds = new Dictionary<string, string> { ["Tvdb"] = "81189" } };
        _responses["GET http://sonarr:8989/api/v3/series?tvdbId=81189"] = """[{"id":5}]""";
        _responses["GET http://sonarr:8989/api/v3/episode?seriesId=5"] =
            """[{"id":10,"seasonNumber":1,"episodeNumber":1},{"id":11,"seasonNumber":2,"episodeNumber":4}]""";
        _responses["GET http://sonarr:8989/api/v3/series/5"] =
            """{"id":5,"monitored":true,"monitorNewItems":"all","seasons":[{"seasonNumber":1,"monitored":true}]}""";

        await Service().UnmonitorAsync(series, Scope(series), _configuration, CancellationToken.None);

        var episodes = Assert.Single(_calls, c => c.Method == HttpMethod.Put && c.Url.EndsWith("/api/v3/episode/monitor"));
        Assert.Contains("10", episodes.Body);
        Assert.Contains("11", episodes.Body);
        Assert.Contains("\"monitored\":false", episodes.Body);
        var seriesPut = Assert.Single(_calls, c => c.Method == HttpMethod.Put && c.Url.EndsWith("/api/v3/series/5"));
        Assert.Contains("\"monitored\":false", seriesPut.Body);
        Assert.Contains("\"monitorNewItems\":\"none\"", seriesPut.Body);
        Assert.DoesNotContain(_calls, c => c.Method == HttpMethod.Delete);
    }

    [Fact]
    public async Task UnreachableArrThrowsSoDeletionCanBeHeld()
    {
        var movie = new Movie { Id = Guid.NewGuid(), ProviderIds = new Dictionary<string, string> { ["Tmdb"] = "603" } };
        _responses["GET http://radarr:7878/api/v3/movie?tmdbId=603"] = "ERROR";

        await Assert.ThrowsAsync<HttpRequestException>(() => Service().UnmonitorAsync(movie, Scope(movie), _configuration, CancellationToken.None));
    }

    [Fact]
    public async Task UnconfiguredArrIsSkipped()
    {
        var movie = new Movie { Id = Guid.NewGuid(), ProviderIds = new Dictionary<string, string> { ["Tmdb"] = "603" } };

        await Service().UnmonitorAsync(movie, Scope(movie), new PluginConfiguration(), CancellationToken.None);

        Assert.Empty(_calls);
    }

    private static DeletionScope Scope(BaseItem item) => new(new[] { item }, Array.Empty<Guid>(), "x");

    private ArrUnmonitorService Service()
    {
        var handler = new StubHandler(_calls, _responses);
        var factory = new Mock<IHttpClientFactory>();
        factory.Setup(f => f.CreateClient(It.IsAny<string>())).Returns(() => new HttpClient(handler));
        return new ArrUnmonitorService(factory.Object, new Logger(NullLoggerFactory.Instance));
    }

    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly List<(HttpMethod, string, string)> _calls;
        private readonly Dictionary<string, string> _responses;
        public StubHandler(List<(HttpMethod, string, string)> calls, Dictionary<string, string> responses) { _calls = calls; _responses = responses; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(cancellationToken);
            _calls.Add((request.Method, request.RequestUri!.ToString(), body));
            if (!_responses.TryGetValue($"{request.Method} {request.RequestUri}", out var json))
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{}", Encoding.UTF8, "application/json") };
            return json == "ERROR"
                ? new HttpResponseMessage(HttpStatusCode.InternalServerError)
                : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        }
    }
}
