using System.Text.RegularExpressions;

namespace Arch.CadConnect.Core.Tests.CopyDesign;

/// <summary>
/// P6 METADATA FIX (P1 "temporary name in Part Number"): the Inventor-side
/// pieces are COM-only (<c>Arch.CadConnect.Inventor</c> has no test project -
/// see <c>InventorCopyDesignPhysicalCopierSourceGuardTests</c>), so their
/// safety invariants are locked in with the same SOURCE-LEVEL guard pattern:
/// normalization touches ONLY the final destination, saves ONLY on an exact
/// temp-stem replacement and ONLY without dependents, and both verifiers
/// snapshot iProperties from their own fresh open of the saved file.
/// </summary>
public class InventorCopyDesignMetadataNormalizerSourceGuardTests
{
    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "Arch.CadConnect.sln")))
        {
            dir = dir.Parent;
        }
        return dir?.FullName
            ?? throw new InvalidOperationException("Could not locate the repository root (Arch.CadConnect.sln) "
                + "above the test assembly - InventorCopyDesignMetadataNormalizerSourceGuardTests cannot run.");
    }

    private static string Source(params string[] relative) =>
        File.ReadAllText(Path.Combine(new[] { RepoRoot(), "src" }.Concat(relative).ToArray()));

    private static string Normalizer() => Source("Arch.CadConnect.Inventor", "CopyDesign", "InventorCopyDesignMetadataNormalizer.cs");
    private static string Reader() => Source("Arch.CadConnect.Inventor", "CopyDesign", "InventorCopyDesignPropertyReader.cs");
    private static string Copier() => Source("Arch.CadConnect.Inventor", "CopyDesign", "InventorCopyDesignPhysicalCopier.cs");
    private static string Controller() => Source("Arch.CadConnect.Inventor", "ArchAddInController.cs");

    /// <summary>Strips // line comments and /// doc comments so assertions
    ///  only ever match real code, never prose.</summary>
    private static string Code(string source) => Regex.Replace(source, @"//.*$", "", RegexOptions.Multiline);

    private static string MethodBody(string source, string declaration)
    {
        var start = source.IndexOf(declaration, StringComparison.Ordinal);
        Assert.True(start >= 0, $"\"{declaration}\" not found - source layout changed.");
        var end = source.IndexOf("\n    private ", start + declaration.Length, StringComparison.Ordinal);
        return end > start ? source[start..end] : source[start..];
    }

    // ---- normalizer: touches ONLY the final destination ----------------------

    [Fact]
    public void The_normalizer_opens_only_the_final_destination_never_the_source_or_the_temp_file()
    {
        var code = Code(Normalizer());

        Assert.Single(Regex.Matches(code, @"Documents\.Open\("));
        Assert.Contains("Documents.Open(destination, OpenVisible: false)", code, StringComparison.Ordinal);
        Assert.DoesNotContain("Open(node.SourceAbsolutePath", code, StringComparison.Ordinal);
        Assert.DoesNotContain("Open(promotedFromTempFileName", code, StringComparison.Ordinal);
    }

    [Fact]
    public void The_normalizer_refuses_a_destination_equal_to_the_source_and_a_document_that_is_not_the_destination()
    {
        var code = Code(Normalizer());

        Assert.Contains("PathsEqual(destination, node.SourceAbsolutePath)", code, StringComparison.Ordinal);
        Assert.Contains("!PathsEqual(document.FullFileName, destination)", code, StringComparison.Ordinal);
    }

    [Fact]
    public void The_normalizer_saves_ONLY_via_Save2_without_dependents_and_never_any_other_save()
    {
        var code = Code(Normalizer());

        Assert.Single(Regex.Matches(code, @"\.Save2\("));
        Assert.Contains("document.Save2(SaveDependents: false, DocumentsToSave: Type.Missing)", code, StringComparison.Ordinal);
        Assert.DoesNotContain(".Save()", code, StringComparison.Ordinal);
        Assert.DoesNotContain("SaveAs", code, StringComparison.Ordinal);
        Assert.DoesNotContain("SaveDependents: true", code, StringComparison.Ordinal);
    }

    [Fact]
    public void The_only_write_and_save_happen_inside_the_Replace_branch_decided_by_the_pure_policy()
    {
        var code = Code(Normalizer());

        var decide = code.IndexOf("CopyDesignPartNumberPolicy.Decide(", StringComparison.Ordinal);
        var replace = code.IndexOf("case CopyDesignPartNumberDecisionKind.Replace:", StringComparison.Ordinal);
        var keep = code.IndexOf("case CopyDesignPartNumberDecisionKind.Keep:", StringComparison.Ordinal);
        var write = code.IndexOf("partNumber.Value = decision.NewPartNumber!", StringComparison.Ordinal);
        var save = code.IndexOf("document.Save2(", StringComparison.Ordinal);

        Assert.True(decide >= 0 && replace > decide && keep > replace, "Decide/Replace/Keep structure not found.");
        Assert.True(write > replace && write < keep, "The Part Number write must be inside the Replace branch only.");
        Assert.True(save > write && save < keep, "Save2 must follow the write, inside the Replace branch only.");
        Assert.Single(Regex.Matches(code, @"\.Value\s*="));
    }

    [Fact]
    public void The_normalizer_always_closes_with_SkipSave_in_a_finally_block()
    {
        var code = Code(Normalizer());

        var finallyIndex = Regex.Match(code, @"finally\s*\r?\n\s*\{").Index;
        var closeIndex = code.IndexOf("document.Close(SkipSave: true)", StringComparison.Ordinal);
        Assert.True(finallyIndex > 0 && closeIndex > finallyIndex, "Close(SkipSave: true) must be inside the finally block.");
        Assert.DoesNotContain("SkipSave: false", code, StringComparison.Ordinal);
    }

    // ---- property reader: read-only, fails closed without Part Number --------

    [Fact]
    public void The_property_reader_never_writes_or_saves()
    {
        var code = Code(Reader());

        Assert.DoesNotContain("Save", code, StringComparison.Ordinal);
        Assert.Empty(Regex.Matches(code, @"\.Value\s*="));
    }

    [Fact]
    public void The_property_reader_fails_closed_when_the_Part_Number_was_not_read()
    {
        var code = Code(Reader());

        Assert.Contains("if (!partNumberRead)", code, StringComparison.Ordinal);
        Assert.Contains("\"Design Tracking Properties\"", code, StringComparison.Ordinal);
        Assert.Contains("\"Part Number\"", code, StringComparison.Ordinal);
    }

    // ---- copier: reports the temp name, still never saves ---------------------

    [Fact]
    public void The_copier_reports_the_promoted_temp_name_only_on_the_success_path_after_promotion()
    {
        var code = Code(Copier());

        var promote = code.IndexOf("CopyDesignAtomicPromotion.PromoteToFinal(tempPath, destination)", StringComparison.Ordinal);
        var success = code.IndexOf("new CopyDesignPhysicalCopyResult(true, null, PromotedFromTempFileName: Path.GetFileName(tempPath))", StringComparison.Ordinal);

        Assert.True(promote >= 0 && success > promote, "The temp name must be reported only after the final promotion.");
        Assert.Single(Regex.Matches(code, @"PromotedFromTempFileName"));
        Assert.DoesNotContain("Save2(", code, StringComparison.Ordinal);
    }

    // ---- verifiers: iProperties read from their own fresh open ----------------

    [Theory]
    [InlineData("InventorCopyDesignVerifier.cs")]
    [InlineData("InventorCopyDesignDrawingVerifier.cs")]
    public void Each_verifier_snapshots_iProperties_from_its_own_open_and_reports_them(string file)
    {
        var code = Code(Source("Arch.CadConnect.Inventor", "CopyDesign", file));

        var open = code.IndexOf("Documents.Open(destination, OpenVisible: false)", StringComparison.Ordinal);
        var gather = code.IndexOf("InventorCopyDesignPropertyReader.TryGatherStringProperties(document, stringProperties)", StringComparison.Ordinal);
        Assert.True(open >= 0 && gather > open, "iProperties must be read from the verifier's own fresh open.");
        Assert.Contains("StringProperties: stringProperties, PropertyEnumerationSucceeded: propertiesGathered", code, StringComparison.Ordinal);
        Assert.DoesNotContain("Save2(", code, StringComparison.Ordinal);
        Assert.DoesNotContain(".Save()", code, StringComparison.Ordinal);
    }

    // ---- wiring ------------------------------------------------------------------

    [Fact]
    public void The_apply_resume_and_recover_path_wires_the_real_normalizer()
    {
        var body = MethodBody(Controller(), "private void ExecuteCopyDesignAttempt(");

        Assert.Contains("metadataNormalizer: new Inventor.CopyDesign.InventorCopyDesignMetadataNormalizer(_application)", body, StringComparison.Ordinal);
    }

    [Fact]
    public void The_read_only_Verify_Copy_Design_flow_never_constructs_the_normalizer()
    {
        var controller = Controller();
        foreach (var declaration in new[]
                 {
                     "private void RunCopyDesignVerify()",
                     "private void ContinueCopyDesignVerify(",
                     "private void FinishCopyDesignVerify(",
                 })
        {
            Assert.DoesNotContain("InventorCopyDesignMetadataNormalizer", MethodBody(controller, declaration), StringComparison.Ordinal);
        }
    }
}
