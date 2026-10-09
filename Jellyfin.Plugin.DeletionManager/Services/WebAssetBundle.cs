using System.Reflection;
using System.Security.Cryptography;
using System.Text;

namespace Jellyfin.Plugin.DeletionManager.Services;

/// <summary>
/// The browser UI as one script: the embedded files under <c>Web/</c> in load order. jdm-core.js must
/// come first, deletion-state.js second (it creates the shared namespace), deletion-menu.js last.
/// The bundle is wrapped: it starts after sign-in, and a second copy of the script on the page does nothing.
/// </summary>
public static class WebAssetBundle
{
    private const string ResourcePrefix = "Jellyfin.Plugin.DeletionManager.Web.";

    // index.html loads this script before sign-in, when window.ApiClient does not exist yet. The UI starts once a
    // user is signed in; a second copy of the script, or a second start, does nothing.
    private const string Prologue =
        "(function () {\n"
        + "if (window.JellyfinDeletionManager || window.__jdmStarting) return;\n"
        + "window.__jdmStarting = true;\n"
        + "function signedIn() {\n"
        + "  var c = window.ApiClient;\n"
        + "  return !!(c && typeof c.getCurrentUserId === 'function' && c.getCurrentUserId() && typeof c.accessToken === 'function' && c.accessToken());\n"
        + "}\n"
        + "function start() {\n";

    private const string Epilogue =
        "}\n"
        + "if (signedIn()) { start(); return; }\n"
        + "var timer = setInterval(function () { if (signedIn()) { clearInterval(timer); start(); } }, 250);\n"
        + "})();\n";

    private static readonly string[] Files =
    {
        "jdm-core.js",
        "deletion-state.js",
        "deletion-styles.js",
        "deletion-modal.js",
        "deletion-cards.js",
        "deletion-dashboard-page.js",
        "deletion-dashboard-actions.js",
        "deletion-nav.js",
        "deletion-library-badges.js",
        "deletion-request.js",
        "deletion-menu.js"
    };

    private static readonly Lazy<(string Script, string Version)> Bundle = new(Build);

    public static string Script => Bundle.Value.Script;

    /// <summary>Short content hash, so a changed script gets a new cache-busting URL even at the same plugin version.</summary>
    public static string Version => Bundle.Value.Version;

    public static string BuildScriptTag(string pluginName) =>
        $"<script plugin=\"{pluginName}\" version=\"{Version}\" src=\"../DeletionManager/script?v={Version}\" defer></script>";

    private static (string, string) Build()
    {
        var assembly = typeof(WebAssetBundle).Assembly;
        var builder = new StringBuilder();
        builder.Append(Prologue);
        foreach (var file in Files)
        {
            var name = ResourcePrefix + file;
            using var stream = assembly.GetManifestResourceStream(name)
                ?? throw new InvalidOperationException($"Embedded web asset is missing: {name}");
            using var reader = new StreamReader(stream, Encoding.UTF8);
            builder.Append("/* ").Append(file).Append(" */\n").Append(reader.ReadToEnd()).Append('\n');
        }

        builder.Append(Epilogue);
        var script = builder.ToString();
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(script)))[..12].ToLowerInvariant();
        return (script, hash);
    }
}
