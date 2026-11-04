namespace Arch.CadConnect.Core.CopyDesign.Apply;

/// <summary>
/// M4.1 T6 follow-up: the TYPED confirmation that enables Resume Copy Design
/// (in-session AND durable - both show the same dialog). The engineer must
/// type <c>RESUME &lt;last 6 characters of the idempotency key&gt;</c>, with
/// the suffix in its original case, e.g. <c>RESUME 9f2152</c>.
///
/// Deliberately NOT a file count: which entries are still pending is only
/// learned from the server while the resume runs, so any count shown before
/// it would be a guess. The key suffix instead ties the confirmation to THIS
/// operation - the same key the resume reuses, unchanged.
///
/// A missing, malformed or too-short key is never confirmable. This only
/// unlocks the dialog's Resume button; every orchestrator check still runs.
/// </summary>
public static class CopyDesignResumeTypedConfirmation
{
    public const int SuffixLength = 6;

    /// <summary>Real keys are ~47 characters (<c>cadconnect-p6c-</c> + 32 hex
    ///  digits); anything shorter than this is not a key this client minted.</summary>
    public const int MinimumKeyLength = 16;

    public sealed record Prepared(bool CanConfirm, string? Phrase, string? Reason);

    public static Prepared Prepare(string? idempotencyKey)
    {
        if (string.IsNullOrEmpty(idempotencyKey))
        {
            return new Prepared(false, null, "The attempt has no idempotency key.");
        }
        if (idempotencyKey.Length < MinimumKeyLength)
        {
            return new Prepared(false, null, "The attempt's idempotency key is too short to be valid.");
        }
        if (idempotencyKey.Any(c => c is < '!' or > '~'))
        {
            return new Prepared(false, null, "The attempt's idempotency key contains invalid characters.");
        }
        var suffix = idempotencyKey[^SuffixLength..];
        if (!suffix.All(char.IsAsciiLetterOrDigit))
        {
            return new Prepared(false, null, "The attempt's idempotency key does not end in letters or digits.");
        }
        return new Prepared(true, "RESUME " + suffix, null);
    }

    public static bool IsSatisfied(Prepared prepared, string? typed)
    {
        ArgumentNullException.ThrowIfNull(prepared);
        return prepared.CanConfirm && TypedConfirmationPhrase.Matches(prepared.Phrase!, typed);
    }
}
