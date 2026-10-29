namespace Arch.CadConnect.Core.Diagnostics;

/// <summary>How a diagnostic field's value is sanitized before it is written
///  (see <see cref="DiagnosticValueSanitizer"/>).</summary>
public enum DiagnosticFieldKind
{
    /// <summary>An opaque identifier (operation id, idempotency key, cad
    ///  document id, internal user id...). Must look like one.</summary>
    Id,

    /// <summary>A server origin; reduced to scheme://host:port.</summary>
    Origin,

    /// <summary>A local file-system path; the user-profile part is masked.</summary>
    Path,

    /// <summary>A fixed-vocabulary code chosen by THIS client - an outcome or
    ///  error code, a phase or step name, a verdict, an exception TYPE name,
    ///  a command name. Must be a short token (letters, digits, space and
    ///  <c>. _ -</c>); anything else is replaced, so no message text can
    ///  ever ride in a code field.</summary>
    Code,

    /// <summary>The one free-text value kept: a CAD document number the
    ///  engineer typed or the server assigned. Scrubbed of anything
    ///  credential- or email-shaped and capped short. Never a message.</summary>
    Text,

    Number,
    Flag,
}

/// <summary>One named value of a diagnostic event. Created only through the
///  typed factories; the name must also be on <see cref="DiagnosticFieldAllowList"/>
///  for its kind, or the field is dropped when the event is written.</summary>
public readonly record struct DiagnosticField(string Name, DiagnosticFieldKind Kind, object? Value)
{
    public static DiagnosticField Id(string name, string? value) => new(name, DiagnosticFieldKind.Id, value);
    public static DiagnosticField Origin(string name, string? value) => new(name, DiagnosticFieldKind.Origin, value);
    public static DiagnosticField Path(string name, string? value) => new(name, DiagnosticFieldKind.Path, value);
    public static DiagnosticField Code(string name, string? value) => new(name, DiagnosticFieldKind.Code, value);
    public static DiagnosticField Text(string name, string? value) => new(name, DiagnosticFieldKind.Text, value);
    public static DiagnosticField Number(string name, long? value) => new(name, DiagnosticFieldKind.Number, value);
    public static DiagnosticField Flag(string name, bool? value) => new(name, DiagnosticFieldKind.Flag, value);
}

/// <summary>
/// M4.2: the EXPLICIT allow-list of diagnostic fields - name and kind. Any
/// other field is dropped (and counted) by the writer, so nothing reaches a
/// log merely because some caller passed it. There is deliberately no field
/// for an account email, a name, a token, a password, an Authorization
/// header, a session secret, a request/response body, file contents - or any
/// free-form reason/message: failures are described by codes and phases
/// only, never by server or exception text (even scrubbed).
/// </summary>
public static class DiagnosticFieldAllowList
{
    private static readonly Dictionary<string, DiagnosticFieldKind> Allowed = new(StringComparer.Ordinal)
    {
        // identifiers
        ["operationId"] = DiagnosticFieldKind.Id,
        ["idempotencyKey"] = DiagnosticFieldKind.Id,
        ["cadDocumentId"] = DiagnosticFieldKind.Id,
        ["resultingCadDocumentId"] = DiagnosticFieldKind.Id,
        ["rootCadDocumentId"] = DiagnosticFieldKind.Id,
        ["fileVersionId"] = DiagnosticFieldKind.Id,
        ["userId"] = DiagnosticFieldKind.Id,
        ["organizationId"] = DiagnosticFieldKind.Id,
        ["fingerprint"] = DiagnosticFieldKind.Id,
        // servers
        ["serverOrigin"] = DiagnosticFieldKind.Origin,
        ["workspaceServerOrigin"] = DiagnosticFieldKind.Origin,
        ["connectedServerOrigin"] = DiagnosticFieldKind.Origin,
        ["boundServerOrigin"] = DiagnosticFieldKind.Origin,
        ["currentServerOrigin"] = DiagnosticFieldKind.Origin,
        // local paths (sanitized)
        ["workspaceRoot"] = DiagnosticFieldKind.Path,
        ["path"] = DiagnosticFieldKind.Path,
        ["rootPath"] = DiagnosticFieldKind.Path,
        ["destinationPath"] = DiagnosticFieldKind.Path,
        ["recoveryPath"] = DiagnosticFieldKind.Path,
        // fixed-vocabulary codes
        ["command"] = DiagnosticFieldKind.Code,
        ["step"] = DiagnosticFieldKind.Code,
        ["phase"] = DiagnosticFieldKind.Code,
        ["verdict"] = DiagnosticFieldKind.Code,
        ["outcome"] = DiagnosticFieldKind.Code,
        ["errorCode"] = DiagnosticFieldKind.Code,
        ["failureKind"] = DiagnosticFieldKind.Code,
        ["exceptionType"] = DiagnosticFieldKind.Code,
        ["attemptKind"] = DiagnosticFieldKind.Code,
        ["action"] = DiagnosticFieldKind.Code,
        ["documentType"] = DiagnosticFieldKind.Code,
        ["materialization"] = DiagnosticFieldKind.Code,
        ["source"] = DiagnosticFieldKind.Code,
        // M4.4 multi-instance locks
        ["lockScope"] = DiagnosticFieldKind.Code,
        ["lockMode"] = DiagnosticFieldKind.Code,
        ["pathLocality"] = DiagnosticFieldKind.Code,
        // the only free text: a sanitized, short document number
        ["documentNumber"] = DiagnosticFieldKind.Text,
        // numbers
        ["entryCount"] = DiagnosticFieldKind.Number,
        ["copyCount"] = DiagnosticFieldKind.Number,
        ["versionNumber"] = DiagnosticFieldKind.Number,
        ["requested"] = DiagnosticFieldKind.Number,
        ["downloaded"] = DiagnosticFieldKind.Number,
        ["alreadyCurrent"] = DiagnosticFieldKind.Number,
        ["blocked"] = DiagnosticFieldKind.Number,
        ["failed"] = DiagnosticFieldKind.Number,
        ["removed"] = DiagnosticFieldKind.Number,
        ["durationMs"] = DiagnosticFieldKind.Number,
        ["lockCount"] = DiagnosticFieldKind.Number,
        ["holderProcessId"] = DiagnosticFieldKind.Number,
        // flags
        ["physicallyCreated"] = DiagnosticFieldKind.Flag,
        ["verificationPassed"] = DiagnosticFieldKind.Flag,
        ["verified"] = DiagnosticFieldKind.Flag,
        ["restored"] = DiagnosticFieldKind.Flag,
        ["madeWritable"] = DiagnosticFieldKind.Flag,
        ["madeControlled"] = DiagnosticFieldKind.Flag,
        ["manifestUpdated"] = DiagnosticFieldKind.Flag,
        ["reconcileNeeded"] = DiagnosticFieldKind.Flag,
        ["reservedButUnmaterialized"] = DiagnosticFieldKind.Flag,
    };

    public static bool IsAllowed(DiagnosticField field) =>
        field.Name is not null && Allowed.TryGetValue(field.Name, out var kind) && kind == field.Kind;

    public static IReadOnlyCollection<string> Names => Allowed.Keys;
}
