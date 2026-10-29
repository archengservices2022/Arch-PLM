using System.Globalization;
using System.Text.RegularExpressions;

namespace Arch.CadConnect.Core.Diagnostics;

/// <summary>
/// M4.2: turns an allow-listed field value into what may be written. Every
/// kind fails closed - a value that does not look like its kind is replaced
/// by a marker rather than written as-is. PURE.
/// </summary>
public static partial class DiagnosticValueSanitizer
{
    /// <summary>Text is only ever a document number now - capped short.</summary>
    public const int MaxTextLength = 128;
    public const int MaxPathLength = 400;
    public const string Invalid = "[invalid]";

    [GeneratedRegex(@"^[A-Za-z0-9._:\-]{1,200}$")]
    private static partial Regex IdPattern();

    [GeneratedRegex(@"^[A-Za-z0-9 ._\-]{1,64}$")]
    private static partial Regex CodePattern();

    [GeneratedRegex(@"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")]
    private static partial Regex EmailPattern();

    [GeneratedRegex(@"(?i)\bbearer\s+[^\s""',;]+")]
    private static partial Regex BearerPattern();

    [GeneratedRegex(@"\beyJ[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}(\.[A-Za-z0-9_\-]*)?")]
    private static partial Regex JwtPattern();

    /// <summary><c>name: value</c> / <c>name=value</c> for a secret-bearing
    ///  name; an authentication scheme word before the value (<c>Basic</c>,
    ///  <c>Bearer</c>...) is consumed too, so the credential after it goes.</summary>
    [GeneratedRegex(@"(?i)\b(authorization|password|passwd|pwd|secret|token|access[_\-]?token|refresh[_\-]?token|session[_\-]?token|api[_\-]?key|cookie)\b\s*[:=]\s*(?:(?:basic|bearer|digest|negotiate|ntlm)\s+)?[^\s,;]+")]
    private static partial Regex SecretAssignmentPattern();

    /// <summary>This client's own desktop session tokens, wherever they appear.</summary>
    [GeneratedRegex(@"(?i)\barch_dt_[A-Za-z0-9_\-]+")]
    private static partial Regex SessionTokenPattern();

    /// <summary>Any <c>X:\Users\&lt;name&gt;</c> - at the start of a path or
    ///  anywhere inside client text.</summary>
    [GeneratedRegex(@"(?i)\b[A-Z]:\\Users\\[^\\\s""']+")]
    private static partial Regex UserProfilePrefixPattern();

    /// <summary>Returns the sanitized value (string, long or bool), or
    ///  <c>null</c> when the input was null.</summary>
    public static object? Sanitize(DiagnosticField field, string? userProfile = null) => field.Kind switch
    {
        DiagnosticFieldKind.Id => SanitizeId(field.Value as string),
        DiagnosticFieldKind.Origin => SanitizeOrigin(field.Value as string),
        DiagnosticFieldKind.Path => SanitizePath(field.Value as string, userProfile),
        DiagnosticFieldKind.Code => SanitizeCode(field.Value as string),
        DiagnosticFieldKind.Text => SanitizeText(field.Value as string),
        DiagnosticFieldKind.Number => field.Value is long n ? n : null,
        DiagnosticFieldKind.Flag => field.Value is bool b ? b : null,
        _ => null,
    };

    public static string? SanitizeId(string? value) =>
        value is null ? null : IdPattern().IsMatch(value) ? value : Invalid;

    /// <summary>A code is a short token or nothing - never a sentence, so a
    ///  message can never be smuggled in as a "code".</summary>
    public static string? SanitizeCode(string? value) =>
        value is null ? null : CodePattern().IsMatch(value) ? value : Invalid;

    public static string? SanitizeOrigin(string? value)
    {
        if (value is null) return null;
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            return Invalid;
        }
        // Scheme, host and port only - never user info, path or query.
        return uri.GetLeftPart(UriPartial.Scheme) + uri.Host.ToLowerInvariant()
            + (uri.IsDefaultPort ? "" : ":" + uri.Port.ToString(CultureInfo.InvariantCulture));
    }

    public static string? SanitizePath(string? value, string? userProfile = null)
    {
        if (value is null) return null;
        var path = OneLine(value);
        if (!string.IsNullOrEmpty(userProfile) && path.StartsWith(userProfile, StringComparison.OrdinalIgnoreCase))
        {
            path = "%USERPROFILE%" + path[userProfile.Length..];
        }
        return Cap(Scrub(path), MaxPathLength);
    }

    public static string? SanitizeText(string? value) =>
        value is null ? null : Cap(Scrub(OneLine(value)), MaxTextLength);

    /// <summary>Applied to both paths and text: credentials, tokens, emails
    ///  and the user-profile folder name never survive.</summary>
    private static string Scrub(string text)
    {
        text = SessionTokenPattern().Replace(text, "[redacted-token]");
        text = BearerPattern().Replace(text, "Bearer [redacted]");
        text = JwtPattern().Replace(text, "[redacted-token]");
        text = SecretAssignmentPattern().Replace(text, m => m.Groups[1].Value + "=[redacted]");
        text = EmailPattern().Replace(text, "[email]");
        return UserProfilePrefixPattern().Replace(text, "%USERPROFILE%");
    }

    private static string OneLine(string value)
    {
        var chars = value.ToCharArray();
        for (var i = 0; i < chars.Length; i++)
        {
            if (char.IsControl(chars[i])) chars[i] = ' ';
        }
        return new string(chars);
    }

    private static string Cap(string value, int max) => value.Length <= max ? value : value[..max] + "…";
}
