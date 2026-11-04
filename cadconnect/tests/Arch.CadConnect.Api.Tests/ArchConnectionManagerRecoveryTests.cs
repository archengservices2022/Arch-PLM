using Arch.CadConnect.Api.Workspace;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Api.Tests;

/// <summary>P6 M4.4 Package C R9: through the whole connection manager, an
///  interrupted workspace and a wrong server or organization are refused before
///  the API is ever called, and no file changes.</summary>
public partial class ArchConnectionManagerTests
{
    private const string OperationId = "0123456789abcdef0123456789abcdef";

    private static void WriteManifest(string root, string origin, string? organization)
    {
        var path = Path.Combine(root, WorkspaceManifest.RelativeManifestPath);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var org = organization is null ? "" : $$""","organizationId":"{{organization}}" """;
        File.WriteAllText(path, $$"""{"schema":"{{WorkspaceManifest.SchemaId}}","serverOrigin":"{{origin}}"{{org}},"entries":[]}""");
    }

    private static string Interrupted(string root)
    {
        var manifest = Path.Combine(root, WorkspaceManifest.RelativeManifestPath);
        var previous = $"{manifest}.{OperationId}.previous";
        File.Move(manifest, previous);
        return previous;
    }

    private static GetLatestRequest GetLatestInto(string root) => new()
    {
        Root = CadDocumentLookup.ByNumber(documentNumber: "ARCH-TEST-001", documentType: "IPT"),
        WorkspaceRoot = root,
    };

    private static string[] FilesUnder(string root) => Directory
        .GetFiles(root, "*", new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = 0 })
        .Select(f => f + " " + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(f))))
        .OrderBy(s => s, StringComparer.Ordinal)
        .ToArray();

    [Theory]
    [InlineData(ProductionOrigin)]
    [InlineData(ScratchOrigin)]
    public async Task An_interrupted_workspace_of_server_A_is_refused_on_server_A_and_on_server_B(string signedInTo)
    {
        using var ws = new TempWorkspaces();
        var root = ws.Create("prod", ProductionOrigin);
        Interrupted(root);
        var before = FilesUnder(root);
        var (mgr, _, api) = await SignedInTo(signedInTo);

        var ex = await Assert.ThrowsAsync<ArchApiException>(() => mgr.GetLatestAsync(GetLatestInto(root)));

        Assert.Equal(ArchApiFailureKind.BadRequest, ex.Kind);
        Assert.Equal(before, FilesUnder(root));
        Assert.NotNull(api());
    }

    [Theory]
    [MemberData(nameof(DocumentCommands))]
    public async Task Document_commands_on_an_interrupted_workspace_are_refused_on_either_server(string command)
    {
        using var ws = new TempWorkspaces();
        var root = ws.Create("prod", ProductionOrigin);
        Interrupted(root);
        var before = FilesUnder(root);

        foreach (var origin in new[] { ProductionOrigin, ScratchOrigin })
        {
            var (mgr, _, _) = await SignedInTo(origin);

            await Assert.ThrowsAsync<ArchApiException>(() =>
                InvokeDocumentCommand(mgr, command, ManagedFileRef.Create(root, Path.Combine(root, "A.ipt"))));
        }

        Assert.Equal(before, FilesUnder(root));
    }

    [Fact]
    public async Task A_workspace_of_another_organization_is_refused_before_the_api()
    {
        using var ws = new TempWorkspaces();
        var root = ws.Create("other", serverOrigin: null);
        WriteManifest(root, ScratchOrigin, "org-of-someone-else");
        var before = FilesUnder(root);
        var (mgr, _, _) = await SignedInTo(ScratchOrigin);

        var ex = await Assert.ThrowsAsync<ArchApiException>(() => mgr.GetLatestAsync(GetLatestInto(root)));

        Assert.Equal(ArchApiFailureKind.BadRequest, ex.Kind);
        Assert.Contains("organization", ex.Message);
        Assert.Equal(before, FilesUnder(root));
    }

    [Theory]
    [MemberData(nameof(DocumentCommands))]
    public async Task Document_commands_on_a_workspace_of_another_organization_are_refused(string command)
    {
        using var ws = new TempWorkspaces();
        var root = ws.Create("other", serverOrigin: null);
        WriteManifest(root, ScratchOrigin, "org-of-someone-else");
        var (mgr, _, _) = await SignedInTo(ScratchOrigin);

        var ex = await Assert.ThrowsAsync<ArchApiException>(() =>
            InvokeDocumentCommand(mgr, command, ManagedFileRef.Create(root, Path.Combine(root, "A.ipt"))));

        Assert.Contains("organization", ex.Message);
    }

    [Fact]
    public async Task A_healthy_workspace_with_no_recorded_organization_still_reaches_the_api()
    {
        using var ws = new TempWorkspaces();
        var root = ws.Create("legacy", ScratchOrigin);
        var (mgr, _, _) = await SignedInTo(ScratchOrigin);

        var ex = await Assert.ThrowsAsync<ArchApiException>(() => mgr.GetLatestAsync(GetLatestInto(root)));

        Assert.NotEqual(ArchApiFailureKind.BadRequest, ex.Kind);
    }

    [Fact]
    public async Task A_workspace_of_the_same_organization_still_reaches_the_api()
    {
        using var ws = new TempWorkspaces();
        var root = ws.Create("same", serverOrigin: null);
        WriteManifest(root, ScratchOrigin, "org1");
        var (mgr, _, _) = await SignedInTo(ScratchOrigin);

        var ex = await Assert.ThrowsAsync<ArchApiException>(() => mgr.GetLatestAsync(GetLatestInto(root)));

        Assert.NotEqual(ArchApiFailureKind.BadRequest, ex.Kind);
    }
}
