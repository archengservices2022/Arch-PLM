using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

using Arch.CadConnect.Core.Documents;

namespace Arch.CadConnect.Core.Tests.Documents;

/// <summary>
/// P6 M4.4 Package C R3: the rules of the probe Get Latest uses, with the
/// exception types Inventor really raises. The Inventor adapter cannot be
/// compiled into a test project, so (like the other wiring tests) its source is
/// read to prove it hands everything to this scan and leaves Undo's probe alone.
/// </summary>
public class EditorDocumentScanTests
{
    private sealed record Doc(string? Name, IEnumerable<Doc>? References = null)
    {
        public Func<string?>? ReadName { get; init; }
        public Func<IEnumerable<Doc>>? ReadReferences { get; init; }
    }

    private const string Target = @"C:\ws\part.ipt";

    private static EditorDocumentState Scan(params Doc[] documents) => Scan(() => documents);

    private static EditorDocumentState Scan(Func<IEnumerable<Doc>> documents, string? path = Target) =>
        EditorDocumentScan.Inspect(
            path,
            documents,
            d => d.ReadName is { } read ? read() : d.Name,
            d => d.ReadReferences is { } read ? read() : d.References ?? []);

    private static Doc Named(string name) => new(name);

    private static IEnumerable<Doc> ThrowingAfter(Exception failure, params Doc[] first)
    {
        foreach (var doc in first)
        {
            yield return doc;
        }
        throw failure;
    }

    public static TheoryData<Exception> InventorFailures => new()
    {
        new COMException("RPC_E_CALL_REJECTED", unchecked((int)0x80010001)),
        new COMException("RPC_S_SERVER_UNAVAILABLE", unchecked((int)0x800706BA)),
        new InvalidComObjectException("the object was released"),
        new InvalidCastException("not a Document"),
        new ArgumentException("a bad path"),
        new NullReferenceException(),
    };

    [Fact]
    public void Nothing_open_is_closed() => Assert.Equal(EditorDocumentState.Closed, Scan());

    [Fact]
    public void Other_documents_open_is_closed() =>
        Assert.Equal(EditorDocumentState.Closed, Scan(Named(@"C:\ws\other.ipt"), new Doc(@"C:\ws\a.iam", [Named(@"C:\ws\b.ipt")])));

    [Fact]
    public void A_never_saved_document_cannot_match_a_file_and_is_no_failure() =>
        Assert.Equal(EditorDocumentState.Closed, Scan(new Doc(""), new Doc(null)));

    [Fact]
    public void The_document_open_at_top_level_is_open() => Assert.Equal(EditorDocumentState.Open, Scan(Named(Target)));

    [Fact]
    public void The_match_ignores_case() => Assert.Equal(EditorDocumentState.Open, Scan(Named(Target.ToUpperInvariant())));

    [Fact]
    public void A_document_referenced_by_an_open_assembly_is_open() =>
        Assert.Equal(EditorDocumentState.Open, Scan(new Doc(@"C:\ws\a.iam", [Named(Target)])));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("C:\\bad\0path.ipt")]
    public void A_path_that_cannot_be_read_is_unknown(string? path) =>
        Assert.Equal(EditorDocumentState.Unknown, Scan(() => [], path));

    [Theory]
    [MemberData(nameof(InventorFailures))]
    public void The_document_list_failing_is_unknown(Exception failure) =>
        Assert.Equal(EditorDocumentState.Unknown, Scan(() => throw failure));

    [Theory]
    [MemberData(nameof(InventorFailures))]
    public void The_document_list_failing_part_way_is_unknown(Exception failure) =>
        Assert.Equal(EditorDocumentState.Unknown, Scan(() => ThrowingAfter(failure, Named(@"C:\ws\other.ipt"))));

    [Theory]
    [MemberData(nameof(InventorFailures))]
    public void A_document_whose_path_cannot_be_read_is_unknown_never_closed(Exception failure) =>
        Assert.Equal(EditorDocumentState.Unknown, Scan(new Doc(null) { ReadName = () => throw failure }));

    [Theory]
    [MemberData(nameof(InventorFailures))]
    public void References_that_cannot_be_read_are_unknown_never_closed(Exception failure) =>
        Assert.Equal(EditorDocumentState.Unknown, Scan(new Doc(@"C:\ws\a.iam") { ReadReferences = () => throw failure }));

    [Theory]
    [MemberData(nameof(InventorFailures))]
    public void References_failing_part_way_are_unknown_never_closed(Exception failure) =>
        Assert.Equal(EditorDocumentState.Unknown, Scan(new Doc(@"C:\ws\a.iam") { ReadReferences = () => ThrowingAfter(failure, Named(@"C:\ws\b.ipt")) }));

    [Theory]
    [MemberData(nameof(InventorFailures))]
    public void A_referenced_document_whose_path_cannot_be_read_is_unknown_never_closed(Exception failure) =>
        Assert.Equal(EditorDocumentState.Unknown, Scan(new Doc(@"C:\ws\a.iam", [new Doc(null) { ReadName = () => throw failure }])));

    [Fact]
    public void A_match_after_a_failure_is_still_open()
    {
        var unreadable = new Doc(null) { ReadName = () => throw new COMException() };

        Assert.Equal(EditorDocumentState.Open, Scan(unreadable, Named(Target)));
    }

    [Fact]
    public void Every_document_is_looked_at_after_a_failure()
    {
        var unreadable = new Doc(@"C:\ws\a.iam") { ReadReferences = () => throw new COMException() };

        Assert.Equal(EditorDocumentState.Open, Scan(unreadable, new Doc(@"C:\ws\b.iam", [Named(Target)])));
    }

    [Fact]
    public void No_editor_is_closed() =>
        Assert.Equal(EditorDocumentState.Closed, NoEditorProbe.Instance.GetDocumentState(Target));

    // ---- the Inventor adapter ------------------------------------------------

    private static string RepoRoot([CallerFilePath] string here = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(here)!, "..", "..", ".."));

    private static string Source(params string[] relativePath) =>
        File.ReadAllText(Path.Combine([RepoRoot(), "src", .. relativePath]));

    private static string Probe() => Source("Arch.CadConnect.Inventor", "Documents", "InventorEditorDocumentProbe.cs");

    [Fact]
    public void The_Inventor_probe_answers_state_through_the_scan_and_catches_nothing_itself()
    {
        var probe = Probe();
        var start = probe.IndexOf("public EditorDocumentState GetDocumentState", StringComparison.Ordinal);
        var end = probe.IndexOf("public bool IsOpenForEditing", StringComparison.Ordinal);
        Assert.True(start >= 0 && end > start);
        var strict = probe[start..end];

        Assert.Contains("EditorDocumentScan.Inspect", strict);
        Assert.DoesNotContain("catch", strict);
        Assert.Contains("application.Documents", strict);
        Assert.Contains("document.FullFileName", strict);
        Assert.Contains("document.ReferencedDocuments", strict);
    }

    [Fact]
    public void Undo_keeps_its_own_probe_with_its_own_rules()
    {
        var probe = Probe();
        var legacy = probe[probe.IndexOf("public bool IsOpenForEditing", StringComparison.Ordinal)..];
        Assert.DoesNotContain("EditorDocumentScan", legacy);
        Assert.Contains("private static bool PathMatches", legacy);

        var orchestrator = Source("Arch.CadConnect.Api", "Workspace", "CheckoutOrchestrator.cs");
        Assert.Contains("_editorProbe.IsOpenForEditing(absoluteFilePath)", orchestrator);
        Assert.DoesNotContain("GetDocumentState", orchestrator);
    }

    [Fact]
    public void Get_Latest_uses_only_the_state_probe()
    {
        var materializer = Source("Arch.CadConnect.Api", "Workspace", "WorkspaceMaterializer.cs");
        Assert.Contains("_editorProbe.GetDocumentState(absolutePath) == EditorDocumentState.Closed", materializer);
        Assert.DoesNotContain("IsOpenForEditing", materializer);
        Assert.Contains("_options.EditorProbe as Core.Documents.IEditorDocumentStateProbe", Source("Arch.CadConnect.Api", "ArchApiClient.cs"));
    }
}
