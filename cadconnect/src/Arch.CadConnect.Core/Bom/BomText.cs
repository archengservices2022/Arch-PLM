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
