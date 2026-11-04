namespace Arch.CadConnect.Core.Documents;

/// <summary>
/// P6 M4.4 Package C: a CAD editor's open documents, read so that only a
/// complete, successful look can say "closed". A document that matches wins
/// over any failure; any failure that leaves the answer open is
/// <see cref="EditorDocumentState.Unknown"/>. Free of the editor's API so the
/// failure rules are tested here, with the real exception types.
/// </summary>
public static class EditorDocumentScan
{
    /// <param name="openDocuments">The editor's top-level documents.</param>
    /// <param name="fileName">A document's on-disk path; blank for a document
    ///  never saved, which can match no file.</param>
    /// <param name="referencedDocuments">The documents one document loads.</param>
    public static EditorDocumentState Inspect<TDocument>(
        string? absoluteFilePath,
        Func<IEnumerable<TDocument>> openDocuments,
        Func<TDocument, string?> fileName,
        Func<TDocument, IEnumerable<TDocument>> referencedDocuments)
    {
        ArgumentNullException.ThrowIfNull(openDocuments);
        ArgumentNullException.ThrowIfNull(fileName);
        ArgumentNullException.ThrowIfNull(referencedDocuments);

        if (string.IsNullOrWhiteSpace(absoluteFilePath))
        {
            return EditorDocumentState.Unknown;
        }

        string target;
        try
        {
            target = Path.GetFullPath(absoluteFilePath);
        }
        catch (Exception)
        {
            return EditorDocumentState.Unknown;
        }

        var complete = true;

        bool Matches(TDocument document)
        {
            try
            {
                var name = fileName(document);
                return !string.IsNullOrWhiteSpace(name)
                    && string.Equals(Path.GetFullPath(name), target, StringComparison.OrdinalIgnoreCase);
            }
            catch (Exception)
            {
                complete = false;
                return false;
            }
        }

        try
        {
            foreach (var document in openDocuments())
            {
                if (Matches(document))
                {
                    return EditorDocumentState.Open;
                }
                try
                {
                    foreach (var referenced in referencedDocuments(document))
                    {
                        if (Matches(referenced))
                        {
                            return EditorDocumentState.Open;
                        }
                    }
                }
                catch (Exception)
                {
                    complete = false;
                }
            }
        }
        catch (Exception)
        {
            return EditorDocumentState.Unknown;
        }

        return complete ? EditorDocumentState.Closed : EditorDocumentState.Unknown;
    }
}
