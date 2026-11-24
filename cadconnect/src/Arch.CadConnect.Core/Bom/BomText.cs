using System.Globalization;
using System.Text;

namespace Arch.CadConnect.Core.Bom;

/// <summary>
/// Shared normalization and formatting rules, so validation, canonical hashing
/// and CSV export always agree on what a value "is".
/// </summary>
public static class BomText
{
    /// <summary>
    /// Text as it is compared, hashed and exported: lone UTF-16 surrogates
    /// replaced by U+FFFD, Unicode NFC, surrounding whitespace trimmed; empty
    /// becomes null. Inner whitespace and letter case are preserved.
    /// </summary>
    /// <remarks>
    /// UNICODE AND HASH STABILITY. This is the only normalization applied
    /// before text is hashed (<see cref="BomCanonicalSerializer.ComputeSha256"/>,
    /// which hashes the UTF-8 bytes, no byte-order mark, of the canonical text).
    ///  - Normalization is NFC (canonical composition) only, done by the .NET
    ///    runtime's globalization layer: ICU by default where available (Linux,
    ///    Windows 10 1903+), but Windows can run in NLS mode
    ///    (System.Globalization.UseNls / DOTNET_SYSTEM_GLOBALIZATION_USENLS).
    ///    Both are expected to give the same NFC result for assigned
    ///    characters, but that is not proven here; the pinned non-ASCII golden
    ///    hash test guards it on whatever mode the tests run in. Other
    ///    transformations: lone surrogates -> U+FFFD, trim, empty -> null.
    ///    There is NO compatibility folding (NFKC), NO
    ///    case folding, NO confusable/homoglyph mapping and NO removal of
    ///    invisible format characters; trimming removes only leading and
    ///    trailing <see cref="char.IsWhiteSpace(char)"/> characters.
    ///  - Visually identical text therefore hashes identically ONLY when it is
    ///    canonically equivalent: precomposed "ö" (U+00F6) and "o" + U+0308,
    ///    or the Angstrom sign U+212B and "Å" U+00C5, give the same hash.
    ///    Look-alikes that are not canonically equivalent give DIFFERENT
    ///    hashes: full-width vs ASCII letters, ligatures ("ﬁ" vs "fi"), Cyrillic
    ///    "а" vs Latin "a", a different letter case, or an embedded zero-width
    ///    character (U+200B, U+200D, U+FEFF).
    ///  - Lone UTF-16 surrogates become U+FFFD, so texts differing only in
    ///    which lone surrogate they hold hash alike (the validator reports such
    ///    text as <see cref="BomIssueCode.InvalidText"/>).
    ///  - Across runtime / Unicode versions: under the Unicode normalization
    ///    stability policy the NFC form of text made of characters ASSIGNED in
    ///    the runtime's Unicode version never changes, so its hash is stable.
    ///    Code points unassigned in that version are passed through unchanged
    ///    today; if a later Unicode version assigns one as a combining mark,
    ///    NFC may reorder it and the hash of such text could change. Any change
    ///    to these rules must change <see cref="BomCanonicalSerializer.FormatId"/>.
    /// </remarks>
    public static string? Normalize(string? value)
    {
        if (value is null)
        {
            return null;
        }

        var normalized = ReplaceLoneSurrogates(value).Normalize(NormalizationForm.FormC).Trim();
        return normalized.Length == 0 ? null : normalized;
    }

    /// <summary>
    /// A decimal in invariant culture, without trailing zeros or exponent:
    /// 1.50 -> "1.5", 2.000 -> "2", 0.1 -> "0.1". Every scale of the same
    /// value formats identically; negative zero formats as "0".
    /// </summary>
    public static string FormatDecimal(decimal value)
    {
        if (value == 0m)
        {
            return "0";
        }

        return value.ToString("0.############################", CultureInfo.InvariantCulture);
    }

    /// <summary>True when the text contains a lone (unpaired) UTF-16 surrogate.</summary>
    public static bool HasLoneSurrogate(string value)
    {
        for (var i = 0; i < value.Length; i++)
        {
            var c = value[i];
            if (char.IsHighSurrogate(c))
            {
                if (i + 1 < value.Length && char.IsLowSurrogate(value[i + 1]))
                {
                    i++;
                    continue;
                }

                return true;
            }

            if (char.IsLowSurrogate(c))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>True when the text contains a C0/C1 control character other than tab, CR or LF.</summary>
    public static bool HasDisallowedControlCharacter(string value)
    {
        foreach (var c in value)
        {
            if (char.IsControl(c) && c != '\t' && c != '\r' && c != '\n')
            {
                return true;
            }
        }

        return false;
    }

    private static string ReplaceLoneSurrogates(string value)
    {
        if (!HasLoneSurrogate(value))
        {
            return value;
        }

        var builder = new StringBuilder(value.Length);
        for (var i = 0; i < value.Length; i++)
        {
            var c = value[i];
            if (char.IsHighSurrogate(c) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1]))
            {
                builder.Append(c).Append(value[i + 1]);
                i++;
            }
            else if (char.IsSurrogate(c))
            {
                builder.Append('�');
            }
            else
            {
                builder.Append(c);
            }
        }

        return builder.ToString();
    }
}
