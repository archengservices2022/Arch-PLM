using System.Text;
using System.Text.Json;

using Arch.CadConnect.Core.Diagnostics;

namespace Arch.CadConnect.Core.Tests.Diagnostics;

/// <summary>
/// M4.2: the JSON Lines writer, against real temp folders - one file per
/// attempt, allow-listed and sanitized fields only, redaction of everything
/// secret-shaped, rotation and retention that only ever touches its own
/// files, and failure isolation.
/// </summary>
public sealed class JsonLinesDiagnosticsSinkTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "arch-m42-" + Guid.NewGuid().ToString("N"));
    private readonly FixedTime _time = new(new DateTimeOffset(2026, 10, 28, 12, 0, 0, TimeSpan.Zero));

    public JsonLinesDiagnosticsSinkTests() => Directory.CreateDirectory(_root);

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private string LogDir => Path.Combine(_root, "logs");

    private JsonLinesDiagnosticsSink Sink(DiagnosticsRetention? retention = null) => new(LogDir, retention, userProfile: @"C:\Users\Someone");

    private string[] LogFiles() => Directory.Exists(LogDir)
        ? Directory.GetFiles(LogDir).Select(p => Path.GetFileName(p)!).OrderBy(n => n, StringComparer.Ordinal).ToArray()
        : Array.Empty<string>();

    private static JsonElement[] Lines(string path) => ReadShared(path).Split('\n')
        .Where(l => l.Length > 0).Select(l => JsonDocument.Parse(l).RootElement.Clone()).ToArray();

    /// <summary>Reads a log file even while a writer still owns it (which
    ///  only allows read sharing).</summary>
    private static string ReadShared(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    // ---- format ---------------------------------------------------------------

    [Fact]
    public void Each_attempt_gets_its_own_file_with_one_JSON_object_per_event()
    {
        var sink = Sink();
        var first = DiagnosticsAttempt.Start(sink, "pdm.checkout", _time, DiagnosticField.Code("command", "Checkout"));
        first.Succeeded(DiagnosticField.Number("versionNumber", 2));
        var second = DiagnosticsAttempt.Start(sink, "copydesign.apply", _time);
        second.Failed(DiagnosticField.Code("outcome", "ReservationCallFailed"));

        var files = LogFiles();
        Assert.Equal(2, files.Length);
        Assert.All(files, f => Assert.True(JsonLinesDiagnosticsSink.IsOwnLogFileName(f), f));
        var lines = Lines(Path.Combine(LogDir, files.Single(f => f.Contains("_pdm.checkout_"))));
        Assert.Equal(2, lines.Length);
        Assert.Equal("started", lines[0].GetProperty("outcome").GetString());
        Assert.Equal("succeeded", lines[1].GetProperty("outcome").GetString());
        Assert.Equal(1, lines[0].GetProperty("seq").GetInt32());
        Assert.Equal(2, lines[1].GetProperty("seq").GetInt32());
        Assert.Equal(first.AttemptId, lines[0].GetProperty("attempt").GetString());
        Assert.Equal("Checkout", lines[0].GetProperty("data").GetProperty("command").GetString());
        Assert.Equal(2, lines[1].GetProperty("data").GetProperty("versionNumber").GetInt64());
        Assert.StartsWith("20261028T120000Z_pdm.checkout_" + first.AttemptId, files.Single(f => f.Contains("_pdm.checkout_")));
    }

    [Fact]
    public void Started_succeeded_failed_refused_and_cleanup_are_distinguished()
    {
        var sink = Sink();
        var attempt = DiagnosticsAttempt.Start(sink, "copydesign.apply", _time);
        attempt.Step("models.copy");
        attempt.Cleanup(DiagnosticField.Number("removed", 2));
        attempt.Failed(DiagnosticField.Code("outcome", "PhysicalCopyFailed"));
        DiagnosticsAttempt.Refuse(sink, "refusal.workspace-origin", _time, DiagnosticField.Code("command", "Checkout"));

        var outcomes = LogFiles().SelectMany(f => Lines(Path.Combine(LogDir, f))).Select(l => l.GetProperty("outcome").GetString()).ToArray();
        Assert.Equal(new[] { "started", "step", "cleanup", "failed", "refused" }, outcomes.OrderBy(o => o switch
        {
            "started" => 0, "step" => 1, "cleanup" => 2, "failed" => 3, _ => 4,
        }));
    }

    [Fact]
    public void Fields_not_on_the_allow_list_or_of_the_wrong_kind_are_dropped_and_counted()
    {
        var sink = Sink();
        DiagnosticsAttempt.Start(sink, "pdm.checkout", _time,
            DiagnosticField.Code("command", "Checkout"),
            DiagnosticField.Text("email", "x@example.com"),           // not allow-listed
            DiagnosticField.Text("operationId", "op-1"),              // wrong kind (Id)
            DiagnosticField.Code("command", "Second"));               // duplicate

        var line = Lines(Path.Combine(LogDir, LogFiles().Single())).Single();
        var data = line.GetProperty("data");
        Assert.Equal("Checkout", data.GetProperty("command").GetString());
        Assert.False(data.TryGetProperty("email", out _));
        Assert.False(data.TryGetProperty("operationId", out _));
        Assert.Equal(3, line.GetProperty("droppedFields").GetInt32());
    }

    // ---- redaction --------------------------------------------------------------

    [Fact]
    public void No_secret_planted_anywhere_ever_reaches_the_file()
    {
        const string email = "engineer.private@example.com";
        const string bearer = "arch_dt_SUPERSECRETTOKEN0123456789";
        const string jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
        const string password = "hunter2hunter2";
        var hostile = $"{email} Bearer {bearer} {jwt} password={password} Authorization: Basic {bearer} token={bearer}";

        var sink = Sink();
        var fields = new List<DiagnosticField>();
        foreach (var name in DiagnosticFieldAllowList.Names)
        {
            fields.Add(DiagnosticField.Text(name, hostile));
            fields.Add(DiagnosticField.Code(name, hostile));
            fields.Add(DiagnosticField.Path(name, @"C:\Users\Someone\" + hostile));
            fields.Add(DiagnosticField.Id(name, hostile));
            fields.Add(DiagnosticField.Origin(name, $"https://{email}:{password}@plm.example.com/{bearer}"));
        }
        foreach (var forbidden in new[] { "email", "password", "authorization", "token", "bearer", "body", "request", "response", "fileContents", "name" })
        {
            fields.Add(DiagnosticField.Text(forbidden, hostile));
        }
        var attempt = DiagnosticsAttempt.Start(sink, "copydesign.apply", _time, fields.ToArray());
        attempt.Failed(new InvalidOperationException(hostile), fields.ToArray());

        var bytes = ReadShared(Path.Combine(LogDir, LogFiles().Single()));
        foreach (var secret in new[] { email, bearer, jwt, password, "eyJhbGciOiJIUzI1NiJ9", "Someone" })
        {
            Assert.DoesNotContain(secret, bytes);
        }
    }

    [Fact]
    public void An_account_email_and_the_bearer_never_appear_even_from_a_real_session()
    {
        var sink = Sink();
        var plan = new Core.CopyDesign.CopyDesignPlan(@"D:\ws\ROOT.iam", Array.Empty<Core.CopyDesign.CopyDesignNode>(),
            Array.Empty<Core.CopyDesign.CopyDesignEdge>(), Array.Empty<string>(), true, true, true, false);

        var attempt = CopyDesignDiagnostics.Start(sink, "Apply", plan, "cadconnect-p6c-0123456789abcdef0123456789abcdef",
            new SecretBearingSession(), "fp-1");
        attempt.Succeeded();

        var text = ReadShared(Path.Combine(LogDir, LogFiles().Single()));
        Assert.DoesNotContain(SecretBearingSession.Email, text);
        Assert.DoesNotContain("SUPERSECRETTOKEN", text);
        Assert.DoesNotContain("Private Name", text);
        Assert.Contains("\"userId\":\"user-123\"", text);           // the internal id is allowed
        Assert.Contains("\"serverOrigin\":\"http://localhost:3100\"", text);
    }

    // ---- rotation and retention ----------------------------------------------------

    [Fact]
    public void The_default_limits_are_1_MB_per_file_50_files_and_20_MB_total()
    {
        Assert.Equal(1L * 1024 * 1024, DiagnosticsRetention.Default.MaxFileBytes);
        Assert.Equal(50, DiagnosticsRetention.Default.MaxFiles);
        Assert.Equal(20L * 1024 * 1024, DiagnosticsRetention.Default.MaxTotalBytes);
    }

    [Fact]
    public void A_file_rolls_over_to_a_new_part_at_the_size_limit()
    {
        var sink = Sink(new DiagnosticsRetention(MaxFileBytes: 400, MaxFiles: 50, MaxTotalBytes: 1_000_000));
        var attempt = DiagnosticsAttempt.Start(sink, "copydesign.apply", _time);
        for (var i = 0; i < 10; i++)
        {
            attempt.Step("materialize", DiagnosticField.Path("path", @"D:\" + new string('r', 100)));
        }

        var files = LogFiles();
        Assert.True(files.Length > 1, "expected part files");
        Assert.Contains(files, f => f.EndsWith("_p2.jsonl", StringComparison.Ordinal));
        Assert.All(files, f => Assert.True(new FileInfo(Path.Combine(LogDir, f)).Length <= 400, f));
        Assert.Equal(11, files.SelectMany(f => Lines(Path.Combine(LogDir, f))).Count());
    }

    [Fact]
    public void The_oldest_own_files_are_deleted_beyond_the_file_count_limit()
    {
        var sink = Sink(new DiagnosticsRetention(MaxFileBytes: 10_000, MaxFiles: 3, MaxTotalBytes: 1_000_000));
        var ids = new List<string>();
        for (var i = 0; i < 6; i++)
        {
            _time.Now = _time.Now.AddMinutes(1);
            var a = DiagnosticsAttempt.Start(sink, "pdm.checkout", _time);
            a.Succeeded();
            ids.Add(a.AttemptId);
        }

        var files = LogFiles();
        Assert.Equal(3, files.Length);
        Assert.All(ids.Skip(3), id => Assert.Contains(files, f => f.Contains(id)));   // the newest three survive
    }

    [Fact]
    public void The_oldest_own_files_are_deleted_to_stay_within_the_total_size_limit()
    {
        var sink = Sink(new DiagnosticsRetention(MaxFileBytes: 1_000, MaxFiles: 50, MaxTotalBytes: 3_000));
        for (var i = 0; i < 8; i++)
        {
            _time.Now = _time.Now.AddMinutes(1);
            var a = DiagnosticsAttempt.Start(sink, "pdm.checkout", _time, DiagnosticField.Path("path", @"D:\" + new string('x', 390)));
            a.Succeeded(DiagnosticField.Path("recoveryPath", @"D:\" + new string('y', 390)));
        }

        var total = LogFiles().Sum(f => new FileInfo(Path.Combine(LogDir, f)).Length);
        Assert.True(total <= 3_000, $"total {total}");
        Assert.True(LogFiles().Length >= 1);
    }

    [Fact]
    public void Retention_never_touches_files_that_are_not_its_own()
    {
        Directory.CreateDirectory(LogDir);
        var foreign = new[] { "notes.txt", "other.jsonl", "20261028T120000Z_x_notanid.jsonl", "README" };
        foreach (var f in foreign) File.WriteAllText(Path.Combine(LogDir, f), new string('z', 5_000));
        var sink = Sink(new DiagnosticsRetention(MaxFileBytes: 1_000, MaxFiles: 2, MaxTotalBytes: 2_000));

        for (var i = 0; i < 5; i++)
        {
            _time.Now = _time.Now.AddMinutes(1);
            DiagnosticsAttempt.Start(sink, "pdm.checkout", _time).Succeeded();
        }

        Assert.All(foreign, f => Assert.True(File.Exists(Path.Combine(LogDir, f)), f));
    }

    [Fact]
    public void A_file_still_being_written_is_never_deleted_by_retention()
    {
        var sink = Sink(new DiagnosticsRetention(MaxFileBytes: 10_000, MaxFiles: 2, MaxTotalBytes: 1_000_000));
        var running = DiagnosticsAttempt.Start(sink, "copydesign.apply", _time);   // oldest, still open
        for (var i = 0; i < 4; i++)
        {
            _time.Now = _time.Now.AddMinutes(1);
            DiagnosticsAttempt.Start(sink, "pdm.checkout", _time).Succeeded();
        }
        running.Step("models.copy");

        Assert.Contains(LogFiles(), f => f.Contains(running.AttemptId));
        Assert.Equal(2, Lines(Path.Combine(LogDir, LogFiles().Single(f => f.Contains(running.AttemptId)))).Length);
    }

    // ---- failure isolation -------------------------------------------------------

    [Fact]
    public void An_unusable_log_folder_never_throws_and_is_counted()
    {
        var blocker = Path.Combine(_root, "blocker");
        File.WriteAllText(blocker, "a file where the folder should be");
        var sink = new JsonLinesDiagnosticsSink(Path.Combine(blocker, "logs"));

        var attempt = DiagnosticsAttempt.Start(sink, "pdm.checkout", _time);
        attempt.Succeeded();

        Assert.Equal(2, sink.FailureCount);
    }

    [Fact]
    public void Writes_from_many_threads_are_all_kept()
    {
        var sink = Sink();
        var attempt = DiagnosticsAttempt.Start(sink, "copydesign.apply", _time);

        Parallel.For(0, 200, i => attempt.Step("materialize", DiagnosticField.Number("versionNumber", i)));

        var lines = Lines(Path.Combine(LogDir, LogFiles().Single()));
        Assert.Equal(201, lines.Length);
        Assert.Equal(Enumerable.Range(1, 201), lines.Select(l => l.GetProperty("seq").GetInt32()).OrderBy(s => s));
        Assert.Equal(0, sink.FailureCount);
    }

    [Fact]
    public void The_default_folder_is_under_local_app_data()
    {
        Assert.EndsWith(Path.Combine("ArchEngineering", "CadConnect", "logs"), JsonLinesDiagnosticsSink.DefaultDirectory);
        Assert.StartsWith(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), JsonLinesDiagnosticsSink.DefaultDirectory);
    }

    // ---- cross-process ownership and retention ------------------------------------
    // A second sink on the same folder stands in for a second Inventor
    // process: OS file-sharing rules are per handle, and the retention lock is
    // a named kernel mutex, so both behave exactly as they would across
    // processes.

    [Fact]
    public void An_active_attempts_file_cannot_be_deleted_by_anyone_else()
    {
        var owner = Sink();
        var active = DiagnosticsAttempt.Start(owner, "copydesign.apply", _time);
        var path = Path.Combine(LogDir, LogFiles().Single());

        Assert.ThrowsAny<IOException>(() => File.Delete(path));          // the OS refuses
        Assert.True(File.Exists(path));
        Assert.Contains("\"started\"", ReadShared(path));                  // still readable

        active.Succeeded();
        File.Delete(path);                                                 // released once the attempt ends
        Assert.False(File.Exists(path));
        owner.Dispose();
    }

    [Fact]
    public void Another_writers_retention_never_deletes_a_file_this_writer_owns()
    {
        using var first = Sink();
        var running = DiagnosticsAttempt.Start(first, "copydesign.apply", _time);   // oldest file, still active

        using var second = Sink(new DiagnosticsRetention(MaxFileBytes: 10_000, MaxFiles: 2, MaxTotalBytes: 1_000_000));
        for (var i = 0; i < 6; i++)
        {
            _time.Now = _time.Now.AddMinutes(1);
            DiagnosticsAttempt.Start(second, "pdm.checkout", _time).Succeeded();
        }
        running.Step("models.copy");
        running.Succeeded();

        var mine = LogFiles().Single(f => f.Contains(running.AttemptId));
        Assert.Equal(3, Lines(Path.Combine(LogDir, mine)).Length);         // nothing lost
        Assert.Equal(0, first.FailureCount);
        Assert.Equal(0, second.FailureCount);
    }

    [Fact]
    public void A_finished_attempts_file_may_be_rotated_away_by_another_writer()
    {
        using var first = Sink();
        var done = DiagnosticsAttempt.Start(first, "pdm.checkout", _time);
        done.Succeeded();

        using var second = Sink(new DiagnosticsRetention(MaxFileBytes: 10_000, MaxFiles: 2, MaxTotalBytes: 1_000_000));
        for (var i = 0; i < 4; i++)
        {
            _time.Now = _time.Now.AddMinutes(1);
            DiagnosticsAttempt.Start(second, "pdm.checkout", _time).Succeeded();
        }

        Assert.DoesNotContain(LogFiles(), f => f.Contains(done.AttemptId));
        Assert.Equal(2, LogFiles().Length);
    }

    [Fact]
    public void Concurrent_writers_sharing_a_folder_lose_nothing_and_stay_within_the_limits()
    {
        var retention = new DiagnosticsRetention(MaxFileBytes: 50_000, MaxFiles: 10, MaxTotalBytes: 10_000_000);
        using var a = Sink(retention);
        using var b = Sink(retention);
        var failures = 0;
        var completed = new System.Collections.Concurrent.ConcurrentBag<string>();

        Parallel.For(0, 80, new ParallelOptions { MaxDegreeOfParallelism = 8 }, i =>
        {
            try
            {
                var attempt = DiagnosticsAttempt.Start(i % 2 == 0 ? a : b, "pdm.checkout", DiagnosticField.Number("versionNumber", i));
                for (var s = 0; s < 5; s++) attempt.Step("materialize", DiagnosticField.Number("versionNumber", s));
                attempt.Succeeded();
                completed.Add(attempt.AttemptId);
            }
            catch
            {
                Interlocked.Increment(ref failures);
            }
        });

        Assert.Equal(0, failures);
        Assert.Equal(80, completed.Count);
        Assert.Equal(0, a.FailureCount);
        Assert.Equal(0, b.FailureCount);
        var files = LogFiles();
        Assert.True(files.Length <= retention.MaxFiles, $"{files.Length} files");
        Assert.All(files, f =>
        {
            // every surviving file is a complete attempt: started, 5 steps, succeeded
            var outcomes = Lines(Path.Combine(LogDir, f)).Select(l => l.GetProperty("outcome").GetString()).ToArray();
            Assert.Equal(7, outcomes.Length);
            Assert.Equal("started", outcomes[0]);
            Assert.Equal("succeeded", outcomes[^1]);
        });
    }

    [Fact]
    public void Concurrent_active_attempts_in_two_writers_are_never_deleted_mid_write()
    {
        var retention = new DiagnosticsRetention(MaxFileBytes: 50_000, MaxFiles: 3, MaxTotalBytes: 10_000_000);
        using var a = Sink(retention);
        using var b = Sink(retention);
        var attempts = Enumerable.Range(0, 12)
            .Select(i => DiagnosticsAttempt.Start(i % 2 == 0 ? a : b, "copydesign.apply"))
            .ToArray();                                   // 12 active files, far beyond MaxFiles

        Parallel.ForEach(attempts, attempt =>
        {
            for (var s = 0; s < 10; s++) attempt.Step("materialize");
        });
        foreach (var attempt in attempts) attempt.Succeeded();

        foreach (var attempt in attempts)
        {
            var file = LogFiles().Single(f => f.Contains(attempt.AttemptId));
            Assert.Equal(12, Lines(Path.Combine(LogDir, file)).Length);
        }
    }

    [Fact]
    public void The_retention_lock_is_one_named_lock_per_folder()
    {
        var name = JsonLinesDiagnosticsSink.RetentionLockName(LogDir);

        Assert.StartsWith(@"Local\ArchCadConnect.DiagnosticsRetention.", name);
        Assert.Equal(name, JsonLinesDiagnosticsSink.RetentionLockName(LogDir.ToLowerInvariant() + "\\"));
        Assert.NotEqual(name, JsonLinesDiagnosticsSink.RetentionLockName(Path.Combine(_root, "other")));
    }

    [Fact]
    public void Retention_waits_for_another_holder_of_the_lock_and_never_runs_unlocked()
    {
        var retention = new DiagnosticsRetention(MaxFileBytes: 10_000, MaxFiles: 1, MaxTotalBytes: 1_000_000);
        using var sink = Sink(retention);
        DiagnosticsAttempt.Start(sink, "pdm.checkout", _time).Succeeded();
        var first = LogFiles().Single();

        using var other = new Mutex(initiallyOwned: false, JsonLinesDiagnosticsSink.RetentionLockName(LogDir));
        var held = new ManualResetEventSlim();
        var release = new ManualResetEventSlim();
        var holder = new Thread(() => { other.WaitOne(); held.Set(); release.Wait(); other.ReleaseMutex(); });
        holder.Start();
        held.Wait();

        _time.Now = _time.Now.AddMinutes(1);
        DiagnosticsAttempt.Start(sink, "pdm.checkout", _time).Succeeded();  // lock busy (2 s): writes, but skips retention

        Assert.Contains(first, LogFiles());          // not deleted while another process held the lock
        Assert.Equal(2, LogFiles().Length);
        release.Set();
        holder.Join();

        _time.Now = _time.Now.AddMinutes(1);
        DiagnosticsAttempt.Start(sink, "pdm.checkout", _time).Succeeded();  // lock free again: retention runs
        Assert.Single(LogFiles());
    }
}
