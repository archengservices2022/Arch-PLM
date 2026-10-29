using Arch.CadConnect.Core.CopyDesign;
using Arch.CadConnect.Core.CopyDesign.Apply;

using static Arch.CadConnect.Core.Tests.CopyDesign.Apply.CopyDesignApplyFixtures;

namespace Arch.CadConnect.Core.Tests.CopyDesign.Apply;

/// <summary>
/// P6 METADATA FIX (P1 "temporary name in Part Number"): how the orchestrator
/// sequences metadata normalization (after the destination is journalled,
/// before rewiring/verification/materialization), how a normalization or
/// verification-time leak failure is cleaned up, and that resume/recovery
/// semantics are unchanged.
/// </summary>
public class CopyDesignApplyOrchestratorMetadataTests
{
    private static readonly CopyDesignStringPropertyFact LeakedPartNumber =
        new("Design Tracking Properties", "Part Number", ".p6c-tmp-664164fdc80849babfa2b6b25a1a3d36-ARCH-TEST-002");

    private static (OrchestratorHarness H, CopyDesignNode Node, CopyDesignPlan Plan) SingleIpt()
    {
        var h = new OrchestratorHarness();
        var node = CopyNode("cad-1", @"C:\src\ARCH-TEST-001.ipt", @"C:\dst\ARCH-TEST-002.ipt");
        h.ExistingSources.Add(node.SourceAbsolutePath);
        return (h, node, Plan(new[] { node }));
    }

    // ---- model path: sequencing --------------------------------------------

    [Fact]
    public async Task An_IPT_is_normalized_once_with_its_promoted_temp_name_before_verification_and_materialization()
    {
        var (h, node, plan) = SingleIpt();

        var result = await h.Build().ExecuteAsync(plan, "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.Succeeded, result.Outcome);
        Assert.Equal(new[] { "cad-1" }, h.MetadataNormalizer.Calls);
        Assert.Equal(FakePhysicalCopier.TempFileNameFor(node), h.MetadataNormalizer.CapturedTempFileName["cad-1"]);
        Assert.Equal(new[] { "copy:cad-1", "normalize:cad-1", "verify:cad-1" }, h.Events);
        Assert.Single(h.Materializer.Calls);
    }

    [Fact]
    public async Task The_materialized_checksum_is_the_one_verification_captured_AFTER_normalization()
    {
        var (h, node, plan) = SingleIpt();
        h.Verifier.ResultingSha256Provider = n =>
            h.MetadataNormalizer.NormalizedDestinations.Contains(n.ProposedDestinationAbsolutePath!) ? "sha-normalized" : "sha-unnormalized";

        var result = await h.Build().ExecuteAsync(plan, "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.Succeeded, result.Outcome);
        var request = Assert.Single(h.Materializer.Requests);
        Assert.Equal("sha-normalized", request.ExpectedSha256);
        Assert.Equal(node.ProposedDestinationAbsolutePath, request.LocalFilePath);
    }

    [Fact]
    public async Task An_IAM_and_its_copied_child_are_each_normalized_after_their_own_copy_and_BEFORE_rewiring()
    {
        var h = new OrchestratorHarness();
        var child = CopyNode("cad-child", @"C:\src\child.ipt", @"C:\dst\child-new.ipt");
        var parent = CopyNode("cad-parent", @"C:\src\parent.iam", @"C:\dst\parent-new.iam", CadDocumentType.Iam, isRoot: true);
        var plan = Plan(new[] { parent, child }, new[] { ComponentEdge(parent, child, childIsCopy: true) });
        h.ExistingSources.Add(parent.SourceAbsolutePath);
        h.ExistingSources.Add(child.SourceAbsolutePath);

        var result = await h.Build().ExecuteAsync(plan, "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.Succeeded, result.Outcome);
        Assert.Equal(new[] { "cad-child", "cad-parent" }, h.MetadataNormalizer.Calls.OrderBy(x => x));
        var e = h.Events;
        Assert.True(e.IndexOf("copy:cad-parent") < e.IndexOf("normalize:cad-parent"));
        Assert.True(e.IndexOf("copy:cad-child") < e.IndexOf("normalize:cad-child"));
        Assert.True(e.IndexOf("normalize:cad-parent") < e.IndexOf("rewire:cad-parent"));
        Assert.True(e.IndexOf("rewire:cad-parent") < e.IndexOf("verify:cad-parent"));
    }

    // ---- model path: normalization failure ---------------------------------

    [Fact]
    public async Task A_normalization_failure_cleans_up_and_never_verifies_uploads_or_materializes()
    {
        var (h, node, plan) = SingleIpt();
        h.MetadataNormalizer.FailFor.Add("cad-1");

        var result = await h.Build().ExecuteAsync(plan, "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.PhysicalCopyFailed, result.Outcome);
        Assert.Contains("Metadata normalization failed", result.FailureReason, StringComparison.Ordinal);
        Assert.Contains("simulated normalization failure", result.FailureReason, StringComparison.Ordinal);
        Assert.Equal("op-1", result.CopyDesignOperationId); // reservation evidence still reported
        Assert.True(result.ReservedButUnmaterialized);
        Assert.Equal(new[] { node.ProposedDestinationAbsolutePath! }, h.Deleted);
        Assert.Empty(h.Verifier.Calls);
        Assert.Empty(h.Materializer.Calls);
        Assert.DoesNotContain(result.Entries, entry => entry.Materialization?.Outcome == CopyDesignMaterializationOutcome.Materialized);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task A_normalizer_exception_or_cancellation_is_contained_and_cleaned_up_like_a_failure(bool cancellation)
    {
        var (h, node, plan) = SingleIpt();
        h.MetadataNormalizer.ThrowFor.Add("cad-1");
        if (cancellation)
        {
            h.MetadataNormalizer.ExceptionToThrow = new OperationCanceledException("simulated cancellation");
        }

        var result = await h.Build().ExecuteAsync(plan, "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.PhysicalCopyFailed, result.Outcome);
        Assert.Equal(new[] { node.ProposedDestinationAbsolutePath! }, h.Deleted);
        Assert.Empty(h.Materializer.Calls);
    }

    [Fact]
    public async Task Cleanup_after_a_normalization_failure_touches_only_destinations_THIS_attempt_created()
    {
        var h = new OrchestratorHarness();
        var first = CopyNode("cad-1", @"C:\src\a.ipt", @"C:\dst\a-new.ipt");
        var second = CopyNode("cad-2", @"C:\src\b.ipt", @"C:\dst\b-new.ipt");
        var never = CopyNode("cad-3", @"C:\src\c.ipt", @"C:\dst\c-new.ipt");
        var plan = Plan(new[] { first, second, never });
        foreach (var n in new[] { first, second, never })
        {
            h.ExistingSources.Add(n.SourceAbsolutePath);
        }
        h.MetadataNormalizer.FailFor.Add("cad-2");

        var result = await h.Build().ExecuteAsync(plan, "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.PhysicalCopyFailed, result.Outcome);
        // Exactly the two destinations this attempt created - never the
        // not-yet-copied third, never any source.
        Assert.Equal(
            new[] { first.ProposedDestinationAbsolutePath!, second.ProposedDestinationAbsolutePath! }.OrderBy(x => x),
            h.Deleted.OrderBy(x => x));
        Assert.DoesNotContain("cad-3", h.Copier.Calls);
        Assert.DoesNotContain(h.Deleted, d => d.StartsWith(@"C:\src\", StringComparison.OrdinalIgnoreCase));
    }

    // ---- verification-time leak rejection (Fix B) ---------------------------

    [Fact]
    public async Task A_leaked_temp_name_found_by_verification_fails_cleans_up_and_never_materializes()
    {
        var (h, node, plan) = SingleIpt();
        h.Verifier.StringPropertiesFor["cad-1"] = new[] { LeakedPartNumber };

        var result = await h.Build().ExecuteAsync(plan, "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.VerificationFailed, result.Outcome);
        Assert.Contains("Design Tracking Properties / Part Number", result.FailureReason, StringComparison.Ordinal);
        Assert.Equal(new[] { node.ProposedDestinationAbsolutePath! }, h.Deleted);
        Assert.Empty(h.Materializer.Calls);
    }

    [Fact]
    public async Task A_leak_in_a_copied_IAM_fails_the_whole_model_phase()
    {
        var h = new OrchestratorHarness();
        var child = CopyNode("cad-child", @"C:\src\child.ipt", @"C:\dst\child-new.ipt");
        var parent = CopyNode("cad-parent", @"C:\src\parent.iam", @"C:\dst\parent-new.iam", CadDocumentType.Iam, isRoot: true);
        var plan = Plan(new[] { parent, child }, new[] { ComponentEdge(parent, child, childIsCopy: true) });
        h.ExistingSources.Add(parent.SourceAbsolutePath);
        h.ExistingSources.Add(child.SourceAbsolutePath);
        h.Verifier.StringPropertiesFor["cad-parent"] = new[] { LeakedPartNumber };

        var result = await h.Build().ExecuteAsync(plan, "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.VerificationFailed, result.Outcome);
        Assert.Equal(2, h.Deleted.Count);
        Assert.Empty(h.Materializer.Calls);
    }

    [Fact]
    public async Task An_unreadable_iProperty_set_fails_verification_closed()
    {
        var (h, _, plan) = SingleIpt();
        h.Verifier.PropertyEnumerationFailureFor.Add("cad-1");

        var result = await h.Build().ExecuteAsync(plan, "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.VerificationFailed, result.Outcome);
        Assert.Empty(h.Materializer.Calls);
    }

    [Fact]
    public async Task Without_a_normalizer_configured_the_verification_leak_rule_still_blocks_materialization()
    {
        var (h, _, plan) = SingleIpt();
        h.IncludeMetadataNormalizer = false;
        h.Verifier.StringPropertiesFor["cad-1"] = new[] { LeakedPartNumber };

        var result = await h.Build().ExecuteAsync(plan, "key-1", null);

        Assert.Empty(h.MetadataNormalizer.Calls);
        Assert.Equal(CopyDesignApplyOutcome.VerificationFailed, result.Outcome);
        Assert.Empty(h.Materializer.Calls);
    }

    [Fact]
    public async Task Without_a_normalizer_configured_a_clean_apply_behaves_exactly_as_before()
    {
        var (h, _, plan) = SingleIpt();
        h.IncludeMetadataNormalizer = false;

        var result = await h.Build().ExecuteAsync(plan, "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.Succeeded, result.Outcome);
        Assert.Equal(new[] { "copy:cad-1", "verify:cad-1" }, h.Events);
    }

    // ---- drawing path (IDW / DWG) --------------------------------------------

    private static (OrchestratorHarness H, CopyDesignNode Model, CopyDesignNode Drawing, CopyDesignPlan Plan) ModelAndDrawing(
        CadDocumentType drawingType = CadDocumentType.Idw)
    {
        var h = new OrchestratorHarness();
        var extension = drawingType == CadDocumentType.Dwg ? "dwg" : "idw";
        var model = CopyNode("cad-model", @"C:\src\a.ipt", @"C:\dst\a-new.ipt");
        var drawing = CopyNode("cad-drawing", $@"C:\src\a.{extension}", $@"C:\dst\a-new.{extension}", drawingType);
        var plan = Plan(new[] { model, drawing }, new[] { DrawingModelEdge(drawing, model, modelIsCopy: true) });
        h.ExistingSources.Add(model.SourceAbsolutePath);
        h.ExistingSources.Add(drawing.SourceAbsolutePath);
        return (h, model, drawing, plan);
    }

    [Theory]
    [InlineData(CadDocumentType.Idw)]
    [InlineData(CadDocumentType.Dwg)]
    public async Task A_drawing_is_normalized_after_its_copy_and_before_drawing_rewiring(CadDocumentType drawingType)
    {
        var (h, _, drawing, plan) = ModelAndDrawing(drawingType);

        var result = await h.Build().ExecuteAsync(plan, "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.Succeeded, result.Outcome);
        Assert.Equal(new[] { "cad-model", "cad-drawing" }, h.MetadataNormalizer.Calls);
        Assert.Equal(FakePhysicalCopier.TempFileNameFor(drawing), h.MetadataNormalizer.CapturedTempFileName["cad-drawing"]);
        var e = h.Events;
        Assert.True(e.IndexOf("copy:cad-drawing") < e.IndexOf("normalize:cad-drawing"));
        Assert.True(e.IndexOf("normalize:cad-drawing") < e.IndexOf("rewire:cad-drawing"));
    }

    [Fact]
    public async Task A_drawing_normalization_failure_cleans_up_only_the_drawing_and_still_materializes_the_verified_model()
    {
        var (h, model, drawing, plan) = ModelAndDrawing();
        h.MetadataNormalizer.FailFor.Add("cad-drawing");

        var result = await h.Build().ExecuteAsync(plan, "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.DrawingPhysicalCopyFailed, result.Outcome);
        Assert.Contains("metadata normalization failed", result.FailureReason, StringComparison.Ordinal);
        Assert.Equal(new[] { drawing.ProposedDestinationAbsolutePath! }, h.Deleted);
        Assert.DoesNotContain(model.ProposedDestinationAbsolutePath!, h.Deleted);
        Assert.Empty(h.DrawingRewirer.Calls);
        Assert.Equal(new[] { "cad-model-new" }, h.Materializer.Calls);
    }

    [Fact]
    public async Task A_drawing_leak_found_by_verification_fails_only_the_drawing_and_never_materializes_it()
    {
        var (h, _, drawing, plan) = ModelAndDrawing();
        h.DrawingVerifier.StringPropertiesFor["cad-drawing"] = new[] { LeakedPartNumber };

        var result = await h.Build().ExecuteAsync(plan, "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.DrawingVerificationFailed, result.Outcome);
        Assert.Equal(new[] { drawing.ProposedDestinationAbsolutePath! }, h.Deleted);
        Assert.Equal(new[] { "cad-model-new" }, h.Materializer.Calls);
    }

    [Fact]
    public async Task The_drawing_materialized_checksum_is_the_one_captured_AFTER_normalization()
    {
        var (h, _, drawing, plan) = ModelAndDrawing();
        h.DrawingVerifier.ResultingSha256Provider = n =>
            h.MetadataNormalizer.NormalizedDestinations.Contains(n.ProposedDestinationAbsolutePath!) ? "sha-normalized" : "sha-unnormalized";

        var result = await h.Build().ExecuteAsync(plan, "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.Succeeded, result.Outcome);
        var request = h.Materializer.Requests.Single(r => r.ResultingCadDocumentId == "cad-drawing-new");
        Assert.Equal("sha-normalized", request.ExpectedSha256);
        Assert.Equal(drawing.ProposedDestinationAbsolutePath, request.LocalFilePath);
    }

    // ---- resume / recovery unchanged ------------------------------------------

    [Fact]
    public async Task Resume_never_normalizes_or_cleans_up_an_entry_materialized_by_a_prior_attempt()
    {
        var h = new OrchestratorHarness { IncludeOperationStatusClient = true };
        var done = CopyNode("cad-done", @"C:\src\a.ipt", @"C:\dst\a-new.ipt");
        var pending = CopyNode("cad-pending", @"C:\src\b.ipt", @"C:\dst\b-new.ipt");
        var plan = Plan(new[] { done, pending });
        h.ExistingSources.Add(done.SourceAbsolutePath);
        h.ExistingSources.Add(pending.SourceAbsolutePath);

        var doneDest = done.ProposedDestinationAbsolutePath!;
        var hash = new string('a', 64);
        h.ExistingDestinations.Add(doneDest);
        h.FileSizeFor[doneDest] = 123L;
        h.Hasher.SequencedHashesFor[doneDest] = new Queue<string>(new[] { hash });
        h.Reservation.OnResponded = (request, response) =>
        {
            foreach (var entry in response.Entries)
            {
                h.OperationStatusClient.AddPendingIfAbsent(
                    entry.Action == CopyDesignApplyEntryAction.Copy, entry.SourceCadDocumentId,
                    entry.ResultingCadDocumentId, entry.DocumentNumber, entry.FileName, entry.DocumentType);
            }
            h.OperationStatusClient.OperationId = response.CopyDesignOperationId;
            h.OperationStatusClient.IdempotencyKey = request.IdempotencyKey;
            h.OperationStatusClient.MarkMaterialized("cad-done-new", 1, hash, 123L, "fv-resumed-1");
        };
        h.MetadataNormalizer.FailFor.Add("cad-pending");

        var result = await h.Build().ExecuteAsync(plan, "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.PhysicalCopyFailed, result.Outcome);
        Assert.Equal(new[] { "cad-pending" }, h.MetadataNormalizer.Calls); // never the already-materialized entry
        Assert.Equal(new[] { pending.ProposedDestinationAbsolutePath! }, h.Deleted); // never the prior attempt's file
        Assert.DoesNotContain(doneDest, h.Deleted);
        Assert.Empty(h.Materializer.Calls);
    }

    [Fact]
    public async Task Recovery_with_the_same_key_normalizes_exactly_once_and_reuses_the_same_reservation_key()
    {
        var (h, _, plan) = SingleIpt();
        h.Reservation.ThrowForFirstNCalls = 1; // the first attempt's reservation call fails (no transient classifier)
        var orchestrator = h.Build();

        var first = await orchestrator.ExecuteAsync(plan, "original-key", null);
        Assert.Equal(CopyDesignApplyOutcome.ReservationCallFailed, first.Outcome);
        Assert.Empty(h.Copier.Calls);
        Assert.Empty(h.MetadataNormalizer.Calls);

        var recovered = await orchestrator.ExecuteAsync(plan, "original-key", null);

        Assert.Equal(CopyDesignApplyOutcome.Succeeded, recovered.Outcome);
        Assert.Equal("original-key", recovered.IdempotencyKey);
        Assert.All(h.Reservation.Calls, call => Assert.Equal("original-key", call.IdempotencyKey));
        Assert.Equal(new[] { "cad-1" }, h.Copier.Calls);
        Assert.Equal(new[] { "cad-1" }, h.MetadataNormalizer.Calls);
        Assert.Single(h.Materializer.Calls);
    }
}
