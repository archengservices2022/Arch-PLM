using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Arch.CadConnect.Core.Bom;

/// <summary>
/// Deterministic canonical text for a BOM extract, and its SHA-256 content hash.
///
/// FORMAT (version <see cref="FormatId"/>): one line of JSON with no
/// insignificant whitespace and a fixed key order:
/// <code>
/// {"format":"arch-plm.bom.canonical.v1","view":"STRUCTURED_ALL_LEVELS",
///  "rootFileName":...,"rootPartNumber":...,"rows":[ROW,...]}
/// ROW = {"level":1,"item":...,"partNumber":...,"description":...,
///        "quantity":"2","unit":...,"material":...,"mass":...,"massUnit":...,
///        "structure":"PURCHASED","sourceFileName":...,"resolved":true,"virtual":false}
/// </code>
/// RULES
///  - Rows are listed flat in canonical depth-first order; "level" carries the
///    hierarchy. Siblings are in a content-only total order: item number
///    (<see cref="BomTraversal"/>: dot-separated segments, all-digit segments
///    by numeric value before text segments, then leading zeros as a final
///    tie-break), then part number (ordinal, missing last), then the row's
///    own canonical fields, then a SHA-256 digest of its ordered subtree. The
///    same tree therefore always yields the same text whatever order it was
///    read in - including rows whose item and part numbers are equal.
///  - Only structurally sound extracts with plain source file names are
///    serialized (<see cref="BomIntegrityException"/> otherwise).
///  - Text is <see cref="BomText.Normalize"/>d (lone surrogates -> U+FFFD,
///    NFC, trimmed, empty -> null). NFC is the only Unicode normalization: canonically equivalent text
///    (precomposed vs decomposed accents) hashes identically, but visually
///    similar text that is not canonically equivalent (full-width forms,
///    ligatures, homoglyphs from other scripts, letter case, zero-width
///    characters) hashes differently. See the remarks on
///    <see cref="BomText.Normalize"/> for stability across Unicode versions.
///  - Decimals are JSON STRINGS formatted by <see cref="BomText.FormatDecimal"/>
///    (exact, invariant, no trailing zeros), never JSON numbers, so 1.5 and
///    1.50 hash identically and no floating-point rounding can occur.
///  - A missing mass is null for both "mass" and "massUnit".
///  - Strings escape only '"', '\' and U+0000..U+001F (as \u00XX, lowercase
///    hex); everything else is written as UTF-8.
///  - The hash is lowercase hex SHA-256 of the UTF-8 bytes (no byte-order mark).
///  - Absolute paths, timestamps and machine data are never part of the text.
/// Any change to these rules must change <see cref="FormatId"/>.
/// </summary>
public static class BomCanonicalSerializer
{
    public const string FormatId = "arch-plm.bom.canonical.v1";

    /// <summary>The canonical text of the extract.</summary>
    /// <exception cref="BomIntegrityException">The extract is structurally
    /// unsafe (cycle, limits, null / incomplete rows) or a source file name is
    /// not a plain file name. Hashes are never produced for such input.</exception>
    public static string Serialize(BomExtract extract)
    {
        ArgumentNullException.ThrowIfNull(extract);

        var graph = BomGraph.Build(extract);
        if (graph.FileNameIssues.Count > 0)
        {
            throw new BomIntegrityException(graph.FileNameIssues);
        }

        var sb = new StringBuilder(256);
        sb.Append('{');
        AppendProperty(sb, "format", FormatId, first: true);
        AppendProperty(sb, "view", ViewName(extract.ViewType));
        AppendProperty(sb, "rootFileName", BomText.Normalize(extract.RootFileName));
        AppendProperty(sb, "rootPartNumber", BomText.Normalize(extract.RootPartNumber));
        sb.Append(",\"rows\":[");

        var first = true;
        foreach (var entry in graph.Entries)
        {
            if (!first)
            {
                sb.Append(',');
            }

            first = false;
            sb.Append("{\"level\":").Append(entry.Level.ToString(CultureInfo.InvariantCulture))
                .Append(',').Append(entry.Node.SelfKey).Append('}');
        }

        sb.Append("]}");
        return sb.ToString();
    }

    /// <summary>Lowercase hex SHA-256 of the canonical text's UTF-8 bytes
    /// (no byte-order mark). Each text value is transformed by
    /// <see cref="BomText.Normalize"/> exactly as follows and in no other way:
    /// lone UTF-16 surrogates replaced by U+FFFD, Unicode NFC, leading and
    /// trailing whitespace trimmed, empty -> null. See its remarks for what
    /// that means for visually identical names.</summary>
    public static string ComputeSha256(BomExtract extract)
    {
        var bytes = Encoding.UTF8.GetBytes(Serialize(extract));
        return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    }

    /// <summary>The stable upper-case name used for a view in canonical text and CSV.</summary>
    public static string ViewName(BomViewType view) => view switch
    {
        BomViewType.StructuredAllLevels => "STRUCTURED_ALL_LEVELS",
        BomViewType.PartsOnly => "PARTS_ONLY",
        _ => throw new ArgumentOutOfRangeException(nameof(view), view, "Unknown BOM view."),
    };

    /// <summary>The stable upper-case name used for a BOM structure in canonical text and CSV.</summary>
    public static string StructureName(BomStructure structure) => structure switch
    {
        BomStructure.Normal => "NORMAL",
        BomStructure.Purchased => "PURCHASED",
        BomStructure.Phantom => "PHANTOM",
        BomStructure.Reference => "REFERENCE",
        BomStructure.Inseparable => "INSEPARABLE",
        BomStructure.Unknown => "UNKNOWN",
        _ => throw new ArgumentOutOfRangeException(nameof(structure), structure, "Unknown BOM structure."),
    };

    /// <summary>
    /// A row's own canonical fields, from "item" to "virtual" (no level, no
    /// children, no braces). Used both inside each canonical row and as the
    /// content key for sibling ordering.
    /// </summary>
    internal static string RowFields(BomRow row)
    {
        var sb = new StringBuilder(200);
        AppendProperty(sb, "item", BomText.Normalize(row.ItemNumber), first: true);
        AppendProperty(sb, "partNumber", BomText.Normalize(row.PartNumber));
        AppendProperty(sb, "description", BomText.Normalize(row.Description));
        AppendProperty(sb, "quantity", BomText.FormatDecimal(row.Quantity.Value));
        AppendProperty(sb, "unit", BomText.Normalize(row.Quantity.Unit));
        AppendProperty(sb, "material", BomText.Normalize(row.Material));
        AppendProperty(sb, "mass", row.Mass is null ? null : BomText.FormatDecimal(row.Mass.Value));
        AppendProperty(sb, "massUnit", row.Mass is null ? null : BomText.Normalize(row.Mass.Unit));
        AppendProperty(sb, "structure", StructureName(row.Structure));
        AppendProperty(sb, "sourceFileName", BomText.Normalize(row.Source.FileName));
        sb.Append(",\"resolved\":").Append(row.Source.IsResolved ? "true" : "false");
        sb.Append(",\"virtual\":").Append(row.Source.IsVirtual ? "true" : "false");
        return sb.ToString();
    }

    private static void AppendProperty(StringBuilder sb, string name, string? value, bool first = false)
    {
        if (!first)
        {
            sb.Append(',');
        }

        sb.Append('"').Append(name).Append("\":");
        if (value is null)
        {
            sb.Append("null");
            return;
        }

        sb.Append('"');
        foreach (var c in value)
        {
            switch (c)
            {
                case '"':
                    sb.Append("\\\"");
                    break;
                case '\\':
                    sb.Append("\\\\");
                    break;
                default:
                    if (c < ' ')
                    {
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        sb.Append(c);
                    }

                    break;
            }
        }

        sb.Append('"');
    }
}
