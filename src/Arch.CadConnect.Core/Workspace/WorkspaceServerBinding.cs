using System.Text.Json;

using Arch.CadConnect.Core.Session;

namespace Arch.CadConnect.Core.Workspace;

public enum WorkspaceServerBindingVerdict
{
    /// <summary>The workspace was materialized from EXACTLY the server this
    ///  client is signed in to - the operation may proceed.</summary>
    Allowed,

    /// <summary>No signed-in server to compare against.</summary>
    NotSignedIn,

    /// <summary>The document is not inside a managed workspace (no
    ///  <c>.arch\workspace.json</c> above it).</summary>
    NoWorkspace,

    /// <summary>A manifest file exists but cannot be read or is not an Arch
    ///  workspace manifest - its server binding cannot be established.</summary>
    ManifestUnreadable,

    /// <summary>The manifest records no server origin.</summary>
    NoRecordedServer,

    /// <summary>The manifest's recorded server origin is not a valid Arch
    ///  server address.</summary>
    InvalidRecordedServer,

    /// <summary>The workspace belongs to a DIFFERENT server than the one this
    ///  client is signed in to.</summary>
    DifferentServer,
}

public sealed record WorkspaceServerBindingResult(
    WorkspaceServerBindingVerdict Verdict,
    string Message,
    string? WorkspaceRoot,
    string? WorkspaceServerOrigin,
    string? ConnectedServerOrigin)
{
    public bool Allowed => Verdict == WorkspaceServerBindingVerdict.Allowed;
}

/// <summary>
/// P6 M4.1: the SERVER-ORIGIN GUARD. A workspace manifest records the server
/// it was materialized from (<c>serverOrigin</c>); every identity, version and
/// checkout in it is only meaningful on THAT server. A document-scoped
/// operation therefore may run ONLY when the workspace's recorded origin is
/// EXACTLY the origin of the server this client is signed in to.
///
/// Live defect this closes (M3 acceptance): after signing in to an isolated
/// scratch server, a Checkout and a drawing-association lookup for a document
/// in a PRODUCTION workspace were sent to the scratch server - the client
/// never compared the workspace's origin with the connected server.
///
/// FAIL CLOSED: anything other than an exact, readable, valid match is a
/// refusal - not signed in, no workspace, an unreadable manifest, a missing or
/// invalid recorded origin, or a different origin. Origins are compared as
/// scheme + host + port, case-insensitively; aliases are NOT equated
/// (<c>localhost</c> is not <c>127.0.0.1</c>) because nothing proves they are
/// the same server. PURE apart from reading the one manifest file.
/// </summary>
public static class WorkspaceServerBinding
{
    /// <summary>The pure comparison of a recorded origin with the connected
    ///  server.</summary>
    public static WorkspaceServerBindingResult Evaluate(string? recordedOrigin, ArchServerUri? connected, string? workspaceRoot)
    {
        if (connected is null)
        {
            return Result(WorkspaceServerBindingVerdict.NotSignedIn,
                "Sign in to the Arch PLM server this workspace belongs to before running this command.",
                workspaceRoot, recordedOrigin, null);
        }
        if (string.IsNullOrWhiteSpace(recordedOrigin))
        {
            return Result(WorkspaceServerBindingVerdict.NoRecordedServer,
                $"The workspace \"{workspaceRoot}\" does not record which Arch PLM server it belongs to, so it cannot be "
                + $"used with {connected.OriginString}. Run Get Latest into a new, empty workspace folder from the intended server.",
                workspaceRoot, null, connected.OriginString);
        }
        if (!ArchServerUri.TryParse(recordedOrigin, out var recorded) || recorded is null)
        {
            return Result(WorkspaceServerBindingVerdict.InvalidRecordedServer,
                $"The workspace \"{workspaceRoot}\" records an invalid Arch PLM server (\"{recordedOrigin}\") - refusing to use it.",
                workspaceRoot, recordedOrigin, connected.OriginString);
        }
        if (!string.Equals(recorded.OriginString, connected.OriginString, StringComparison.OrdinalIgnoreCase))
        {
            return Result(WorkspaceServerBindingVerdict.DifferentServer,
                $"This workspace belongs to {recorded.OriginString}, but you are signed in to {connected.OriginString}. "
                + "Nothing was sent to the server. Sign in to the workspace's own server, or use a workspace that belongs to "
                + "the current one.",
                workspaceRoot, recorded.OriginString, connected.OriginString);
        }
        return Result(WorkspaceServerBindingVerdict.Allowed, "", workspaceRoot, recorded.OriginString, connected.OriginString);
    }

    /// <summary>For a command on a document in an EXISTING managed workspace:
    ///  the manifest must exist, be readable, and record exactly the connected
    ///  server.</summary>
    public static WorkspaceServerBindingResult CheckWorkspace(string? workspaceRoot, ArchServerUri? connected)
    {
        if (string.IsNullOrWhiteSpace(workspaceRoot) || !Path.IsPathFullyQualified(workspaceRoot))
        {
            return Result(WorkspaceServerBindingVerdict.NoWorkspace,
                "This document is not in an Arch PLM workspace. Open it from a workspace created by Get Latest.",
                workspaceRoot, null, connected?.OriginString);
        }
        var read = ReadRecordedOrigin(workspaceRoot);
        return read.Verdict is { } failure
            ? Result(failure, read.Message!, workspaceRoot, null, connected?.OriginString)
            : Evaluate(read.Origin, connected, workspaceRoot);
    }

    /// <summary>For the TARGET folder of Get Latest: a folder with NO manifest
    ///  is a new workspace and may be bound to the connected server; a folder
    ///  that already has one may only be refreshed from the SAME server - Get
    ///  Latest from another server would otherwise silently re-bind it and mix
    ///  two servers' identities in one workspace.</summary>
    public static WorkspaceServerBindingResult CheckGetLatestTarget(string? workspaceRoot, ArchServerUri? connected)
    {
        if (connected is null)
        {
            return Evaluate(null, null, workspaceRoot);
        }
        if (string.IsNullOrWhiteSpace(workspaceRoot) || !Path.IsPathFullyQualified(workspaceRoot))
        {
            return Result(WorkspaceServerBindingVerdict.NoWorkspace,
                "Choose a full workspace folder path for Get Latest.", workspaceRoot, null, connected.OriginString);
        }
        if (!File.Exists(ManifestPath(workspaceRoot)))
        {
            return Result(WorkspaceServerBindingVerdict.Allowed, "", workspaceRoot, null, connected.OriginString);
        }
        return CheckWorkspace(workspaceRoot, connected);
    }

    /// <summary>Get Latest ADMISSION: <see cref="CheckGetLatestTarget"/>, and
    ///  ONLY when it allows the folder, <paramref name="rememberWorkspaceRoot"/>
    ///  (the "last workspace folder" preference). A refused folder is never
    ///  remembered - the remembered root also decides which workspace other
    ///  commands treat as current, so remembering a refused, other-server
    ///  folder would leak the refusal into later commands (M4.1 T4 finding).
    ///  Nothing is sent to any server here.</summary>
    public static WorkspaceServerBindingResult AdmitGetLatestTarget(
        string? workspaceRoot,
        ArchServerUri? connected,
        Action<string> rememberWorkspaceRoot)
    {
        ArgumentNullException.ThrowIfNull(rememberWorkspaceRoot);
        var result = CheckGetLatestTarget(workspaceRoot, connected);
        if (result.Allowed)
        {
            rememberWorkspaceRoot(workspaceRoot!);
        }
        return result;
    }

    /// <summary>ADMISSION for a command on an EXISTING workspace whose dialog
    ///  remembers folders (Resume / Verify Copy Design):
    ///  <see cref="CheckWorkspace"/>, and ONLY when it allows the workspace,
    ///  <paramref name="rememberSettings"/>. A refused workspace never changes
    ///  the remembered settings (M4.1 T5 finding - the same rule as
    ///  <see cref="AdmitGetLatestTarget"/>). Nothing is sent to any server
    ///  here.</summary>
    public static WorkspaceServerBindingResult AdmitWorkspace(
        string? workspaceRoot,
        ArchServerUri? connected,
        Action rememberSettings)
    {
        ArgumentNullException.ThrowIfNull(rememberSettings);
        var result = CheckWorkspace(workspaceRoot, connected);
        if (result.Allowed)
        {
            rememberSettings();
        }
        return result;
    }

    private static string ManifestPath(string workspaceRoot) =>
        Path.Combine(Path.GetFullPath(workspaceRoot), WorkspaceManifest.RelativeManifestPath);

    private static (string? Origin, WorkspaceServerBindingVerdict? Verdict, string? Message) ReadRecordedOrigin(string workspaceRoot)
    {
        string path;
        try
        {
            path = ManifestPath(workspaceRoot);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return (null, WorkspaceServerBindingVerdict.NoWorkspace, $"\"{workspaceRoot}\" is not a valid workspace folder.");
        }
        if (!File.Exists(path))
        {
            return (null, WorkspaceServerBindingVerdict.NoWorkspace,
                $"\"{workspaceRoot}\" is not an Arch PLM workspace (no workspace manifest). Open the document from a workspace created by Get Latest.");
        }
        try
        {
            using var json = JsonDocument.Parse(File.ReadAllText(path));
            var root = json.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("schema", out var schema)
                || schema.ValueKind != JsonValueKind.String
                || schema.GetString() != WorkspaceManifest.SchemaId)
            {
                return (null, WorkspaceServerBindingVerdict.ManifestUnreadable,
                    $"The workspace manifest in \"{workspaceRoot}\" is not a valid Arch PLM workspace manifest - refusing to use it.");
            }
            var origin = root.TryGetProperty("serverOrigin", out var value) && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
            return (origin, null, null);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return (null, WorkspaceServerBindingVerdict.ManifestUnreadable,
                $"The workspace manifest in \"{workspaceRoot}\" could not be read ({ex.GetType().Name}) - refusing to use it.");
        }
    }

    private static WorkspaceServerBindingResult Result(
        WorkspaceServerBindingVerdict verdict, string message, string? root, string? recorded, string? connected) =>
        new(verdict, message, root, recorded, connected);
}
