namespace Arch.CadConnect.Core.Documents;

/// <summary>
/// Answers "is this exact local file currently open in the CAD editor?" - used
/// as an Undo pre-flight so the working file is known to be replaceable BEFORE
/// the server checkout is released. The Inventor layer implements this against
/// <c>Application.Documents</c>; Core / Api / tests use
/// <see cref="NoEditorProbe"/> (nothing is open) or a fake.
/// </summary>
public interface IEditorDocumentProbe
{
    /// <summary>True when a document whose on-disk path equals
    ///  <paramref name="absoluteFilePath"/> (case-insensitive) is open in the
    ///  editor right now.</summary>
    bool IsOpenForEditing(string absoluteFilePath);
}

/// <summary>P6 M4.4 Package C: what a look at the editor could establish.</summary>
public enum EditorDocumentState
{
    Closed,
    Open,

    /// <summary>The editor could not be read completely, so this is NOT proof
    ///  the document is closed.</summary>
    Unknown,
}

/// <summary>P6 M4.4 Package C: <see cref="IEditorDocumentProbe"/> for a caller
///  that must tell "closed" from "could not tell". Get Latest changes a stale
///  checkout's file only on <see cref="EditorDocumentState.Closed"/>; Undo
///  Checkout keeps its own probe.</summary>
public interface IEditorDocumentStateProbe
{
    EditorDocumentState GetDocumentState(string absoluteFilePath);
}

/// <summary>The default: assume nothing is open (non-Inventor contexts and
///  tests). The filesystem exclusive-open probe in
///  <c>ManagedFileGuard.CanReplaceInPlace</c> still guards the real case.</summary>
public sealed class NoEditorProbe : IEditorDocumentProbe, IEditorDocumentStateProbe
{
    public static readonly NoEditorProbe Instance = new();
    public bool IsOpenForEditing(string absoluteFilePath) => false;
    public EditorDocumentState GetDocumentState(string absoluteFilePath) => EditorDocumentState.Closed;
}
