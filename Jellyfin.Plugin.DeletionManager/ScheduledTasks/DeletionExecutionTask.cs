using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.DeletionManager.Services;
using MediaBrowser.Model.Tasks;

namespace Jellyfin.Plugin.DeletionManager.ScheduledTasks;

public sealed class DeletionExecutionTask : IScheduledTask
{
    private readonly DeletionExecutionService _service;

    public DeletionExecutionTask(DeletionExecutionService service)
    {
        _service = service;
    }

    public string Name => "Process Media Deletion Requests";

    public string Key => "DeletionManagerExecution";

    public string Description => "Processes due, approved media deletion requests after safety guards.";

    public string Category => "Jellyfin Deletion Manager";

    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
    {
        return new[]
        {
            new TaskTriggerInfo
            {
                Type = TaskTriggerInfoType.IntervalTrigger,
                IntervalTicks = TimeSpan.FromMinutes(15).Ticks
            }
        };
    }

    public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        await _service.ExecuteDueAsync(DateTimeOffset.UtcNow, cancellationToken).ConfigureAwait(false);
        progress?.Report(100);
    }
}
