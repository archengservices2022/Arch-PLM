using System.Runtime.CompilerServices;

namespace Arch.CadConnect.Api.Tests;

/// <summary>
/// CI stability (test-only): several reconciler/orchestrator tests give the
/// status queries a short deadline (50-100 ms) and assert that the workers
/// had STARTED before it expired. Other tests in this assembly deliberately
/// block thread-pool threads (synchronous queries ignoring cancellation),
/// and xUnit runs test classes in parallel. On a 2-core machine (GitHub
/// windows-latest) the pool starts with 2 threads and injects more slowly
/// than those deadlines, so workers sometimes had not started yet
/// (reproduced locally with 2-CPU affinity). Raising the pool MINIMUM only
/// removes that start-up delay; it changes no deadline, assertion or
/// product code, and a machine with more cores is unaffected.
/// </summary>
internal static class TestThreadPoolSetup
{
    private const int MinimumThreads = 64;

    [ModuleInitializer]
    internal static void RaiseThreadPoolMinimum()
    {
        ThreadPool.GetMinThreads(out var worker, out var io);
        ThreadPool.SetMinThreads(Math.Max(worker, MinimumThreads), Math.Max(io, MinimumThreads));
    }
}
