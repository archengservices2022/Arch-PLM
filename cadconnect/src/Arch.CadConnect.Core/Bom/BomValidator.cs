namespace Arch.CadConnect.Core.Bom;

/// <summary>Validation problems a BOM extract can have.</summary>
public enum BomIssueCode
{
    /// <summary>The extract has no rows.</summary>
    EmptyBom,

    /// <summary>A row has no part number.</summary>
    MissingPartNumber,

    /// <summary>A quantity is zero, negative, or fractional for a count unit.</summary>
    InvalidQuantity,

    /// <summary>A quantity (or a reported mass) has no unit.</summary>
    MissingUnit,

    /// <summary>A mass is negative.</summary>
    InvalidMass,

    /// <summary>
    /// The same part number appears more than once among siblings (Structured)
    /// or in the list (Parts Only). A WARNING when the rows have distinct item
    /// numbers (a legitimate unmerged Inventor BOM); an ERROR when the item
    /// numbers are equal or missing, so the rows cannot be told apart. Rows
    /// and quantities are never merged.
    /// </summary>
    DuplicateRow,

    /// <summary>The same item number appears twice among siblings.</summary>
    DuplicateItemNumber,

    /// <summary>A component's file could not be found or loaded.</summary>
    UnresolvedComponent,

    /// <summary>A Parts Only row has children, or the hierarchy is deeper than allowed.</summary>
    InvalidHierarchy,

    /// <summary>The extract has more rows than allowed.</summary>
    TooManyRows,

    /// <summary>A text value contains a lone surrogate or a control character.</summary>
    InvalidText,

    /// <summary>A row is (directly or indirectly) its own ancestor.</summary>
    CyclicHierarchy,

    /// <summary>
    /// A source or assembly file name is not a plain file name (a path, drive,
    /// UNC name, separator, or invalid character), or a resolved, non-virtual
    /// component has no file name. Reported, never silently stripped.
    /// </summary>
    InvalidFileName,
}

public enum BomIssueSeverity
{
    /// <summary>The extract must not be used until this is fixed.</summary>
    Error,

    /// <summary>The extract may be used; the issue is reported.</summary>
    Warning,
}

/// <summary>One validation finding.</summary>
/// <param name="Code">The problem.</param>
/// <param name="Severity">Error or warning.</param>
/// <param name="Path">The row's path (see <see cref="BomRowEntry.Path"/>), or null for the whole extract.</param>
/// <param name="Message">A plain-language description (no file-system paths).</param>
public sealed record BomIssue(BomIssueCode Code, BomIssueSeverity Severity, string? Path, string Message);

/// <summary>The outcome of validating an extract.</summary>
public sealed record BomValidationResult(IReadOnlyList<BomIssue> Issues)
{
    public bool HasErrors => Issues.Any(i => i.Severity == BomIssueSeverity.Error);

    public IEnumerable<BomIssue> Errors => Issues.Where(i => i.Severity == BomIssueSeverity.Error);

    public IEnumerable<BomIssue> Warnings => Issues.Where(i => i.Severity == BomIssueSeverity.Warning);
}

/// <summary>
/// Validates a BOM extract. Pure and deterministic: the same extract always
/// yields the same issues in the same order, grouped by check: an integrity
/// failure alone (nothing else examined), else file-name issues, then the
/// assembly's own text, then each row's checks in canonical row order, then
/// duplicate part / item numbers.
/// Nothing is fixed or changed - problems are only reported.
/// </summary>
public static class BomValidator
{
    /// <summary>Deepest allowed hierarchy (level 1 = top level).</summary>
    public const int MaxDepth = 64;

    /// <summary>Most rows allowed in one extract (all levels).</summary>
    public const int MaxRows = 100_000;

    /// <summary>
    /// Units treated as counts, so their quantities must be whole numbers.
    /// Compared case-insensitively after normalization.
    /// </summary>
    public static readonly IReadOnlySet<string> CountUnits = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "each", "ea", "ea.", "pc", "pcs", "piece", "pieces", "unit", "units", "qty",
    };

    public static BomValidationResult Validate(BomExtract extract)
    {
        ArgumentNullException.ThrowIfNull(extract);

        // Bounded, cycle-safe snapshot first: a structurally unsafe extract is
        // reported as its integrity issue and nothing else is examined.
        BomGraph graph;
        try
        {
            graph = BomGraph.Build(extract);
        }
        catch (BomIntegrityException ex)
        {
            return new BomValidationResult(ex.Issues);
        }

        var issues = new List<BomIssue>();
        if (graph.Entries.Count == 0)
        {
            issues.Add(new BomIssue(BomIssueCode.EmptyBom, BomIssueSeverity.Error, null, "The BOM has no rows."));
            return new BomValidationResult(issues);
        }

        issues.AddRange(graph.FileNameIssues);
        CheckText(extract.RootFileName, null, "assembly file name", issues);
        CheckText(extract.RootPartNumber, null, "assembly part number", issues);

        foreach (var entry in graph.Entries)
        {
            CheckRow(extract.ViewType, entry, issues);
        }

        CheckDuplicates(graph, issues);
        return new BomValidationResult(issues);
    }

    private static void CheckRow(BomViewType view, BomGraphEntry entry, List<BomIssue> issues)
    {
        var row = entry.Node.Row;
        if (view == BomViewType.PartsOnly && entry.Node.Children.Length > 0)
        {
            issues.Add(new BomIssue(BomIssueCode.InvalidHierarchy, BomIssueSeverity.Error, entry.Path,
                "A Parts Only BOM row must not have child rows."));
        }

        if (BomText.Normalize(row.PartNumber) is null)
        {
            issues.Add(new BomIssue(BomIssueCode.MissingPartNumber, BomIssueSeverity.Error, entry.Path,
                "The row has no part number."));
        }

        var unit = BomText.Normalize(row.Quantity.Unit);
        if (unit is null)
        {
            issues.Add(new BomIssue(BomIssueCode.MissingUnit, BomIssueSeverity.Error, entry.Path,
                "The quantity has no unit."));
        }

        if (row.Quantity.Value <= 0m)
        {
            issues.Add(new BomIssue(BomIssueCode.InvalidQuantity, BomIssueSeverity.Error, entry.Path,
                $"The quantity must be greater than zero (found {BomText.FormatDecimal(row.Quantity.Value)})."));
        }
        else if (unit is not null && CountUnits.Contains(unit) && decimal.Truncate(row.Quantity.Value) != row.Quantity.Value)
        {
            issues.Add(new BomIssue(BomIssueCode.InvalidQuantity, BomIssueSeverity.Error, entry.Path,
                $"A quantity counted in '{unit}' must be a whole number (found {BomText.FormatDecimal(row.Quantity.Value)})."));
        }

        if (row.Mass is not null)
        {
            if (row.Mass.Value < 0m)
            {
                issues.Add(new BomIssue(BomIssueCode.InvalidMass, BomIssueSeverity.Error, entry.Path,
                    $"The mass must not be negative (found {BomText.FormatDecimal(row.Mass.Value)})."));
            }

            if (BomText.Normalize(row.Mass.Unit) is null)
            {
                issues.Add(new BomIssue(BomIssueCode.MissingUnit, BomIssueSeverity.Error, entry.Path,
                    "The mass has no unit."));
            }
        }

        if (!row.Source.IsResolved && !row.Source.IsVirtual)
        {
            var name = BomText.Normalize(row.Source.FileName);
            issues.Add(new BomIssue(BomIssueCode.UnresolvedComponent, BomIssueSeverity.Error, entry.Path,
                name is null ? "The component's file could not be found or loaded." : $"The component file '{name}' could not be found or loaded."));
        }

        CheckText(row.ItemNumber, entry, "item number", issues);
        CheckText(row.PartNumber, entry, "part number", issues);
        CheckText(row.Description, entry, "description", issues);
        CheckText(row.Material, entry, "material", issues);
        CheckText(row.Quantity.Unit, entry, "quantity unit", issues);
        CheckText(row.Mass?.Unit, entry, "mass unit", issues);
        CheckText(row.Source.FileName, entry, "file name", issues);
    }

    /// <summary>Reports invalid text; the row path (if any) is built only when an issue is reported.</summary>
    private static void CheckText(string? value, BomGraphEntry? entry, string field, List<BomIssue> issues)
    {
        if (value is null)
        {
            return;
        }

        if (BomText.HasLoneSurrogate(value) || BomText.HasDisallowedControlCharacter(value))
        {
            issues.Add(new BomIssue(BomIssueCode.InvalidText, BomIssueSeverity.Error, entry?.Path,
                $"The {field} contains an invalid or control character."));
        }
    }

    /// <summary>
    /// Duplicate part numbers / item numbers among siblings (in a Parts Only
    /// view all rows are siblings). Compared after normalization, ordinally
    /// (exact text). One issue per duplicate occurrence after the first, in
    /// canonical order.
    ///  - Same part number, distinct item numbers: WARNING (a legitimate
    ///    unmerged Inventor BOM - nothing is merged).
    ///  - Same part number where this or an earlier same-part row has the same
    ///    or no item number: ERROR (the rows cannot be told apart).
    ///  - Same item number: ERROR (DuplicateItemNumber), reported separately.
    /// </summary>
    private static void CheckDuplicates(BomGraph graph, List<BomIssue> issues)
    {
        // Siblings share a parent OCCURRENCE (entry); top-level rows share the
        // sentinel. Entries are in canonical depth-first order, so each sibling
        // group is visited in canonical sibling order. Paths are built only for
        // reported issues - never per row.
        var topLevel = new object();
        var groups = new Dictionary<object, SiblingGroup>(ReferenceEqualityComparer.Instance);

        foreach (var entry in graph.Entries)
        {
            var key = (object?)entry.Parent ?? topLevel;
            if (!groups.TryGetValue(key, out var group))
            {
                group = new SiblingGroup();
                groups[key] = group;
            }

            var node = entry.Node;
            if (node.Part is not null)
            {
                if (group.ItemsByPart.TryGetValue(node.Part, out var earlier))
                {
                    // O(1): distinguishable only if this row has an item number,
                    // no earlier same-part row lacked one, and none used this one.
                    var distinguishable = node.Item is not null
                        && !earlier.AnyMissingItem
                        && !earlier.Items.Contains(node.Item);
                    issues.Add(distinguishable
                        ? new BomIssue(BomIssueCode.DuplicateRow, BomIssueSeverity.Warning, entry.Path,
                            $"Part number '{node.Part}' appears more than once at this level (distinct item numbers; rows are not merged).")
                        : new BomIssue(BomIssueCode.DuplicateRow, BomIssueSeverity.Error, entry.Path,
                            $"Part number '{node.Part}' appears more than once at this level and the rows cannot be told apart by item number."));
                    earlier.Add(node.Item);
                }
                else
                {
                    var first = new PartOccurrences();
                    first.Add(node.Item);
                    group.ItemsByPart[node.Part] = first;
                }
            }

            if (node.Item is not null && !group.Items.Add(node.Item))
            {
                issues.Add(new BomIssue(BomIssueCode.DuplicateItemNumber, BomIssueSeverity.Error, entry.Path,
                    $"Item number '{node.Item}' appears more than once at this level."));
            }
        }
    }

    private sealed class SiblingGroup
    {
        public Dictionary<string, PartOccurrences> ItemsByPart { get; } = new(StringComparer.Ordinal);

        public HashSet<string> Items { get; } = new(StringComparer.Ordinal);
    }

    /// <summary>The item numbers already seen for one part number among siblings.</summary>
    private sealed class PartOccurrences
    {
        public HashSet<string> Items { get; } = new(StringComparer.Ordinal);

        /// <summary>True once any row with this part number had no item number.</summary>
        public bool AnyMissingItem { get; private set; }

        public void Add(string? item)
        {
            if (item is null)
            {
                AnyMissingItem = true;
            }
            else
            {
                Items.Add(item);
            }
        }
    }
}
