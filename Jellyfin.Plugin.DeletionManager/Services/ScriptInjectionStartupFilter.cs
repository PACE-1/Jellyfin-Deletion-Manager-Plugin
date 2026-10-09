using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.DeletionManager.Services;

/// <summary>
/// Adds the Deletion Manager &lt;script&gt; tag to jellyfin-web's index.html at request time.
/// Jellyfin 12 serves index.html as a plain static file with no plugin hook, so this middleware runs ahead
/// of the static-file handler and rewrites that one response. Nothing is written to the web folder.
/// Adapted from the script injection filter in Jellyfin Enhanced (n00bcodr/Jellyfin-Enhanced, GPL-3.0).
///
/// It touches only GET responses for the web app shell, does nothing when the tag is already present, and
/// on any error serves the original page.
/// </summary>
public class ScriptInjectionStartupFilter : IStartupFilter
{
    private const string ScriptMarker = "/DeletionManager/script";

    private readonly Logger _logger;
    private int _loggedOnce;

    public ScriptInjectionStartupFilter(Logger logger)
    {
        _logger = logger;
    }

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            // Registered before the rest of the pipeline so this runs outermost: removing Accept-Encoding
            // below then reliably yields an uncompressed response we can read and rewrite.
            app.Use(InvokeAsync);
            next(app);
        };
    }

    private async Task InvokeAsync(HttpContext context, Func<Task> nextMiddleware)
    {
        // Only GET produces a body we can rewrite; HEAD and the rest pass through so the host emits correct headers.
        if (!IsIndexRequest(context.Request.Path.Value) || !HttpMethods.IsGet(context.Request.Method))
        {
            await nextMiddleware().ConfigureAwait(false);
            return;
        }

        // A complete, plain-text 200 is needed: drop compression and range requests (a 206 would pass through un-injected).
        context.Request.Headers.Remove("Accept-Encoding");
        context.Request.Headers.Remove("Range");
        context.Request.Headers.Remove("If-Range");

        var originalBody = context.Response.Body;
        using var buffer = new MemoryStream();
        context.Response.Body = buffer;
        try
        {
            await nextMiddleware().ConfigureAwait(false);
        }
        catch
        {
            // The buffered body never reached the real stream; restore it and let the host render the error.
            context.Response.Body = originalBody;
            throw;
        }

        context.Response.Body = originalBody;
        buffer.Seek(0, SeekOrigin.Begin);

        var isHtml = context.Response.StatusCode == 200
            && (context.Response.ContentType?.Contains("text/html", StringComparison.OrdinalIgnoreCase) ?? false);
        if (!isHtml)
        {
            await buffer.CopyToAsync(originalBody).ConfigureAwait(false);
            return;
        }

        string html;
        using (var reader = new StreamReader(buffer, Encoding.UTF8, true, 1024, leaveOpen: true))
        {
            html = await reader.ReadToEndAsync().ConfigureAwait(false);
        }

        try
        {
            var alreadyInjected = html.Contains(ScriptMarker, StringComparison.OrdinalIgnoreCase);
            var bodyClose = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
            if (!alreadyInjected && bodyClose >= 0)
            {
                var tag = WebAssetBundle.BuildScriptTag(Plugin.Instance?.Name ?? "Jellyfin Deletion Manager");
                html = string.Concat(html.AsSpan(0, bodyClose), tag, "\n", html.AsSpan(bodyClose));
                if (System.Threading.Interlocked.Exchange(ref _loggedOnce, 1) == 0)
                {
                    _logger.Info("Injected the client script into the web app through request-time middleware.");
                }
            }
        }
        catch (Exception ex)
        {
            _logger.Warning($"Script injection middleware error (serving original HTML): {ex.Message}");
        }

        var bytes = Encoding.UTF8.GetBytes(html);
        context.Response.ContentType = "text/html;charset=utf-8";
        context.Response.ContentLength = bytes.Length;
        // The body changed, so validators from the static-file handler are no longer true.
        context.Response.Headers.Remove("ETag");
        context.Response.Headers.Remove("Last-Modified");
        context.Response.Headers.Remove("Accept-Ranges");
        await originalBody.WriteAsync(bytes).ConfigureAwait(false);
    }

    // The web app shell however it is requested: "/web", "/web/" and "/web/index.html". EndsWith keeps this
    // correct under a base-url prefix such as /jellyfin/web/.
    private static bool IsIndexRequest(string? path)
    {
        if (string.IsNullOrEmpty(path)) return false;
        return path.EndsWith("/web/index.html", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith("/web/", StringComparison.OrdinalIgnoreCase)
            || path.Equals("/web", StringComparison.OrdinalIgnoreCase);
    }
}
