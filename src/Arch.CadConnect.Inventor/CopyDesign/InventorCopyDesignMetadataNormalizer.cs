using System.Runtime.InteropServices;

using Arch.CadConnect.Core.CopyDesign;
using Arch.CadConnect.Core.CopyDesign.Apply;

using InventorApi = Inventor;

namespace Arch.CadConnect.Inventor.CopyDesign;

/// <summary>
/// P6 METADATA FIX (P1 "temporary name in Part Number"): undoes the Part
/// Number Inventor derived from the operation-owned temp file name.
///
/// ROOT CAUSE: <see cref="InventorCopyDesignPhysicalCopier"/> saves the copy
/// to <c>.p6c-tmp-&lt;guid&gt;-&lt;final name&gt;</c> (HIGH 4 - never SaveAs onto the
/// unclaimed final path) and <see cref="CopyDesignAtomicPromotion"/> then
/// renames it. For a source whose Part Number still follows its file name,
/// Inventor sets the COPY's Part Number from the name it is SAVED under - the
/// temp name - and the rename never touches iProperties.
///
/// FIX, applied ONLY to the FINAL promoted destination (never the temp file,
/// never the source), via the PURE <see cref="CopyDesignPartNumberPolicy"/>:
///  - Part Number exactly equal to the temp stem -&gt; set it to the final
///    stem and save with <c>Save2(SaveDependents: false)</c> - the SAME
///    no-cascade save <see cref="InventorCopyDesignDrawingReferenceRewirer"/>
///    uses, so no referenced (source/REUSE) document is ever persisted;
///  - empty, final-name, or explicitly assigned Part Number -&gt; untouched, and
///    the document is NOT saved at all (its bytes stay exactly as copied);
///  - the temp marker in any other form -&gt; fail closed.
/// The document is always closed with <c>SkipSave</c>. Any failure is
/// reported, never thrown; the orchestrator then cleans up this attempt's
/// destination (it is already journalled) so it can never be materialized.
/// </summary>
internal sealed class InventorCopyDesignMetadataNormalizer(InventorApi.Application application) : ICopyDesignMetadataNormalizer
{
    public Task<CopyDesignMetadataNormalizationResult> NormalizeAsync(
        CopyDesignNode node, string? promotedFromTempFileName, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(node);
        ct.ThrowIfCancellationRequested();

        var destination = node.ProposedDestinationAbsolutePath;
        if (string.IsNullOrWhiteSpace(destination) || !File.Exists(destination))
        {
            return Fail("The copied document's final destination file does not exist.");
        }
        if (PathsEqual(destination, node.SourceAbsolutePath))
        {
            return Fail("The final destination is the source path - refusing to touch the source.");
        }

        InventorApi.Document? document = null;
        var silentBefore = application.SilentOperation;
        try
        {
            application.SilentOperation = true;
            document = application.Documents.Open(destination, OpenVisible: false);
            if (document is null)
            {
                return Fail("Inventor could not open the copied document's final destination.");
            }
            if (!PathsEqual(document.FullFileName, destination))
            {
                return Fail("Inventor opened a document other than the final destination - refusing to modify it.");
            }

            var partNumber = InventorCopyDesignPropertyReader.PartNumberProperty(document);
            var decision = CopyDesignPartNumberPolicy.Decide(
                partNumber.Value as string, promotedFromTempFileName, Path.GetFileName(destination));

            switch (decision.Kind)
            {
                case CopyDesignPartNumberDecisionKind.Reject:
                    return Fail(decision.FailureReason!);

                case CopyDesignPartNumberDecisionKind.Replace:
                    partNumber.Value = decision.NewPartNumber!;
                    document.Save2(SaveDependents: false, DocumentsToSave: Type.Missing);
                    break;

                case CopyDesignPartNumberDecisionKind.Keep:
                    // Nothing to undo - never saved, bytes untouched.
                    break;
            }
        }
        catch (COMException ex)
        {
            return Fail($"Inventor reported an error while normalizing the Part Number (COMException, 0x{ex.HResult:X8}): {SafeMessage(ex)}");
        }
        catch (Exception ex) when (ex is InvalidComObjectException or InvalidCastException or IOException or UnauthorizedAccessException)
        {
            return Fail($"Part Number normalization failed: {ex.Message}");
        }
        finally
        {
            try { application.SilentOperation = silentBefore; } catch { /* best effort */ }
            if (document is not null)
            {
                // Already saved above when a replacement was made; SkipSave
                // never persists anything on a Keep/Reject/failure path. Only
                // ever this freshly-opened FINAL destination - never the source.
                try { document.Close(SkipSave: true); } catch { /* best effort */ }
            }
        }

        return Task.FromResult(new CopyDesignMetadataNormalizationResult(true, null));
    }

    private static Task<CopyDesignMetadataNormalizationResult> Fail(string reason) =>
        Task.FromResult(new CopyDesignMetadataNormalizationResult(false, reason));

    private static bool PathsEqual(string? left, string? right)
    {
        if (string.IsNullOrWhiteSpace(left) || string.IsNullOrWhiteSpace(right))
        {
            return false;
        }
        try
        {
            return string.Equals(Path.GetFullPath(left), Path.GetFullPath(right), StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return false;
        }
    }

    private static string SafeMessage(Exception ex) =>
        string.IsNullOrWhiteSpace(ex.Message) ? "(no exception message)" : ex.Message;
}
