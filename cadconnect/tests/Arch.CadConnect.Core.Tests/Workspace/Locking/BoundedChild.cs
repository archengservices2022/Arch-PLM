using System.Diagnostics;

namespace Arch.CadConnect.Core.Tests.Workspace.Locking;

/// <summary>What a child process did within its time limit.</summary>
/// <param name="ExitCode">Null if it could not be read after a kill.</param>
internal sealed record BoundedChildResult(int ProcessId, int? ExitCode, string Output, string Error, bool TimedOut);

/// <summary>
/// Runs a child process that cannot hang a test. Both pipes are read from the
/// start, so a full pipe cannot block the child, and neither read can outlast the
/// wait. At the limit the whole process tree is killed, and whatever had been
/// written so far is returned.
/// </summary>
internal static class BoundedChild
{
    private static readonly TimeSpan DrainLimit = TimeSpan.FromSeconds(5);

    public static BoundedChildResult Run(string executable, TimeSpan limit, params string[] args)
    {
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var arg in args)
        {
            start.ArgumentList.Add(arg);
        }

        using var child = Process.Start(start)!;
        var output = child.StandardOutput.ReadToEndAsync();
        var error = child.StandardError.ReadToEndAsync();

        var timedOut = !child.WaitForExit((int)limit.TotalMilliseconds);
        if (timedOut)
        {
            child.Kill(entireProcessTree: true);
            child.WaitForExit((int)DrainLimit.TotalMilliseconds);
        }
        Task.WhenAll(output, error).Wait(DrainLimit);

        return new BoundedChildResult(
            child.Id,
            child.HasExited ? child.ExitCode : null,
            output.IsCompletedSuccessfully ? output.Result : "",
            error.IsCompletedSuccessfully ? error.Result : "",
            timedOut);
    }
}
