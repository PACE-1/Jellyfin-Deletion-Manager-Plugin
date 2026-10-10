using System;

namespace Jellyfin.Plugin.DeletionManager.Services;

public sealed class DeletionRequestLimitException(string message) : InvalidOperationException(message);
