namespace Arch.CadConnect.Core.Bom;

// ============================================================
// BOM Phase 1 - COM-free bill-of-materials model.
//
// Filled by the (future) Inventor-side reader from an assembly's BOM views and
// consumed by validation, canonical hashing and CSV export. Nothing here
// touches Inventor, the file system, the network or the PLM server.
//
// Quantities and masses are System.Decimal (never double) so values such as
// 0.1 or 1.50 are carried exactly. Units are kept exactly as reported - they
// are never converted or guessed.
// ============================================================

/// <summary>Which Inventor BOM view an extract was read from.</summary>
public enum BomViewType
{
    /// <summary>The Structured view with all levels expanded (rows may have children).</summary>
    StructuredAllLevels,

    /// <summary>The Parts Only view (a flat list; rows never have children).</summary>
    PartsOnly,
}

/// <summary>The BOM structure Inventor assigns to a component.</summary>
public enum BomStructure
{
    Normal,
    Purchased,
    Phantom,
    Reference,
    Inseparable,

    /// <summary>The reader could not determine the structure.</summary>
    Unknown,
}

/// <summary>A quantity and its unit exactly as reported (for example 2 "Each", 1250.5 "mm").</summary>
public sealed record BomQuantity(decimal Value, string? Unit);

/// <summary>A mass and its unit exactly as reported (for example 1.25 "kg").</summary>
public sealed record BomMass(decimal Value, string? Unit);

/// <summary>
/// The document a BOM row comes from. Only the file NAME is kept - never a
/// local absolute path - so an extract (and its hash) does not depend on the
/// machine or workspace it was read on.
/// </summary>
/// <param name="FileName">The component's file name, for example "bracket.ipt"; null for a virtual component.</param>
/// <param name="IsResolved">False when the component's file could not be found or loaded.</param>
/// <param name="IsVirtual">True for a virtual component, which legitimately has no file.</param>
public sealed record BomSourceDocument(string? FileName, bool IsResolved, bool IsVirtual)
{
    /// <summary>A resolved, file-backed component.</summary>
    public static BomSourceDocument Resolved(string fileName) => new(fileName, IsResolved: true, IsVirtual: false);

    /// <summary>A component whose file could not be found or loaded.</summary>
    public static BomSourceDocument Unresolved(string? fileName) => new(fileName, IsResolved: false, IsVirtual: false);

    /// <summary>A virtual component (no file).</summary>
    public static BomSourceDocument Virtual() => new(null, IsResolved: true, IsVirtual: true);
}

/// <summary>One BOM row. In a Structured view a row may have child rows.</summary>
public sealed record BomRow
{
    /// <summary>The item number Inventor shows for the row (for example "3" or "3.2").</summary>
    public string? ItemNumber { get; init; }

    public string? PartNumber { get; init; }

    public string? Description { get; init; }

    public required BomQuantity Quantity { get; init; }

    public string? Material { get; init; }

    /// <summary>Null when no mass is available.</summary>
    public BomMass? Mass { get; init; }

    public BomStructure Structure { get; init; } = BomStructure.Normal;

    public required BomSourceDocument Source { get; init; }

    /// <summary>Child rows (Structured view only).</summary>
    public IReadOnlyList<BomRow> Children { get; init; } = [];

    /// <summary>True when Inventor marks the component as Purchased.</summary>
    public bool IsPurchased => Structure == BomStructure.Purchased;
}

/// <summary>One BOM view read from one assembly.</summary>
public sealed record BomExtract
{
    public required BomViewType ViewType { get; init; }

    /// <summary>The assembly's file name (no path).</summary>
    public string? RootFileName { get; init; }

    /// <summary>The assembly's own part number.</summary>
    public string? RootPartNumber { get; init; }

    /// <summary>The top-level rows.</summary>
    public required IReadOnlyList<BomRow> Rows { get; init; }
}

/// <summary>
/// Thrown when an extract cannot be processed safely at all: a reference
/// cycle, more rows or deeper nesting than allowed, an empty (null) or
/// incomplete row, or (for hashing and CSV export) a source file name that is
/// not a plain file name. <see cref="BomValidator"/> reports the same
/// problems as issues instead of throwing.
/// </summary>
public sealed class BomIntegrityException : Exception
{
    public BomIntegrityException(IReadOnlyList<BomIssue> issues)
        : base("The BOM extract cannot be processed: " + string.Join("; ", issues.Select(i => i.Message)))
    {
        Issues = issues;
    }

    /// <summary>The problems found (at least one).</summary>
    public IReadOnlyList<BomIssue> Issues { get; }
}

/// <summary>A row together with its position in the hierarchy.</summary>
public sealed class BomRowEntry
{
    private readonly BomGraphEntry _entry;

    internal BomRowEntry(BomGraphEntry entry) => _entry = entry;

    /// <summary>The row.</summary>
    public BomRow Row => _entry.Node.Row;

    /// <summary>1 for a top-level row, 2 for its children, and so on.</summary>
    public int Level => _entry.Level;

    /// <summary>The row's position among its siblings in canonical order (0-based).</summary>
    public int SiblingIndex => _entry.SiblingIndex;

    /// <summary>
    /// A stable location for messages, for example "3/3.2" (item numbers from
    /// the top level down). Built on demand from the parent chain - entries
    /// store only a parent reference - so traversing a deep BOM never holds a
    /// full path per row in memory.
    /// </summary>
    public string Path => _entry.Path;
}
