using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Arch.CadConnect.Core.Bom;

/// <summary>
/// The ONE definition of canonical row order, used by hashing, CSV export and
/// validation alike: depth-first, parent before children, siblings in the
/// total order of <see cref="BomGraph"/> (item number, then part number,
/// then the row's own content, then its subtree's content). The order is a
/// function of content only - never of the order the reader delivered rows in.
/// </summary>
public static class BomTraversal
{
    /// <summary>
    /// Every row of the extract in canonical order, with level and path.
    /// </summary>
    /// <exception cref="BomIntegrityException">A cycle, a null or incomplete
    /// row, or more rows / deeper nesting than <see cref="BomValidator.MaxRows"/>
    /// / <see cref="BomValidator.MaxDepth"/> allow.</exception>
    public static IReadOnlyList<BomRowEntry> Flatten(BomExtract extract)
    {
        ArgumentNullException.ThrowIfNull(extract);
        return BomGraph.Build(extract).Entries.Select(e => new BomRowEntry(e)).ToList();
    }

    /// <summary>The path token for a row: its item number, or "#n" (1-based) when it has none.</summary>
    internal static string PathToken(string? normalizedItem, int siblingIndex) =>
        normalizedItem ?? "#" + (siblingIndex + 1).ToString(CultureInfo.InvariantCulture);

    /// <summary>
    /// A transitive total order on item numbers. The text is split on '.';
    /// segments compare as (kind, value): all-digit segments first, by numeric
    /// value (any length, leading zeros ignored), then other segments
    /// ordinally. A shorter segment list that is a prefix sorts first. Only
    /// if every segment is equal by value do leading zeros decide (shorter
    /// text first, then ordinal), so two different strings never compare
    /// equal. Null sorts after any value.
    /// Examples: "1" &lt; "01" &lt; "1.9" &lt; "1.10" &lt; "2" &lt; "10" &lt; "1A" &lt; "A".
    /// </summary>
    internal static int CompareItemNumbers(string? a, string? b)
    {
        if (a is null || b is null)
        {
            return a is null ? (b is null ? 0 : 1) : -1;
        }

        var left = a.Split('.');
        var right = b.Split('.');
        var common = Math.Min(left.Length, right.Length);
        for (var i = 0; i < common; i++)
        {
            var result = CompareSegment(left[i], right[i]);
            if (result != 0)
            {
                return result;
            }
        }

        var bySegments = left.Length.CompareTo(right.Length);
        if (bySegments != 0)
        {
            return bySegments;
        }

        var byLength = a.Length.CompareTo(b.Length);
        return byLength != 0 ? byLength : string.CompareOrdinal(a, b);
    }

    private static int CompareSegment(string a, string b)
    {
        var aDigits = IsDigits(a);
        var bDigits = IsDigits(b);
        if (aDigits != bDigits)
        {
            return aDigits ? -1 : 1; // numeric segments before text segments
        }

        if (aDigits)
        {
            var ta = a.TrimStart('0');
            var tb = b.TrimStart('0');
            return ta.Length != tb.Length ? ta.Length.CompareTo(tb.Length) : string.CompareOrdinal(ta, tb);
        }

        return string.CompareOrdinal(a, b);
    }

    private static bool IsDigits(string value) => value.Length > 0 && value.All(c => c is >= '0' and <= '9');
}

/// <summary>A row in the verified, snapshotted BOM graph.</summary>
internal sealed class BomNode(BomRow row, string selfKey, string? item, string? part)
{
    public BomRow Row { get; } = row;

    /// <summary>The row's own canonical fields (see BomCanonicalSerializer.RowFields).</summary>
    public string SelfKey { get; } = selfKey;

    public string? Item { get; } = item;

    public string? Part { get; } = part;

    /// <summary>Children in canonical order.</summary>
    public BomNode[] Children { get; set; } = [];

    /// <summary>Lowercase-hex SHA-256 over this row's fields and its ordered subtree.</summary>
    public string Digest { get; set; } = "";
}

/// <summary>
/// One occurrence of a node in canonical depth-first order. Stores only a
/// reference to its parent occurrence - never a path string - so memory is
/// O(rows), not O(rows x depth). <see cref="Path"/> is built on demand
/// (O(depth)) and only callers that need it (issue messages, public
/// <see cref="BomRowEntry.Path"/>) pay for it.
/// </summary>
internal sealed class BomGraphEntry(BomNode node, int level, int siblingIndex, BomGraphEntry? parent)
{
    public BomNode Node { get; } = node;

    public int Level { get; } = level;

    public int SiblingIndex { get; } = siblingIndex;

    public BomGraphEntry? Parent { get; } = parent;

    /// <summary>This occurrence's own path segment.</summary>
    public string Token => BomTraversal.PathToken(Node.Item, SiblingIndex);

    /// <summary>"3/3.2/..." from the top level down, built on demand.</summary>
    public string Path
    {
        get
        {
            var tokens = new string[Level];
            var current = this;
            for (var i = Level - 1; i >= 0 && current is not null; i--)
            {
                tokens[i] = current.Token;
                current = current.Parent;
            }

            return string.Join('/', tokens);
        }
    }
}

/// <summary>
/// A bounded, verified snapshot of a <see cref="BomExtract"/>.
///
/// BUILD (iterative, never recursive):
///  1. Integrity pass - depth-first over the extract with an explicit stack.
///     Before ANY child list is copied or sorted its width is checked against
///     the remaining row budget; every occurrence (a row shared by two parents
///     counts twice) is counted against <see cref="BomValidator.MaxRows"/>;
///     depth is checked against <see cref="BomValidator.MaxDepth"/>; a row that
///     is already on the active ancestor path (by reference) is a cycle; null
///     rows and rows without Quantity / Source are rejected. Each row's
///     children are read ONCE per build (Count read once, each element read
///     once) and that single snapshot is used by every occurrence of the row,
///     by the node and by expansion. A further occurrence of a completed
///     (shared) row is charged with its recorded descendant count and height
///     instead of being traversed or copied again.
///  2. Ordering pass - bottom-up (post-order) on the snapshot: each node's
///     children are sorted by the content-only total order (item number,
///     part number, own canonical fields, subtree digest) and the node's
///     digest is computed. Equal keys therefore mean identical content, so
///     output never depends on input order.
///  3. Entries - canonical depth-first expansion (parent references, lazy
///     paths), re-checking MaxRows and MaxDepth as defense in depth, plus
///     source file-name problems.
/// Structural problems throw <see cref="BomIntegrityException"/>; file-name
/// problems are returned in <see cref="FileNameIssues"/> for the caller to
/// enforce (hashing / CSV) or report (validation).
/// </summary>
internal sealed class BomGraph
{
    private BomGraph(IReadOnlyList<BomGraphEntry> entries, IReadOnlyList<BomIssue> fileNameIssues)
    {
        Entries = entries;
        FileNameIssues = fileNameIssues;
    }

    public IReadOnlyList<BomGraphEntry> Entries { get; }

    public IReadOnlyList<BomIssue> FileNameIssues { get; }

    public static BomGraph Build(BomExtract extract)
    {
        ArgumentNullException.ThrowIfNull(extract);

        // Every occurrence that will be expanded, counted BEFORE expansion.
        long occurrences = 0;
        var rootRows = Snapshot(extract.Rows, ref occurrences, "The BOM");

        // One snapshot of each row's children per build, shared by every
        // occurrence of that row, by the integrity pass, by the node and by
        // expansion - caller collections are read exactly once.
        var snapshots = new Dictionary<BomRow, BomRow[]>(ReferenceEqualityComparer.Instance);

        // Completed rows: their subtree's occurrence count (excluding the row
        // itself) and height. A second occurrence of a completed (shared) row
        // is charged with these instead of being traversed again: its subtree
        // was already verified acyclic and within limits, and any cycle back
        // to a current ancestor would have been found while it was verified.
        var completed = new Dictionary<BomRow, (long Descendants, int Height)>(ReferenceEqualityComparer.Instance);
        var nodes = new Dictionary<BomRow, BomNode>(ReferenceEqualityComparer.Instance);
        var active = new HashSet<BomRow>(ReferenceEqualityComparer.Instance);
        var stack = new Stack<Frame>();
        for (var i = rootRows.Length - 1; i >= 0; i--)
        {
            stack.Push(new Frame(rootRows[i], 1, Exiting: false));
        }

        while (stack.Count > 0)
        {
            var frame = stack.Pop();
            var row = frame.Row;

            if (frame.Exiting)
            {
                active.Remove(row);
                var kids = snapshots[row];
                long descendants = 0;
                var height = 1;
                foreach (var kid in kids)
                {
                    var done = completed[kid];
                    descendants += 1 + done.Descendants;
                    height = Math.Max(height, 1 + done.Height);
                }

                completed[row] = (descendants, height);
                nodes[row] = BuildNode(row, kids, nodes);
                continue;
            }

            if (frame.Level > BomValidator.MaxDepth)
            {
                throw DepthFailure();
            }

            if (completed.TryGetValue(row, out var shared))
            {
                // A further occurrence of an already verified subtree.
                if (frame.Level + shared.Height - 1 > BomValidator.MaxDepth)
                {
                    throw DepthFailure();
                }

                occurrences += shared.Descendants;
                if (occurrences > BomValidator.MaxRows)
                {
                    throw RowsFailure();
                }

                continue;
            }

            if (!active.Add(row))
            {
                throw Fail(BomIssueCode.CyclicHierarchy,
                    "The BOM contains a reference cycle: a row is its own ancestor.");
            }

            if (row.Quantity is null || row.Source is null)
            {
                throw Fail(BomIssueCode.InvalidHierarchy, "A BOM row is incomplete (no quantity or no source document).");
            }

            // First (and only) read of this row's children.
            var children = Snapshot(row.Children, ref occurrences, "A BOM row");
            snapshots[row] = children;
            stack.Push(frame with { Exiting = true });
            for (var i = children.Length - 1; i >= 0; i--)
            {
                stack.Push(new Frame(children[i], frame.Level + 1, Exiting: false));
            }
        }

        var roots = rootRows.Select(r => nodes[r]).ToArray();
        Array.Sort(roots, CompareNodes);
        var entries = BuildEntries(roots);
        return new BomGraph(entries, CheckFileNames(extract, entries));
    }

    /// <summary>The content-only total order on sibling nodes.</summary>
    internal static int CompareNodes(BomNode a, BomNode b)
    {
        var c = BomTraversal.CompareItemNumbers(a.Item, b.Item);
        if (c != 0)
        {
            return c;
        }

        c = (a.Part, b.Part) switch
        {
            (null, null) => 0,
            (null, _) => 1,
            (_, null) => -1,
            _ => string.CompareOrdinal(a.Part, b.Part),
        };
        if (c != 0)
        {
            return c;
        }

        c = string.CompareOrdinal(a.SelfKey, b.SelfKey);
        return c != 0 ? c : string.CompareOrdinal(a.Digest, b.Digest);
    }

    /// <summary>
    /// Copies a caller collection exactly once: Count is read ONCE, checked
    /// against the remaining row budget BEFORE anything is allocated or read,
    /// and each element is read once. A collection that fails or changes
    /// shape while being read is reported, not propagated as a raw exception.
    /// </summary>
    private static BomRow[] Snapshot(IReadOnlyList<BomRow>? rows, ref long occurrences, string owner)
    {
        if (rows is null)
        {
            return [];
        }

        int count;
        try
        {
            count = rows.Count;
        }
        catch (Exception ex) when (ex is InvalidOperationException or NotSupportedException)
        {
            throw ChangedFailure(owner);
        }

        if (count < 0)
        {
            throw ChangedFailure(owner);
        }

        if (count == 0)
        {
            return [];
        }

        // Width check BEFORE allocating, reading or sorting anything.
        if (count > BomValidator.MaxRows - occurrences)
        {
            throw RowsFailure();
        }

        var copy = new BomRow[count];
        for (var i = 0; i < count; i++)
        {
            BomRow? item;
            try
            {
                item = rows[i];
            }
            catch (Exception ex) when (ex is ArgumentOutOfRangeException or IndexOutOfRangeException or InvalidOperationException)
            {
                throw ChangedFailure(owner);
            }

            copy[i] = item ?? throw Fail(BomIssueCode.InvalidHierarchy, $"{owner} contains an empty (null) row.");
        }

        occurrences += count;
        return copy;
    }

    private static BomNode BuildNode(BomRow row, BomRow[] children, Dictionary<BomRow, BomNode> nodes)
    {
        var node = new BomNode(
            row,
            BomCanonicalSerializer.RowFields(row),
            BomText.Normalize(row.ItemNumber),
            BomText.Normalize(row.PartNumber));

        var childNodes = children.Select(c => nodes[c]).ToArray();
        Array.Sort(childNodes, CompareNodes);
        node.Children = childNodes;

        var sb = new StringBuilder(node.SelfKey.Length + (childNodes.Length * 65) + 1);
        sb.Append(node.SelfKey).Append('\u001E');
        foreach (var child in childNodes)
        {
            sb.Append(child.Digest).Append(',');
        }

        node.Digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString()))).ToLowerInvariant();
        return node;
    }

    private static List<BomGraphEntry> BuildEntries(BomNode[] roots)
    {
        var entries = new List<BomGraphEntry>();
        var stack = new Stack<(BomNode Node, int Level, BomGraphEntry? Parent, int Index)>();
        for (var i = roots.Length - 1; i >= 0; i--)
        {
            stack.Push((roots[i], 1, null, i));
        }

        while (stack.Count > 0)
        {
            var (node, level, parent, index) = stack.Pop();

            // Defense in depth: the integrity pass already proved both limits.
            if (level > BomValidator.MaxDepth)
            {
                throw DepthFailure();
            }

            if (entries.Count >= BomValidator.MaxRows)
            {
                throw RowsFailure();
            }

            var entry = new BomGraphEntry(node, level, index, parent);
            entries.Add(entry);
            for (var i = node.Children.Length - 1; i >= 0; i--)
            {
                stack.Push((node.Children[i], level + 1, entry, i));
            }
        }

        return entries;
    }

    private static List<BomIssue> CheckFileNames(BomExtract extract, List<BomGraphEntry> entries)
    {
        var issues = new List<BomIssue>();
        var rootProblem = BomFileName.Problem(extract.RootFileName, required: false);
        if (rootProblem is not null)
        {
            issues.Add(new BomIssue(BomIssueCode.InvalidFileName, BomIssueSeverity.Error, null,
                $"The assembly file name {rootProblem}"));
        }

        foreach (var entry in entries)
        {
            var source = entry.Node.Row.Source;
            var problem = BomFileName.Problem(source.FileName, required: source.IsResolved && !source.IsVirtual);
            if (problem is not null)
            {
                issues.Add(new BomIssue(BomIssueCode.InvalidFileName, BomIssueSeverity.Error, entry.Path,
                    $"The component file name {problem}"));
            }
        }

        return issues;
    }

    private static BomIntegrityException Fail(BomIssueCode code, string message) =>
        new([new BomIssue(code, BomIssueSeverity.Error, null, message)]);

    private static BomIntegrityException DepthFailure() =>
        Fail(BomIssueCode.InvalidHierarchy, $"The BOM is nested deeper than {BomValidator.MaxDepth} levels.");

    private static BomIntegrityException RowsFailure() =>
        Fail(BomIssueCode.TooManyRows, $"The BOM has more than {BomValidator.MaxRows} rows.");

    private static BomIntegrityException ChangedFailure(string owner) =>
        Fail(BomIssueCode.InvalidHierarchy, $"{owner} could not be read consistently (the collection failed or changed while being read).");

    private sealed record Frame(BomRow Row, int Level, bool Exiting);
}

/// <summary>
/// Source file names must be plain file names - never a path. A path is a
/// reader defect, so it is REPORTED, never silently stripped.
/// </summary>
internal static class BomFileName
{
    private const int MaxLength = 255;

    private static readonly char[] InvalidCharacters = ['<', '>', '"', '|', '?', '*'];

    /// <summary>Null when acceptable; otherwise the end of a sentence describing the problem.</summary>
    public static string? Problem(string? raw, bool required)
    {
        if (raw is null || BomText.Normalize(raw) is null)
        {
            return required ? "is missing (a resolved component must name its file)." : null;
        }

        var name = BomText.Normalize(raw)!;
        if (name.Contains('/', StringComparison.Ordinal) || name.Contains('\\', StringComparison.Ordinal))
        {
            return "contains a directory separator; only a file name (no path) is allowed.";
        }

        if (name.Contains(':', StringComparison.Ordinal))
        {
            return "contains ':' (a drive or stream specifier); only a file name is allowed.";
        }

        if (name is "." or "..")
        {
            return "is not a file name.";
        }

        if (name.Length > MaxLength)
        {
            return $"is longer than {MaxLength} characters.";
        }

        if (name.IndexOfAny(InvalidCharacters) >= 0 || name.Any(c => c < ' '))
        {
            return "contains characters that are not allowed in a file name.";
        }

        if (name.EndsWith('.'))
        {
            return "must not end with '.'.";
        }

        return null;
    }
}
