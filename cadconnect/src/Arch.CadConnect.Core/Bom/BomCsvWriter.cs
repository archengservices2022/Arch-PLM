using System.Globalization;
using System.Text;

namespace Arch.CadConnect.Core.Bom;

/// <summary>
/// RFC 4180 CSV export of a BOM extract, for opening in Excel.
///
///  - One header row, then one record per BOM row in canonical order
///    (<see cref="BomTraversal"/>); "Level" carries the hierarchy.
///  - Records end with CRLF (including the last one).
///  - A field is quoted when it contains a comma, double quote, CR or LF, or
///    has leading/trailing whitespace; embedded double quotes are doubled.
///  - EXCEL FORMULA-INJECTION PROTECTION: any TEXT field taken from the model
///    that starts with '=', '+', '-', '@', TAB or CR (or their full-width
///    forms) is prefixed with a single quote, so Excel shows it as text and
///    never evaluates it. Numbers produced here (level, quantity, mass) are
///    formatted by this writer and never guarded.
///  - Numbers are invariant culture ('.' decimal separator), exact, without
///    trailing zeros (<see cref="BomText.FormatDecimal"/>).
///  - Text is <see cref="BomText.Normalize"/>d, like the canonical hash input.
///  - <see cref="WriteUtf8"/> adds the UTF-8 byte-order mark Excel needs to
///    read non-ASCII text correctly.
/// No absolute paths are written - only the component file name.
/// </summary>
public static class BomCsvWriter
{
    public static readonly IReadOnlyList<string> Header =
    [
        "Level", "Item", "Part Number", "Description", "Quantity", "Unit", "Material",
        "Mass", "Mass Unit", "BOM Structure", "Purchased", "Source File", "Resolved",
    ];

    private static readonly char[] FormulaTriggers =
    [
        '=', '+', '-', '@', '\t', '\r',
        '＝', '＋', '－', '＠', // full-width = + - @
    ];

    /// <summary>The CSV text (no byte-order mark).</summary>
    /// <exception cref="BomIntegrityException">The extract is structurally
    /// unsafe (cycle, limits, null / incomplete rows) or a source file name is
    /// not a plain file name - the same checks as canonical hashing, so an
    /// export can never leak a path.</exception>
    public static string Write(BomExtract extract)
    {
        ArgumentNullException.ThrowIfNull(extract);

        var graph = BomGraph.Build(extract);
        if (graph.FileNameIssues.Count > 0)
        {
            throw new BomIntegrityException(graph.FileNameIssues);
        }

        var sb = new StringBuilder(256);
        AppendRecord(sb, Header.Select(h => Field(h, guard: false)));

        foreach (var entry in graph.Entries)
        {
            var row = entry.Node.Row;
            AppendRecord(sb,
            [
                Field(entry.Level.ToString(CultureInfo.InvariantCulture), guard: false),
                Text(row.ItemNumber),
                Text(row.PartNumber),
                Text(row.Description),
                Field(BomText.FormatDecimal(row.Quantity.Value), guard: false),
                Text(row.Quantity.Unit),
                Text(row.Material),
                Field(row.Mass is null ? string.Empty : BomText.FormatDecimal(row.Mass.Value), guard: false),
                Text(row.Mass?.Unit),
                Field(BomCanonicalSerializer.StructureName(row.Structure), guard: false),
                Field(row.IsPurchased ? "Yes" : "No", guard: false),
                Text(row.Source.FileName),
                Field(row.Source.IsVirtual ? "Virtual" : row.Source.IsResolved ? "Yes" : "No", guard: false),
            ]);
        }

        return sb.ToString();
    }

    /// <summary>The CSV as UTF-8 bytes with a byte-order mark (for Excel).</summary>
    public static byte[] WriteUtf8(BomExtract extract)
    {
        var text = Write(extract);
        var preamble = Encoding.UTF8.GetPreamble();
        var body = Encoding.UTF8.GetBytes(text);
        var bytes = new byte[preamble.Length + body.Length];
        preamble.CopyTo(bytes, 0);
        body.CopyTo(bytes, preamble.Length);
        return bytes;
    }

    /// <summary>
    /// Escapes one CSV field (RFC 4180), applying the formula-injection guard
    /// when <paramref name="guard"/> is true. Public so callers and tests use
    /// exactly the same rules.
    /// </summary>
    public static string Field(string? value, bool guard)
    {
        var v = value ?? string.Empty;
        if (guard && v.Length > 0 && Array.IndexOf(FormulaTriggers, v[0]) >= 0)
        {
            v = "'" + v;
        }

        var needsQuotes = v.IndexOfAny([',', '"', '\r', '\n']) >= 0
            || (v.Length > 0 && (char.IsWhiteSpace(v[0]) || char.IsWhiteSpace(v[^1])));
        return needsQuotes ? "\"" + v.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"" : v;
    }

    private static string Text(string? value) => Field(BomText.Normalize(value), guard: true);

    private static void AppendRecord(StringBuilder sb, IEnumerable<string> fields)
    {
        sb.AppendJoin(',', fields).Append("\r\n");
    }
}
