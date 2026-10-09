using System.Text;
using Jellyfin.Plugin.DeletionManager.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.DeletionManager.Controllers;

/// <summary>Serves the browser UI script. Anonymous because index.html loads it before sign-in; it contains no data.</summary>
[ApiController]
[Route("DeletionManager")]
public sealed class WebAssetController : ControllerBase
{
    [HttpGet("script")]
    [AllowAnonymous]
    public ActionResult GetScript()
    {
        // The URL carries ?v=<content hash>, so a changed script is a new URL and immutable caching is safe.
        Response.Headers.CacheControl = "public, max-age=31536000, immutable";
        return Content(WebAssetBundle.Script, "application/javascript", Encoding.UTF8);
    }
}
