using Arch.CadConnect.Core.Session;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Core.Tests.Workspace;

/// <summary>
/// P6 M4.1 SERVER-ORIGIN GUARD: a document-scoped command may run only when
/// the workspace's recorded <c>serverOrigin</c> is EXACTLY the connected
/// server's origin. Everything else - including every way the manifest can be
/// missing, unreadable or ambiguous - is a refusal (fail closed). Uses real
/// temp workspace folders; nothing outside them is touched.
/// </summary>
public sealed class WorkspaceServerBindingTests : IDisposable
{
    private const string Production = "http://localhost:3000";
    private const string Scratch = "http://localhost:3100";

    private readonly string _root = Path.Combine(Path.GetTempPath(), "arch-m41-" + Guid.NewGuid().ToString("N"));

    public WorkspaceServerBindingTests() => Directory.CreateDirectory(_root);

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private static ArchServerUri Server(string origin) => ArchServerUri.Parse(origin);

    private string Workspace(string name, string? manifestJson)
    {
        var root = Path.Combine(_root, name);
        Directory.CreateDirectory(root);
        if (manifestJson is not null)
        {
            var path = Path.Combine(root, WorkspaceManifest.RelativeManifestPath);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, manifestJson);
        }
        return root;
    }

    private string WorkspaceOf(string origin, string name = "ws") =>
        Workspace(name, $$"""{"schema":"{{WorkspaceManifest.SchemaId}}","serverOrigin":"{{origin}}","entries":[]}""");

    // ---- Evaluate (pure) ------------------------------------------------

    [Fact]
    public void Evaluate_allows_only_an_exact_origin_match()
    {
        var result = WorkspaceServerBinding.Evaluate(Production, Server(Production), @"C:\ws");

        Assert.True(result.Allowed);
        Assert.Equal(WorkspaceServerBindingVerdict.Allowed, result.Verdict);
        Assert.Equal(Production, result.WorkspaceServerOrigin);
        Assert.Equal(Production, result.ConnectedServerOrigin);
    }

    [Fact]
    public void Evaluate_ignores_case_and_a_trailing_slash_or_path_in_the_recorded_origin()
    {
        Assert.True(WorkspaceServerBinding.Evaluate("HTTP://LOCALHOST:3000/", Server(Production), @"C:\ws").Allowed);
        Assert.True(WorkspaceServerBinding.Evaluate("https://PLM.example.com", Server("https://plm.example.com"), @"C:\ws").Allowed);
    }

    [Theory]
    [InlineData(Production, Scratch)]                               // the live M3 defect: production workspace, scratch session
    [InlineData(Scratch, Production)]                               // ... and the reverse
    [InlineData("http://localhost:3000", "http://127.0.0.1:3000")]  // aliases are NOT equated
    [InlineData("https://plm.example.com", "https://plm2.example.com")]
    [InlineData("https://plm.example.com", "https://plm.example.com:8443")]
    [InlineData("http://localhost:3000", "https://localhost:3000")]
    public void Evaluate_refuses_any_different_server(string recorded, string connected)
    {
        var result = WorkspaceServerBinding.Evaluate(recorded, Server(connected), @"C:\ws");

        Assert.False(result.Allowed);
        Assert.Equal(WorkspaceServerBindingVerdict.DifferentServer, result.Verdict);
        Assert.Contains("Nothing was sent to the server", result.Message);
        Assert.Contains(Server(connected).OriginString, result.Message);
    }

    [Fact]
    public void Evaluate_refuses_when_not_signed_in()
    {
        var result = WorkspaceServerBinding.Evaluate(Production, null, @"C:\ws");

        Assert.Equal(WorkspaceServerBindingVerdict.NotSignedIn, result.Verdict);
        Assert.False(result.Allowed);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Evaluate_refuses_a_workspace_with_no_recorded_server(string? recorded)
    {
        Assert.Equal(WorkspaceServerBindingVerdict.NoRecordedServer,
            WorkspaceServerBinding.Evaluate(recorded, Server(Production), @"C:\ws").Verdict);
    }

    [Theory]
    [InlineData("not a url")]
    [InlineData("ftp://localhost:3000")]
    [InlineData("http://plm.example.com")]  // plain http is only valid for loopback
    public void Evaluate_refuses_an_invalid_recorded_server(string recorded)
    {
        Assert.Equal(WorkspaceServerBindingVerdict.InvalidRecordedServer,
            WorkspaceServerBinding.Evaluate(recorded, Server(Production), @"C:\ws").Verdict);
    }

    // ---- CheckWorkspace (reads the manifest) ----------------------------

    [Fact]
    public void CheckWorkspace_allows_a_workspace_of_the_connected_server()
    {
        var root = WorkspaceOf(Production);

        var result = WorkspaceServerBinding.CheckWorkspace(root, Server(Production));

        Assert.True(result.Allowed);
        Assert.Equal(root, result.WorkspaceRoot);
    }

    [Fact]
    public void CheckWorkspace_refuses_a_production_workspace_while_signed_in_to_scratch_and_vice_versa()
    {
        var production = WorkspaceOf(Production, "prod");
        var scratch = WorkspaceOf(Scratch, "scratch");

        Assert.Equal(WorkspaceServerBindingVerdict.DifferentServer,
            WorkspaceServerBinding.CheckWorkspace(production, Server(Scratch)).Verdict);
        Assert.Equal(WorkspaceServerBindingVerdict.DifferentServer,
            WorkspaceServerBinding.CheckWorkspace(scratch, Server(Production)).Verdict);
        Assert.True(WorkspaceServerBinding.CheckWorkspace(production, Server(Production)).Allowed);
        Assert.True(WorkspaceServerBinding.CheckWorkspace(scratch, Server(Scratch)).Allowed);
    }

    [Fact]
    public void CheckWorkspace_refuses_when_not_signed_in_even_for_a_valid_workspace()
    {
        Assert.Equal(WorkspaceServerBindingVerdict.NotSignedIn,
            WorkspaceServerBinding.CheckWorkspace(WorkspaceOf(Production), null).Verdict);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("relative\\folder")]
    public void CheckWorkspace_refuses_a_missing_or_relative_root(string? root)
    {
        Assert.Equal(WorkspaceServerBindingVerdict.NoWorkspace,
            WorkspaceServerBinding.CheckWorkspace(root, Server(Production)).Verdict);
    }

    [Fact]
    public void CheckWorkspace_refuses_a_folder_without_a_manifest()
    {
        Assert.Equal(WorkspaceServerBindingVerdict.NoWorkspace,
            WorkspaceServerBinding.CheckWorkspace(Workspace("plain", null), Server(Production)).Verdict);
    }

    [Theory]
    [InlineData("{ this is not json")]
    [InlineData("")]
    [InlineData("[]")]
    [InlineData("{\"serverOrigin\":\"http://localhost:3000\",\"entries\":[]}")]                               // no schema
    [InlineData("{\"schema\":\"arch-plm.workspace-manifest.v0\",\"serverOrigin\":\"http://localhost:3000\"}")] // wrong schema
    [InlineData("{\"schema\":42,\"serverOrigin\":\"http://localhost:3000\"}")]
    public void CheckWorkspace_refuses_an_unreadable_or_foreign_manifest(string json)
    {
        Assert.Equal(WorkspaceServerBindingVerdict.ManifestUnreadable,
            WorkspaceServerBinding.CheckWorkspace(Workspace("bad", json), Server(Production)).Verdict);
    }

    [Theory]
    [InlineData("{\"schema\":\"%S\",\"entries\":[]}")]
    [InlineData("{\"schema\":\"%S\",\"serverOrigin\":\"\",\"entries\":[]}")]
    [InlineData("{\"schema\":\"%S\",\"serverOrigin\":null,\"entries\":[]}")]
    [InlineData("{\"schema\":\"%S\",\"serverOrigin\":3000,\"entries\":[]}")]
    public void CheckWorkspace_refuses_a_manifest_with_no_usable_recorded_server(string template)
    {
        var root = Workspace("noorigin", template.Replace("%S", WorkspaceManifest.SchemaId));

        Assert.Equal(WorkspaceServerBindingVerdict.NoRecordedServer,
            WorkspaceServerBinding.CheckWorkspace(root, Server(Production)).Verdict);
    }

    [Fact]
    public void CheckWorkspace_refuses_a_manifest_with_an_invalid_recorded_server()
    {
        Assert.Equal(WorkspaceServerBindingVerdict.InvalidRecordedServer,
            WorkspaceServerBinding.CheckWorkspace(WorkspaceOf("not a url"), Server(Production)).Verdict);
    }

    [Fact]
    public void CheckWorkspace_reads_a_manifest_written_by_the_real_WorkspaceManifest_type()
    {
        // The guard parses the file independently - prove it agrees with the
        // shape the production writer emits (camelCase "serverOrigin").
        var root = Workspace("written", null);
        var manifest = WorkspaceManifest.LoadOrEmpty(root);
        var json = $$"""{"schema":"{{WorkspaceManifest.SchemaId}}","serverOrigin":"{{Scratch}}","entries":[]}""";
        Directory.CreateDirectory(Path.GetDirectoryName(manifest.ManifestFilePath)!);
        File.WriteAllText(manifest.ManifestFilePath, json);

        Assert.True(WorkspaceServerBinding.CheckWorkspace(root, Server(Scratch)).Allowed);
        Assert.False(WorkspaceServerBinding.CheckWorkspace(root, Server(Production)).Allowed);
    }

    // ---- CheckGetLatestTarget -------------------------------------------

    [Fact]
    public void GetLatestTarget_allows_a_new_folder_with_no_manifest()
    {
        Assert.True(WorkspaceServerBinding.CheckGetLatestTarget(Workspace("new", null), Server(Scratch)).Allowed);
        Assert.True(WorkspaceServerBinding.CheckGetLatestTarget(Path.Combine(_root, "does-not-exist-yet"), Server(Scratch)).Allowed);
    }

    [Fact]
    public void GetLatestTarget_allows_refreshing_a_workspace_from_its_own_server()
    {
        Assert.True(WorkspaceServerBinding.CheckGetLatestTarget(WorkspaceOf(Scratch), Server(Scratch)).Allowed);
    }

    [Fact]
    public void GetLatestTarget_refuses_rebinding_a_workspace_of_another_server()
    {
        Assert.Equal(WorkspaceServerBindingVerdict.DifferentServer,
            WorkspaceServerBinding.CheckGetLatestTarget(WorkspaceOf(Production), Server(Scratch)).Verdict);
    }

    [Fact]
    public void GetLatestTarget_refuses_a_folder_whose_existing_manifest_is_unreadable()
    {
        Assert.Equal(WorkspaceServerBindingVerdict.ManifestUnreadable,
            WorkspaceServerBinding.CheckGetLatestTarget(Workspace("corrupt", "{oops"), Server(Scratch)).Verdict);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("relative")]
    public void GetLatestTarget_refuses_a_missing_or_relative_folder(string? root)
    {
        Assert.Equal(WorkspaceServerBindingVerdict.NoWorkspace,
            WorkspaceServerBinding.CheckGetLatestTarget(root, Server(Scratch)).Verdict);
    }

    [Fact]
    public void GetLatestTarget_refuses_when_not_signed_in()
    {
        Assert.Equal(WorkspaceServerBindingVerdict.NotSignedIn,
            WorkspaceServerBinding.CheckGetLatestTarget(Workspace("new2", null), null).Verdict);
    }

    // ---- AdmitGetLatestTarget (M4.1 T4 finding) -------------------------
    // A refused Get Latest target must never be remembered as the last
    // workspace folder. The settings file here is a temp stand-in for
    // %APPDATA%\...\connect.json, rewritten the same way ConnectSettings does
    // (load, change LastWorkspaceRoot, re-serialize indented).

    private const string OriginalSettings =
        "{\n  \"ServerAddress\": \"http://localhost:3100\",\n  \"LastEmail\": \"user@example.com\",\n"
        + "  \"LastWorkspaceRoot\": \"D:\\\\Previous\\\\Workspace\",\n  \"LastCopyDesignDestinationFolder\": null\n}";

    private string SettingsFile()
    {
        var path = Path.Combine(_root, "connect.json");
        File.WriteAllText(path, OriginalSettings);
        return path;
    }

    private static Action<string> RememberIn(string settingsFile, List<string> remembered) => folder =>
    {
        remembered.Add(folder);
        var node = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(settingsFile))!;
        node["LastWorkspaceRoot"] = folder;
        File.WriteAllText(settingsFile, node.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
    };

    public static TheoryData<string> RefusedTargets => new()
    {
        "other-server",      // the live T4 case: production workspace, scratch session
        "unreadable",
        "relative",
        "not-signed-in",
    };

    [Theory]
    [MemberData(nameof(RefusedTargets))]
    public void AdmitGetLatestTarget_never_remembers_a_refused_folder_and_leaves_the_settings_file_byte_identical(string kind)
    {
        var settings = SettingsFile();
        var before = File.ReadAllBytes(settings);
        var remembered = new List<string>();
        var (root, server) = kind switch
        {
            "other-server" => (WorkspaceOf(Production, "prod-ws"), Server(Scratch)),
            "unreadable" => (Workspace("corrupt-ws", "{oops"), Server(Scratch)),
            "relative" => ("relative\\folder", Server(Scratch)),
            _ => (Workspace("new-ws", null), (ArchServerUri?)null),
        };

        var result = WorkspaceServerBinding.AdmitGetLatestTarget(root, server, RememberIn(settings, remembered));

        Assert.False(result.Allowed);
        Assert.Empty(remembered);
        Assert.Equal(before, File.ReadAllBytes(settings));
    }

    [Fact]
    public void AdmitGetLatestTarget_refuses_the_T4_fixture_shape_with_the_wrong_server_message()
    {
        var settings = SettingsFile();
        var before = File.ReadAllBytes(settings);
        var root = WorkspaceOf(Production, "M41-ProdOrigin");

        var result = WorkspaceServerBinding.AdmitGetLatestTarget(root, Server(Scratch), RememberIn(settings, []));

        Assert.Equal(WorkspaceServerBindingVerdict.DifferentServer, result.Verdict);
        Assert.Contains("belongs to http://localhost:3000", result.Message);
        Assert.Contains("signed in to http://localhost:3100", result.Message);
        Assert.Equal(before, File.ReadAllBytes(settings));
    }

    [Fact]
    public void AdmitGetLatestTarget_remembers_a_new_empty_folder_exactly_once()
    {
        var settings = SettingsFile();
        var remembered = new List<string>();
        var root = Workspace("brand-new", null);

        var result = WorkspaceServerBinding.AdmitGetLatestTarget(root, Server(Scratch), RememberIn(settings, remembered));

        Assert.True(result.Allowed);
        Assert.Equal([root], remembered);
        Assert.Equal(root, System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(settings))!["LastWorkspaceRoot"]!.GetValue<string>());
    }

    [Fact]
    public void AdmitGetLatestTarget_remembers_a_folder_not_created_yet()
    {
        var remembered = new List<string>();
        var root = Path.Combine(_root, "does-not-exist-yet");

        Assert.True(WorkspaceServerBinding.AdmitGetLatestTarget(root, Server(Scratch), remembered.Add).Allowed);
        Assert.Equal([root], remembered);
    }

    [Fact]
    public void AdmitGetLatestTarget_remembers_a_workspace_of_the_connected_server_and_keeps_the_other_settings()
    {
        var settings = SettingsFile();
        var remembered = new List<string>();
        var root = WorkspaceOf(Scratch, "scratch-ws");

        var result = WorkspaceServerBinding.AdmitGetLatestTarget(root, Server(Scratch), RememberIn(settings, remembered));

        Assert.True(result.Allowed);
        Assert.Equal([root], remembered);
        var node = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(settings))!;
        Assert.Equal(root, node["LastWorkspaceRoot"]!.GetValue<string>());
        Assert.Equal("http://localhost:3100", node["ServerAddress"]!.GetValue<string>());
        Assert.Equal("user@example.com", node["LastEmail"]!.GetValue<string>());
    }

    [Fact]
    public void AdmitGetLatestTarget_returns_exactly_the_CheckGetLatestTarget_verdict()
    {
        foreach (var (root, server) in new[]
        {
            (WorkspaceOf(Production, "p"), Server(Scratch)),
            (WorkspaceOf(Scratch, "s"), Server(Scratch)),
            (Workspace("n", null), Server(Scratch)),
            (Workspace("c", "{oops"), Server(Scratch)),
        })
        {
            Assert.Equal(WorkspaceServerBinding.CheckGetLatestTarget(root, server),
                WorkspaceServerBinding.AdmitGetLatestTarget(root, server, _ => { }));
        }
    }

    [Fact]
    public void AdmitGetLatestTarget_requires_the_remember_callback()
    {
        Assert.Throws<ArgumentNullException>(() =>
            WorkspaceServerBinding.AdmitGetLatestTarget(Workspace("x", null), Server(Scratch), null!));
    }

    // ---- AdmitWorkspace (M4.1 T5 finding: Resume / Verify Copy Design) ---
    // The settings file is rewritten the way the Verify dialog's controller
    // callback does it (both remembered folders; Resume sets only the
    // destination - a subset of the same write).

    private static Action RememberCopyDesignFolders(string settingsFile, string source, string destination, List<string> calls) => () =>
    {
        calls.Add(source + " | " + destination);
        var node = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(settingsFile))!;
        node["LastWorkspaceRoot"] = source;
        node["LastCopyDesignDestinationFolder"] = destination;
        File.WriteAllText(settingsFile, node.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
    };

    private string ProductionWorkspaceWithEntry(string name)
    {
        // The T5 fixture shape: a real, non-empty production manifest (so the
        // controller's own "no managed entries" check passes and the guard is
        // what refuses it).
        var entries = """[{"relativePath":"ARCH-TEST-001.ipt","cadDocumentId":"cmvk29it20009n4cstyhw0a2o","state":"Verified"}]""";
        return Workspace(name, $$"""{"schema":"{{WorkspaceManifest.SchemaId}}","serverOrigin":"{{Production}}","entries":{{entries}}}""");
    }

    public static TheoryData<string> RefusedSourceWorkspaces => new()
    {
        "T5-fixture",        // production workspace with an entry, scratch session
        "other-server",
        "no-manifest",
        "unreadable",
        "no-recorded-server",
        "relative",
        "not-signed-in",
    };

    [Theory]
    [MemberData(nameof(RefusedSourceWorkspaces))]
    public void AdmitWorkspace_never_remembers_settings_for_a_refused_workspace_and_leaves_the_settings_file_byte_identical(string kind)
    {
        var settings = SettingsFile();
        var before = File.ReadAllBytes(settings);
        var calls = new List<string>();
        var (root, server) = kind switch
        {
            "T5-fixture" => (ProductionWorkspaceWithEntry("M41-ProdOrigin"), Server(Scratch)),
            "other-server" => (WorkspaceOf(Scratch, "scratch-ws"), Server(Production)),
            "no-manifest" => (Workspace("plain", null), Server(Scratch)),
            "unreadable" => (Workspace("corrupt", "{oops"), Server(Scratch)),
            "no-recorded-server" => (Workspace("noorigin", $$"""{"schema":"{{WorkspaceManifest.SchemaId}}","entries":[]}"""), Server(Scratch)),
            "relative" => ("relative\\folder", Server(Scratch)),
            _ => (WorkspaceOf(Scratch, "ws-nosession"), (ArchServerUri?)null),
        };

        var result = WorkspaceServerBinding.AdmitWorkspace(root, server,
            RememberCopyDesignFolders(settings, root, Path.Combine(_root, "Dest-T5-Verify"), calls));

        Assert.False(result.Allowed);
        Assert.Empty(calls);
        Assert.Equal(before, File.ReadAllBytes(settings));
    }

    [Fact]
    public void AdmitWorkspace_refuses_the_T5_fixture_with_the_wrong_server_message()
    {
        var root = ProductionWorkspaceWithEntry("M41-ProdOrigin");

        var result = WorkspaceServerBinding.AdmitWorkspace(root, Server(Scratch), () => throw new InvalidOperationException("must not remember"));

        Assert.Equal(WorkspaceServerBindingVerdict.DifferentServer, result.Verdict);
        Assert.Contains("belongs to http://localhost:3000", result.Message);
        Assert.Contains("signed in to http://localhost:3100", result.Message);
        Assert.Contains("Nothing was sent to the server", result.Message);
    }

    [Fact]
    public void AdmitWorkspace_remembers_settings_exactly_once_for_a_workspace_of_the_connected_server()
    {
        var settings = SettingsFile();
        var calls = new List<string>();
        var root = WorkspaceOf(Scratch, "scratch-source");
        var destination = Path.Combine(_root, "dest");

        var result = WorkspaceServerBinding.AdmitWorkspace(root, Server(Scratch),
            RememberCopyDesignFolders(settings, root, destination, calls));

        Assert.True(result.Allowed);
        Assert.Single(calls);
        var node = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(settings))!;
        Assert.Equal(root, node["LastWorkspaceRoot"]!.GetValue<string>());
        Assert.Equal(destination, node["LastCopyDesignDestinationFolder"]!.GetValue<string>());
        Assert.Equal("http://localhost:3100", node["ServerAddress"]!.GetValue<string>());
        Assert.Equal("user@example.com", node["LastEmail"]!.GetValue<string>());
    }

    [Fact]
    public void AdmitWorkspace_returns_exactly_the_CheckWorkspace_verdict()
    {
        foreach (var (root, server) in new[]
        {
            (ProductionWorkspaceWithEntry("p"), Server(Scratch)),
            (ProductionWorkspaceWithEntry("p2"), Server(Production)),
            (WorkspaceOf(Scratch, "s"), Server(Scratch)),
            (Workspace("n", null), Server(Scratch)),
            (Workspace("c", "{oops"), Server(Scratch)),
        })
        {
            Assert.Equal(WorkspaceServerBinding.CheckWorkspace(root, server),
                WorkspaceServerBinding.AdmitWorkspace(root, server, () => { }));
        }
    }

    [Fact]
    public void AdmitWorkspace_requires_the_remember_callback()
    {
        Assert.Throws<ArgumentNullException>(() =>
            WorkspaceServerBinding.AdmitWorkspace(WorkspaceOf(Scratch, "x"), Server(Scratch), null!));
    }
}
