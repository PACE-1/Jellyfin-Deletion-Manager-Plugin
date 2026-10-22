using Jellyfin.Plugin.DeletionManager.ScheduledTasks;
using Jellyfin.Plugin.DeletionManager.Services;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.DeletionManager;

public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<Logger>();
        serviceCollection.AddSingleton<DeletionRequestStore>();
        serviceCollection.AddSingleton<IDeletionExecutor, DeletionExecutionBoundary>();
        serviceCollection.AddSingleton<IDeletionDueRequestDispatcher, DeletionDueRequestDispatcher>();
        serviceCollection.AddSingleton<IDeletionGuardProvider, DeletionGuardProvider>();
        serviceCollection.AddSingleton<IArrUnmonitorService, ArrUnmonitorService>();
        serviceCollection.AddSingleton<DeletionExecutionService>();
        serviceCollection.AddTransient<DeletionExecutionTask>();
        serviceCollection.AddTransient<IScheduledTask, DeletionExecutionTask>();
        serviceCollection.AddSingleton<IStartupFilter, ScriptInjectionStartupFilter>();
    }
}
