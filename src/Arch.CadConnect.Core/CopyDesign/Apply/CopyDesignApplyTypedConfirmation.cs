using System.Globalization;

namespace Arch.CadConnect.Core.CopyDesign.Apply;

/// <summary>
/// M4.1 T6 follow-up: the TYPED confirmation that enables Apply Copy Design.
/// The engineer must type <c>APPLY N</c>, where N is the number of files this
/// confirmation will copy and materialize (its COPY rows - REUSE rows are
/// neither copied nor materialized). Only leading/trailing whitespace is
/// ignored; case, spacing, digits and wording must match exactly.
///
/// This only unlocks the dialog's Apply button. It authorizes nothing by
/// itself: a confirmation that cannot apply is never satisfied, and the
/// orchestrator still re-validates the plan against the confirmed
/// fingerprint before any mutation.
/// </summary>
public static class CopyDesignApplyTypedConfirmation
{
    /// <summary>The exact phrase to type, e.g. <c>APPLY 4</c>.</summary>
    public static string ExpectedPhrase(CopyDesignApplyConfirmation confirmation)
    {
        ArgumentNullException.ThrowIfNull(confirmation);
        return "APPLY " + confirmation.CopyCount.ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>True only when the confirmation can apply AND
    ///  <paramref name="typed"/>, trimmed, is exactly
    ///  <see cref="ExpectedPhrase"/>.</summary>
    public static bool IsSatisfied(CopyDesignApplyConfirmation confirmation, string? typed)
    {
        ArgumentNullException.ThrowIfNull(confirmation);
        return confirmation.CanApply && TypedConfirmationPhrase.Matches(ExpectedPhrase(confirmation), typed);
    }
}
