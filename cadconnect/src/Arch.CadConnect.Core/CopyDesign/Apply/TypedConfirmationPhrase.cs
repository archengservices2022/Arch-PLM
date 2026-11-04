namespace Arch.CadConnect.Core.CopyDesign.Apply;

/// <summary>
/// M4.1 T6 follow-up: the one matching rule for every typed Copy Design
/// confirmation phrase (<c>APPLY N</c>, <c>RECOVER N</c>). Only leading and
/// trailing whitespace is ignored; everything else - case, inner spacing,
/// digits, wording - must match exactly (ordinal).
/// </summary>
public static class TypedConfirmationPhrase
{
    public static bool Matches(string expectedPhrase, string? typed)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(expectedPhrase);
        return typed is not null && string.Equals(typed.Trim(), expectedPhrase, StringComparison.Ordinal);
    }
}
