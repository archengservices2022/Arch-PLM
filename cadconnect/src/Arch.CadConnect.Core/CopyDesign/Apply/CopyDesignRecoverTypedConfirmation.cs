using System.Globalization;

namespace Arch.CadConnect.Core.CopyDesign.Apply;

/// <summary>
/// M4.1 T6 follow-up: the TYPED confirmation that enables Recover Copy
/// Design. The engineer must type <c>RECOVER N</c>.
///
/// N is accurate here, not an upper bound: Recover is only ever offered after
/// the reservation call itself failed (see <c>ArchAddInController</c>), and
/// nothing is copied or materialized before a reservation answer - so every
/// COPY entry of the replayed request is still pending. N is counted from
/// the SAME request mapping the orchestrator replays
/// (<see cref="CopyDesignApplyRequestMapper"/>, same drawing scope), never
/// from the plan's node list directly. A plan that cannot be mapped cannot be
/// recovered (the orchestrator would refuse it), so it is never confirmable.
///
/// This only unlocks the dialog's Recover button; the orchestrator's own
/// checks still run unchanged.
/// </summary>
public static class CopyDesignRecoverTypedConfirmation
{
    public sealed record Prepared(bool CanConfirm, int FilesToCopy, string? Phrase, string? Reason);

    public static Prepared Prepare(CopyDesignPlan plan, string idempotencyKey)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentException.ThrowIfNullOrWhiteSpace(idempotencyKey);

        var mapping = CopyDesignApplyRequestMapper.Map(
            plan, idempotencyKey, label: null, includeDrawings: !plan.ModelFilesOnlyAcknowledged);
        if (!mapping.Success)
        {
            return new Prepared(false, 0, null, mapping.FailureReason);
        }
        var copies = mapping.Request!.Entries.Count(e => e.Entry.Action == CopyDesignApplyEntryAction.Copy);
        if (copies == 0)
        {
            return new Prepared(false, 0, null, "The attempt has no files to copy.");
        }
        return new Prepared(true, copies, "RECOVER " + copies.ToString(CultureInfo.InvariantCulture), null);
    }

    public static bool IsSatisfied(Prepared prepared, string? typed)
    {
        ArgumentNullException.ThrowIfNull(prepared);
        return prepared.CanConfirm && TypedConfirmationPhrase.Matches(prepared.Phrase!, typed);
    }
}
