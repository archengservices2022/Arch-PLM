namespace Arch.CadConnect.Core.CopyDesign.Apply;

/// <summary>
/// P6 METADATA FIX (P1 acceptance blocker "temporary name in Part Number"):
/// detects an operation-owned temporary file name (see
/// <see cref="CopyDesignAtomicPromotion.TempFileNameMarker"/>) inside a
/// metadata value. Inventor derives a document's default Part Number from the
/// file name it is SAVED under - and <see cref="CopyDesignAtomicPromotion"/>
/// deliberately saves to an operation-owned temp name first, then renames.
/// The rename never touches the file's iProperties, so any value Inventor
/// derived from the temp name survives into the final file unless something
/// explicitly normalizes it. PURE - no COM, no I/O.
/// </summary>
public static class CopyDesignTempNameLeak
{
    /// <summary>Case-insensitive - a leaked value is never excused by a case
    ///  difference.</summary>
    public static bool Contains(string? value) =>
        !string.IsNullOrEmpty(value)
        && value.Contains(CopyDesignAtomicPromotion.TempFileNameMarker, StringComparison.OrdinalIgnoreCase);
}

public enum CopyDesignPartNumberDecisionKind
{
    /// <summary>Leave the Part Number exactly as it is - no write, no save.</summary>
    Keep,

    /// <summary>The Part Number is EXACTLY the temp file's stem (Inventor's
    ///  own default derivation) - replace it with the final file's stem.</summary>
    Replace,

    /// <summary>The Part Number carries the temp-name marker in some OTHER
    ///  form - never guessed at, never silently kept: fail closed.</summary>
    Reject,
}

public sealed record CopyDesignPartNumberDecision(
    CopyDesignPartNumberDecisionKind Kind,
    string? NewPartNumber,
    string? FailureReason);

/// <summary>
/// P6 METADATA FIX: the PURE Part Number normalization policy applied to a
/// FINAL, promoted COPY destination. Deliberately narrow - it only UNDOES the
/// temp-name derivation and introduces no new numbering policy:
///  - empty Part Number -&gt; Keep;
///  - exactly the temp file's stem (ordinal, case-sensitive) -&gt; Replace
///    with the final file's stem, i.e. exactly what Inventor would have
///    derived had the copy been saved straight to the final name;
///  - anything else carrying the temp-name marker -&gt; Reject (fail closed);
///  - anything else (the final stem, an explicitly assigned custom number,
///    an unchanged source number, ...) -&gt; Keep, untouched.
/// </summary>
public static class CopyDesignPartNumberPolicy
{
    public static CopyDesignPartNumberDecision Decide(string? currentPartNumber, string? promotedFromTempFileName, string finalFileName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(finalFileName);

        if (string.IsNullOrEmpty(currentPartNumber))
        {
            return new(CopyDesignPartNumberDecisionKind.Keep, null, null);
        }

        var tempStem = string.IsNullOrWhiteSpace(promotedFromTempFileName)
            ? null
            : Path.GetFileNameWithoutExtension(promotedFromTempFileName);
        if (tempStem is not null && string.Equals(currentPartNumber, tempStem, StringComparison.Ordinal))
        {
            return new(CopyDesignPartNumberDecisionKind.Replace, Path.GetFileNameWithoutExtension(finalFileName), null);
        }

        if (CopyDesignTempNameLeak.Contains(currentPartNumber))
        {
            return new(CopyDesignPartNumberDecisionKind.Reject, null,
                $"The copied document's Part Number (\"{currentPartNumber}\") contains an operation-owned temporary file name "
                + "in an unexpected form - refusing to guess a replacement (fail closed).");
        }

        return new(CopyDesignPartNumberDecisionKind.Keep, null, null);
    }
}

public sealed record CopyDesignMetadataNormalizationResult(bool Success, string? FailureReason);

/// <summary>
/// P6 METADATA FIX: normalizes the metadata of ONE COPY destination AFTER it
/// has been atomically promoted to its FINAL path - never the temp file,
/// never the source. Called by <see cref="CopyDesignApplyOrchestrator"/>
/// immediately after the destination is recorded in the attempt's cleanup
/// journal, so a failure here is cleaned up exactly like any other
/// post-creation failure and can never reach verification, upload, or
/// materialization.
/// </summary>
public interface ICopyDesignMetadataNormalizer
{
    /// <param name="promotedFromTempFileName">The file NAME (no directory)
    ///  of the operation-owned temp file the destination was promoted from -
    ///  see <see cref="CopyDesignPhysicalCopyResult.PromotedFromTempFileName"/>.
    ///  <c>null</c> when the copier did not report one, in which case only
    ///  the fail-closed marker check can apply.</param>
    Task<CopyDesignMetadataNormalizationResult> NormalizeAsync(
        CopyDesignNode node, string? promotedFromTempFileName, CancellationToken ct);
}
