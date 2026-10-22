using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.DeletionManager.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;

namespace Jellyfin.Plugin.DeletionManager.Services;

/// <summary>Stops Sonarr/Radarr from downloading media that is about to be deleted, without removing the series or movie from them.</summary>
public interface IArrUnmonitorService
{
    /// <summary>Throws when a configured Sonarr/Radarr cannot be updated. Returns normally when nothing is configured or the media is not tracked there.</summary>
    Task UnmonitorAsync(BaseItem item, DeletionScope scope, PluginConfiguration configuration, CancellationToken cancellationToken);
}

public sealed class NoArrUnmonitorService : IArrUnmonitorService
{
    public static readonly NoArrUnmonitorService Instance = new();

    public Task UnmonitorAsync(BaseItem item, DeletionScope scope, PluginConfiguration configuration, CancellationToken cancellationToken)
        => Task.CompletedTask;
}

public sealed class ArrUnmonitorService : IArrUnmonitorService
{
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(30);
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly Logger _logger;

    public ArrUnmonitorService(IHttpClientFactory httpClientFactory, Logger logger)
    {
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    public async Task UnmonitorAsync(BaseItem item, DeletionScope scope, PluginConfiguration configuration, CancellationToken cancellationToken)
    {
        if (item is Movie && IsConfigured(configuration.RadarrUrl, configuration.RadarrApiKey))
        {
            await UnmonitorMovieAsync(item, configuration.RadarrUrl, configuration.RadarrApiKey, cancellationToken).ConfigureAwait(false);
        }
        else if (item is Series or Season or Episode && IsConfigured(configuration.SonarrUrl, configuration.SonarrApiKey))
        {
            await UnmonitorEpisodesAsync(item, scope, configuration.SonarrUrl, configuration.SonarrApiKey, cancellationToken).ConfigureAwait(false);
        }
    }

    private static bool IsConfigured(string url, string apiKey)
        => !string.IsNullOrWhiteSpace(url) && !string.IsNullOrWhiteSpace(apiKey);

    private async Task UnmonitorMovieAsync(BaseItem item, string url, string apiKey, CancellationToken ct)
    {
        if (!item.ProviderIds.TryGetValue("Tmdb", out var tmdbId) || !int.TryParse(tmdbId, out var tmdb))
        {
            _logger.Warning($"[Arr] Movie {item.Id} has no TMDb id; Radarr was not updated.");
            return;
        }

        var matches = await SendAsync(HttpMethod.Get, Url(url, $"movie?tmdbId={tmdb}"), apiKey, null, ct).ConfigureAwait(false);
        var movieIds = matches?.AsArray().Select(movie => (int?)movie?["id"]).OfType<int>().ToArray() ?? Array.Empty<int>();
        if (movieIds.Length == 0)
        {
            _logger.Info($"[Arr] TMDb {tmdb} is not in Radarr; nothing to unmonitor.");
            return;
        }

        await SendAsync(HttpMethod.Put, Url(url, "movie/editor"), apiKey,
            new JsonObject { ["movieIds"] = new JsonArray(movieIds.Select(id => (JsonNode)JsonValue.Create(id)!).ToArray()), ["monitored"] = false }, ct).ConfigureAwait(false);
        _logger.Info($"[Arr] Unmonitored TMDb {tmdb} in Radarr (movie kept).");
    }

    private async Task UnmonitorEpisodesAsync(BaseItem item, DeletionScope scope, string url, string apiKey, CancellationToken ct)
    {
        var series = item switch
        {
            Series value => value,
            Season value => value.Series,
            Episode value => value.Series,
            _ => null
        };
        if (series is null || !series.ProviderIds.TryGetValue("Tvdb", out var tvdbId) || !int.TryParse(tvdbId, out var tvdb))
        {
            _logger.Warning($"[Arr] Item {item.Id} has no series TVDB id; Sonarr was not updated.");
            return;
        }

        var matches = await SendAsync(HttpMethod.Get, Url(url, $"series?tvdbId={tvdb}"), apiKey, null, ct).ConfigureAwait(false);
        var sonarrSeriesId = (int?)matches?.AsArray().FirstOrDefault()?["id"];
        if (sonarrSeriesId is null)
        {
            _logger.Info($"[Arr] TVDB {tvdb} is not in Sonarr; nothing to unmonitor.");
            return;
        }

        var episodes = await SendAsync(HttpMethod.Get, Url(url, $"episode?seriesId={sonarrSeriesId}"), apiKey, null, ct).ConfigureAwait(false);
        var numbers = scope.Items.OfType<Episode>().SelectMany(EpisodeNumbers).ToHashSet();
        var episodeIds = (episodes?.AsArray() ?? new JsonArray())
            .Where(episode => item is Series
                || (item is Season season && (int?)episode?["seasonNumber"] == season.IndexNumber)
                || numbers.Contains(((int?)episode?["seasonNumber"] ?? -1, (int?)episode?["episodeNumber"] ?? -1)))
            .Select(episode => (int?)episode?["id"])
            .OfType<int>()
            .ToArray();

        if (episodeIds.Length > 0)
        {
            await SendAsync(HttpMethod.Put, Url(url, "episode/monitor"), apiKey,
                new JsonObject { ["episodeIds"] = new JsonArray(episodeIds.Select(id => (JsonNode)JsonValue.Create(id)!).ToArray()), ["monitored"] = false }, ct).ConfigureAwait(false);
        }

        if (item is Series)
        {
            await UnmonitorSeriesAsync(url, apiKey, sonarrSeriesId.Value, ct).ConfigureAwait(false);
        }

        _logger.Info($"[Arr] Unmonitored {episodeIds.Length} episode(s) of TVDB {tvdb} in Sonarr (series kept).");
    }

    // A fully deleted show must not pick up and download future episodes either.
    private async Task UnmonitorSeriesAsync(string url, string apiKey, int sonarrSeriesId, CancellationToken ct)
    {
        var series = (await SendAsync(HttpMethod.Get, Url(url, $"series/{sonarrSeriesId}"), apiKey, null, ct).ConfigureAwait(false))?.AsObject();
        if (series is null) return;
        series["monitored"] = false;
        if (series.ContainsKey("monitorNewItems")) series["monitorNewItems"] = "none";
        foreach (var season in series["seasons"]?.AsArray() ?? new JsonArray())
        {
            if (season is JsonObject value) value["monitored"] = false;
        }

        await SendAsync(HttpMethod.Put, Url(url, $"series/{sonarrSeriesId}"), apiKey, series, ct).ConfigureAwait(false);
    }

    private static IEnumerable<(int Season, int Episode)> EpisodeNumbers(Episode episode)
    {
        if (episode.ParentIndexNumber is not int season || episode.IndexNumber is not int first) yield break;
        for (var number = first; number <= Math.Max(first, episode.IndexNumberEnd ?? first); number++) yield return (season, number);
    }

    private static string Url(string baseUrl, string path) => $"{baseUrl.TrimEnd('/')}/api/v3/{path}";

    private async Task<JsonNode?> SendAsync(HttpMethod method, string url, string apiKey, JsonNode? body, CancellationToken ct)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            throw new InvalidOperationException("The Sonarr/Radarr URL must start with http:// or https://.");
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(RequestTimeout);
        using var request = new HttpRequestMessage(method, uri);
        request.Headers.Add("X-Api-Key", apiKey);
        if (body is not null) request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        using var response = await _httpClientFactory.CreateClient().SendAsync(request, timeout.Token).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        var text = await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false);
        return string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
    }
}
