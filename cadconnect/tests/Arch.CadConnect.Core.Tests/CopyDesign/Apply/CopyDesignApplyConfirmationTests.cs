using Arch.CadConnect.Core.CopyDesign;
using Arch.CadConnect.Core.CopyDesign.Apply;
using Arch.CadConnect.Core.References;

using static Arch.CadConnect.Core.Tests.CopyDesign.Apply.CopyDesignApplyFixtures;

namespace Arch.CadConnect.Core.Tests.CopyDesign.Apply;

/// <summary>
/// P6 Milestone 2: the Apply confirmation shows the EXACT mapping the
/// orchestrator executes (source/destination file, source/new document
/// number, action, folder, counts, every blocking error and warning), Apply
/// is disabled whenever anything blocks, and a plan that changed after
/// confirmation can never run under the old confirmation.
/// </summary>
public class CopyDesignApplyConfirmationTests
{
    private const string Source001 = @"D:\ArchPLM-Test\GetLatest\ARCH-TEST-001.ipt";
    private const string Dest003 = @"D:\ArchPLM-Test\CopyPreview\ARCH-TEST-003.ipt";

    private static readonly Func<string, bool> NothingExists = _ => false;

    private static CopyDesignNode LiveRoot(string destination = Dest003, string? sourceNumber = "ARCH-TEST-001.ipt") =>
        CopyNode("cmvk29it20009n4cstyhw0a2o", Source001, destination, isRoot: true, fileVersionId: "cmvk2b53f000dn4cs9g08i8qb")
            with { SourceDocumentNumber = sourceNumber };

    // ---- valid rename (the live ARCH-TEST-003 case) ------------------------

    [Fact]
    public void A_valid_rename_shows_the_exact_mapping_and_new_document_number_and_can_apply()
    {
        var confirmation = CopyDesignApplyConfirmationBuilder.Build(Plan(new[] { LiveRoot() }), NothingExists);

        Assert.True(confirmation.CanApply);
        Assert.Empty(confirmation.Blocking);
        var row = Assert.Single(confirmation.Rows);
        Assert.Equal(CopyDesignApplyEntryAction.Copy, row.Action);
        Assert.Equal(CadDocumentType.Ipt, row.DocumentType);
        Assert.Equal("ARCH-TEST-001.ipt", row.SourceFileName);
        Assert.Equal("ARCH-TEST-001.ipt", row.SourceDocumentNumber);
        Assert.Equal("ARCH-TEST-003.ipt", row.DestinationFileName);
        Assert.Equal("ARCH-TEST-003", row.DestinationDocumentNumber);
        Assert.Equal(@"D:\ArchPLM-Test\CopyPreview", row.DestinationFolder);
        Assert.Equal(new[] { @"D:\ArchPLM-Test\CopyPreview" }, confirmation.DestinationFolders);
        Assert.Equal(1, confirmation.CopyCount);
        Assert.Equal(0, confirmation.ReuseCount);
        Assert.NotNull(confirmation.Fingerprint);

        var text = CopyDesignApplyConfirmationTextReport.Render(confirmation);
        Assert.Contains("Status: READY TO APPLY", text, StringComparison.Ordinal);
        Assert.Contains("COPY  IPT  ARCH-TEST-001.ipt → ARCH-TEST-003.ipt", text, StringComparison.Ordinal);
        Assert.Contains("Source document number:  ARCH-TEST-001.ipt", text, StringComparison.Ordinal);
        Assert.Contains("New document number:     ARCH-TEST-003", text, StringComparison.Ordinal);
        Assert.Contains(@"Destination folder:      D:\ArchPLM-Test\CopyPreview", text, StringComparison.Ordinal);
        Assert.Contains("Files: 1 (1 COPY, 0 REUSE)", text, StringComparison.Ordinal);
        Assert.Contains("Blocking errors: (none)", text, StringComparison.Ordinal);
    }

    // ---- unmatched rename: the REAL planner output --------------------------

    [Fact]
    public void An_unmatched_rename_rule_blocks_Apply_and_the_blocking_reason_is_shown()
    {
        var scan = CopyDesignFixtures.Scan(
            CopyDesignFixtures.Root(Source001, "cad_root", "fv_root1", CadDocumentType.Ipt), Array.Empty<CadReference>());
        var plan = CopyDesignPlanner.Plan(scan, new TokenReplaceNameRule("arch-test-001", "ARCH-TEST-003"),
            @"D:\ArchPLM-Test\CopyPreview", drawingSource: AlwaysFoundEmpty.Instance);

        var confirmation = CopyDesignApplyConfirmationBuilder.Build(plan, NothingExists);

        Assert.False(plan.IsExecutable);
        Assert.False(confirmation.CanApply);
        Assert.Empty(confirmation.Rows);
        Assert.Null(confirmation.Fingerprint);
        Assert.Contains(confirmation.Blocking, i => i.Message.StartsWith(CopyDesignPlanner.UnmatchedRenameRuleReasonPrefix, StringComparison.Ordinal));
        // The informational root text is NOT mistaken for the blocking reason.
        Assert.Contains(confirmation.Issues, i => i.Severity == CopyDesignIssueSeverity.Info && i.Message.StartsWith("Selected root", StringComparison.Ordinal));
        Assert.Contains("Status: BLOCKED - Apply is disabled", CopyDesignApplyConfirmationTextReport.Render(confirmation), StringComparison.Ordinal);
    }

    // ---- same-name / same-number collisions ---------------------------------

    [Fact]
    public void A_COPY_that_keeps_the_source_file_name_is_blocked_even_in_another_folder()
    {
        var node = LiveRoot(destination: @"D:\ArchPLM-Test\CopyPreview\ARCH-TEST-001.ipt");

        var confirmation = CopyDesignApplyConfirmationBuilder.Build(Plan(new[] { node }), NothingExists);

        Assert.False(confirmation.CanApply);
        Assert.Contains(confirmation.Blocking, i => i.Message.Contains("unchanged from the source", StringComparison.Ordinal));
        // ...and its number "ARCH-TEST-001" canonically equals the source's "ARCH-TEST-001.ipt".
        Assert.Contains(confirmation.Blocking, i => i.Message.Contains("would collide with the source document", StringComparison.Ordinal));
    }

    [Fact]
    public void A_new_number_equal_to_the_source_number_ignoring_case_and_extension_is_blocked()
    {
        var node = CopyNode("cad-1", @"D:\src\PN-1-OLD.ipt", @"D:\dst\pn-1.ipt", isRoot: true) with { SourceDocumentNumber = "PN-1.IPT" };

        var confirmation = CopyDesignApplyConfirmationBuilder.Build(Plan(new[] { node }), NothingExists);

        Assert.False(confirmation.CanApply);
        Assert.Contains(confirmation.Blocking, i => i.Message.Contains("\"pn-1\" is the same as the source's \"PN-1.IPT\"", StringComparison.Ordinal));
    }

    [Fact]
    public void Two_COPY_entries_with_canonically_equal_numbers_are_blocked()
    {
        var a = CopyNode("cad-a", @"D:\src\A-OLD.ipt", @"D:\dst\one\A-1.ipt", isRoot: true);
        var b = CopyNode("cad-b", @"D:\src\B-OLD.ipt", @"D:\dst\two\a-1.ipt");

        var confirmation = CopyDesignApplyConfirmationBuilder.Build(Plan(new[] { a, b }), NothingExists);

        // The shared mapper already refuses this; the confirmation surfaces it as blocking.
        Assert.False(confirmation.CanApply);
        Assert.Contains(confirmation.Blocking, i => i.Message.Contains("could not be mapped", StringComparison.Ordinal)
            || i.Message.Contains("same IPT document number", StringComparison.Ordinal));
    }

    // ---- existing destination ----------------------------------------------

    [Fact]
    public void An_existing_destination_file_blocks_Apply()
    {
        var confirmation = CopyDesignApplyConfirmationBuilder.Build(
            Plan(new[] { LiveRoot() }), path => string.Equals(path, Dest003, StringComparison.OrdinalIgnoreCase));

        Assert.False(confirmation.CanApply);
        Assert.Contains(confirmation.Blocking, i => i.Message.Contains("already exists", StringComparison.Ordinal) && i.Message.Contains(Dest003, StringComparison.Ordinal));
    }

    // ---- multiple files, assembly, drawing, REUSE -----------------------------

    [Fact]
    public void A_multi_file_assembly_plan_lists_every_entry_in_execution_mapping_order_with_REUSE_preserved()
    {
        var reuse = ReuseNode("cad-std", @"D:\src\STD-BOLT.ipt") with { SourceDocumentNumber = "STD-BOLT" };
        var childA = CopyNode("cad-a", @"D:\src\10073-A.ipt", @"D:\dst\10137-A.ipt") with { SourceDocumentNumber = "10073-A" };
        var childB = CopyNode("cad-b", @"D:\src\10073-B.ipt", @"D:\dst\sub\10137-B.ipt") with { SourceDocumentNumber = "10073-B" };
        var root = CopyNode("cad-root", @"D:\src\10073-ROOT.iam", @"D:\dst\10137-ROOT.iam", CadDocumentType.Iam, isRoot: true)
            with { SourceDocumentNumber = "10073-ROOT" };
        var plan = Plan(new[] { root, childA, childB, reuse }, new[]
        {
            ComponentEdge(root, childA, childIsCopy: true),
            ComponentEdge(root, childB, childIsCopy: true),
            ComponentEdge(root, reuse, childIsCopy: false),
        });

        var confirmation = CopyDesignApplyConfirmationBuilder.Build(plan, NothingExists);

        Assert.True(confirmation.CanApply);
        Assert.Equal(new[] { "10073-ROOT.iam", "10073-A.ipt", "10073-B.ipt", "STD-BOLT.ipt" }, confirmation.Rows.Select(r => r.SourceFileName));
        Assert.Equal(new[] { "10137-ROOT", "10137-A", "10137-B", null }, confirmation.Rows.Select(r => r.DestinationDocumentNumber));
        Assert.Equal(3, confirmation.CopyCount);
        Assert.Equal(1, confirmation.ReuseCount);
        Assert.Equal(new[] { @"D:\dst", @"D:\dst\sub" }, confirmation.DestinationFolders);
        var reuseRow = confirmation.Rows.Single(r => r.Action == CopyDesignApplyEntryAction.Reuse);
        Assert.Null(reuseRow.DestinationFileName);
        Assert.Null(reuseRow.DestinationFolder);
        var text = CopyDesignApplyConfirmationTextReport.Render(confirmation);
        Assert.Contains("REUSE IPT  STD-BOLT.ipt (unchanged - existing document reused)", text, StringComparison.Ordinal);
        Assert.Contains("COPY  IAM  10073-ROOT.iam → 10137-ROOT.iam", text, StringComparison.Ordinal);
    }

    [Fact]
    public void A_model_and_its_drawing_may_share_a_base_number_because_their_types_differ()
    {
        var model = CopyNode("cad-m", @"D:\src\1001-OLD.ipt", @"D:\dst\1001.ipt", isRoot: true) with { SourceDocumentNumber = "1001-OLD" };
        var drawing = CopyNode("cad-d", @"D:\src\1001-OLD.idw", @"D:\dst\1001.idw", CadDocumentType.Idw) with { SourceDocumentNumber = "1001-OLD.idw" };
        var plan = Plan(new[] { model, drawing }, new[] { DrawingModelEdge(drawing, model, modelIsCopy: true) });

        var confirmation = CopyDesignApplyConfirmationBuilder.Build(plan, NothingExists);

        Assert.True(confirmation.CanApply);
        Assert.Contains(confirmation.Rows, r => r.DocumentType == CadDocumentType.Idw && r.DestinationDocumentNumber == "1001");
        Assert.Contains("COPY  IDW  1001-OLD.idw → 1001.idw", CopyDesignApplyConfirmationTextReport.Render(confirmation), StringComparison.Ordinal);
    }

    [Fact]
    public void Model_files_only_mode_is_restated_and_excludes_drawings_exactly_like_execution()
    {
        var model = CopyNode("cad-m", @"D:\src\1001-OLD.ipt", @"D:\dst\1001.ipt", isRoot: true) with { SourceDocumentNumber = "1001-OLD" };
        var drawing = CopyNode("cad-d", @"D:\src\1001-OLD.idw", @"D:\dst\1001.idw", CadDocumentType.Idw);
        var plan = Plan(new[] { model, drawing }, new[] { DrawingModelEdge(drawing, model, modelIsCopy: true) }) with { ModelFilesOnlyAcknowledged = true };

        var confirmation = CopyDesignApplyConfirmationBuilder.Build(plan, NothingExists);

        Assert.True(confirmation.ModelFilesOnly);
        Assert.DoesNotContain(confirmation.Rows, r => r.DocumentType == CadDocumentType.Idw);
        Assert.Contains("MODE: MODEL FILES ONLY - DRAWINGS: NOT INCLUDED", CopyDesignApplyConfirmationTextReport.Render(confirmation), StringComparison.Ordinal);
    }

    // ---- not executable / unresolved / unknown number ----------------------

    [Fact]
    public void A_non_executable_plan_can_never_be_applied_and_is_never_silently_unexplained()
    {
        var confirmation = CopyDesignApplyConfirmationBuilder.Build(Plan(new[] { LiveRoot() }, isExecutable: false), NothingExists);

        Assert.False(confirmation.CanApply);
        Assert.Empty(confirmation.Rows);
        Assert.NotEmpty(confirmation.Blocking);
    }

    [Fact]
    public void An_unresolved_in_scope_node_blocks_Apply_even_if_the_plan_claims_to_be_executable()
    {
        var unresolved = CopyNode("cad-x", @"D:\src\X.ipt", @"D:\dst\Y.ipt") with { IsResolved = false };

        var confirmation = CopyDesignApplyConfirmationBuilder.Build(Plan(new[] { LiveRoot(), unresolved }), NothingExists);

        Assert.False(confirmation.CanApply);
        Assert.Contains(confirmation.Blocking, i => i.SourceFileName == "X.ipt" && i.Message.Contains("unresolved", StringComparison.Ordinal));
    }

    [Fact]
    public void An_unknown_source_number_is_a_warning_not_a_block()
    {
        var confirmation = CopyDesignApplyConfirmationBuilder.Build(Plan(new[] { LiveRoot(sourceNumber: null) }), NothingExists);

        Assert.True(confirmation.CanApply);
        Assert.Contains(confirmation.Issues, i => i.Severity == CopyDesignIssueSeverity.Warning && i.Message.Contains("not known locally", StringComparison.Ordinal));
        Assert.Contains("Source document number:  (unknown)", CopyDesignApplyConfirmationTextReport.Render(confirmation), StringComparison.Ordinal);
    }

    // ---- fingerprint ----------------------------------------------------------

    [Fact]
    public void The_fingerprint_ignores_the_idempotency_key_but_changes_with_anything_that_would_execute_differently()
    {
        static string Fp(CopyDesignPlan p, string key = "k1") =>
            CopyDesignApplyConfirmationBuilder.ComputeFingerprint(CopyDesignApplyRequestMapper.Map(p, key, null, !p.ModelFilesOnlyAcknowledged).Request!, p.ModelFilesOnlyAcknowledged);

        var basePlan = Plan(new[] { LiveRoot() });
        var baseline = Fp(basePlan);

        Assert.Equal(baseline, Fp(basePlan, "a-completely-different-key"));
        Assert.Equal(baseline, CopyDesignApplyConfirmationBuilder.Build(basePlan, NothingExists).Fingerprint);
        Assert.NotEqual(baseline, Fp(Plan(new[] { LiveRoot(@"D:\ArchPLM-Test\CopyPreview\ARCH-TEST-004.ipt") })));
        Assert.NotEqual(baseline, Fp(Plan(new[] { LiveRoot(@"D:\Elsewhere\ARCH-TEST-003.ipt") })));
        Assert.NotEqual(baseline, Fp(Plan(new[] { LiveRoot() with { CurrentFileVersionId = "fv-other" } })));
        Assert.NotEqual(baseline, Fp(Plan(new[] { LiveRoot(), CopyNode("cad-2", @"D:\src\B.ipt", @"D:\dst\C.ipt") })));
        Assert.NotEqual(baseline, Fp(basePlan with { ModelFilesOnlyAcknowledged = true }));
    }

    private sealed class AlwaysFoundEmpty : IDrawingAssociationSource
    {
        public static readonly AlwaysFoundEmpty Instance = new();
        public DrawingAssociationResult GetAssociatedDrawings(string cadDocumentId) =>
            new(DrawingAssociationOutcome.Found, Array.Empty<AssociatedDrawing>());
    }
}
