using System.Text;
using Jellyfin.Plugin.DeletionManager.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Jellyfin.Plugin.DeletionManager.Tests;

public sealed class WebAssetAndInjectionTests
{
    private const string Page = "<html><head></head><body><div id=\"app\"></div></body></html>";

    [Fact]
    public void BundleContainsEveryEmbeddedWebFileInLoadOrderInsideAGuard()
    {
        var script = WebAssetBundle.Script;
        Assert.StartsWith("(function () {\nif (window.JellyfinDeletionManager || window.__jdmStarting) return;", script);
        Assert.Contains("function start() {", script);
        Assert.EndsWith("setInterval(function () { if (signedIn()) { clearInterval(timer); start(); } }, 250);\n})();\n", script);

        var embedded = typeof(WebAssetBundle).Assembly.GetManifestResourceNames()
            .Where(name => name.StartsWith("Jellyfin.Plugin.DeletionManager.Web.", StringComparison.Ordinal))
            .Select(name => name["Jellyfin.Plugin.DeletionManager.Web.".Length..])
            .ToList();
        Assert.NotEmpty(embedded);
        foreach (var file in embedded)
        {
            Assert.Contains($"/* {file} */", script);
        }

        Assert.True(script.IndexOf("/* jdm-core.js */", StringComparison.Ordinal) < script.IndexOf("/* deletion-state.js */", StringComparison.Ordinal));
        Assert.True(script.IndexOf("/* deletion-state.js */", StringComparison.Ordinal) < script.IndexOf("/* deletion-nav.js */", StringComparison.Ordinal));
        Assert.True(script.IndexOf("/* deletion-nav.js */", StringComparison.Ordinal) < script.IndexOf("/* deletion-menu.js */", StringComparison.Ordinal));
    }

    [Fact]
    public void BundleHasNoDependencyOnTheEnhancedFramework()
    {
        var script = WebAssetBundle.Script;
        Assert.DoesNotContain("window.JellyfinEnhanced", script);
        Assert.DoesNotContain("/JellyfinEnhanced/", script);
        Assert.DoesNotContain("je-deletion-", script);
        Assert.DoesNotContain("'/Deletion/Requests", script);
    }

    [Fact]
    public void ScriptTagIsRelativeAndCarriesTheContentHash()
    {
        Assert.Matches("^[0-9a-f]{12}$", WebAssetBundle.Version);
        var tag = WebAssetBundle.BuildScriptTag("Jellyfin Deletion Manager");
        Assert.Equal(
            $"<script plugin=\"Jellyfin Deletion Manager\" version=\"{WebAssetBundle.Version}\" src=\"../DeletionManager/script?v={WebAssetBundle.Version}\" defer></script>",
            tag);
    }

    [Theory]
    [InlineData("/web/index.html")]
    [InlineData("/web/")]
    [InlineData("/web")]
    [InlineData("/jellyfin/web/index.html")]
    public async Task InjectsTheTagOnceBeforeTheClosingBody(string path)
    {
        var (body, context) = await Run(path, "GET", Page, "text/html");
        var tag = WebAssetBundle.BuildScriptTag("Jellyfin Deletion Manager");
        Assert.Equal(Page.Replace("</body>", tag + "\n</body>", StringComparison.Ordinal), body);
        Assert.Equal(Encoding.UTF8.GetByteCount(body), context.Response.ContentLength);
        Assert.False(context.Response.Headers.ContainsKey("ETag"));
        Assert.False(context.Response.Headers.ContainsKey("Last-Modified"));
    }

    [Fact]
    public async Task DoesNotInjectTwice()
    {
        var withTag = Page.Replace("</body>", "<script src=\"../DeletionManager/script?v=old\" defer></script></body>", StringComparison.Ordinal);
        var (body, _) = await Run("/web/index.html", "GET", withTag, "text/html");
        Assert.Equal(withTag, body);
    }

    [Theory]
    [InlineData("/web/main.bundle.js", "GET", "text/html")]
    [InlineData("/web/index.html", "POST", "text/html")]
    [InlineData("/web/index.html", "HEAD", "text/html")]
    [InlineData("/web/index.html", "GET", "application/json")]
    public async Task LeavesEverythingElseUntouched(string path, string method, string contentType)
    {
        var (body, _) = await Run(path, method, Page, contentType);
        Assert.Equal(Page, body);
    }

    [Fact]
    public async Task DropsCompressionAndRangeRequestsSoThePageCanBeRewritten()
    {
        string? seenEncoding = null;
        string? seenRange = null;
        await Run("/web/index.html", "GET", Page, "text/html", request =>
        {
            request.Headers["Accept-Encoding"] = "gzip";
            request.Headers["Range"] = "bytes=0-10";
        }, request =>
        {
            seenEncoding = request.Headers["Accept-Encoding"];
            seenRange = request.Headers["Range"];
        });
        Assert.True(string.IsNullOrEmpty(seenEncoding));
        Assert.True(string.IsNullOrEmpty(seenRange));
    }

    [Fact]
    public async Task ADownstreamFailureIsNotSwallowedAndTheRealBodyIsRestored()
    {
        var context = new DefaultHttpContext();
        var real = new MemoryStream();
        context.Response.Body = real;
        context.Request.Path = "/web/index.html";
        context.Request.Method = "GET";
        var filter = new ScriptInjectionStartupFilter(new Logger(NullLoggerFactory.Instance));
        var app = new ApplicationBuilder(new ServiceCollection().BuildServiceProvider());
        filter.Configure(inner => inner.Run(_ => throw new InvalidOperationException("downstream")))(app);

        await Assert.ThrowsAsync<InvalidOperationException>(() => app.Build()(context));
        Assert.Same(real, context.Response.Body);
        Assert.Equal(0, real.Length);
    }

    private static async Task<(string Body, HttpContext Context)> Run(
        string path, string method, string html, string contentType,
        Action<HttpRequest>? prepare = null, Action<HttpRequest>? observe = null)
    {
        var context = new DefaultHttpContext();
        var output = new MemoryStream();
        context.Response.Body = output;
        context.Request.Path = path;
        context.Request.Method = method;
        prepare?.Invoke(context.Request);

        var filter = new ScriptInjectionStartupFilter(new Logger(NullLoggerFactory.Instance));
        var app = new ApplicationBuilder(new ServiceCollection().BuildServiceProvider());
        filter.Configure(inner => inner.Run(async ctx =>
        {
            observe?.Invoke(ctx.Request);
            ctx.Response.StatusCode = 200;
            ctx.Response.ContentType = contentType;
            ctx.Response.Headers["ETag"] = "\"abc\"";
            ctx.Response.Headers["Last-Modified"] = "Wed, 01 Jan 2026 00:00:00 GMT";
            await ctx.Response.WriteAsync(html);
        }))(app);

        await app.Build()(context);
        return (Encoding.UTF8.GetString(output.ToArray()), context);
    }
}
