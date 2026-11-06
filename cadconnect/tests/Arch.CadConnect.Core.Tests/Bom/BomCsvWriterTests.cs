using System.Text;
using Arch.CadConnect.Core.Bom;
using static Arch.CadConnect.Core.Tests.Bom.BomFixtures;

namespace Arch.CadConnect.Core.Tests.Bom;

public sealed class BomCsvWriterTests
{
    private const string HeaderLine =
        "Level,Item,Part Number,Description,Quantity,Unit,Material,Mass,Mass Unit,BOM Structure,Purchased,Source File,Resolved";

    private static string[] Lines(string csv)
    {
        Assert.EndsWith("\r\n", csv, StringComparison.Ordinal);
        return csv[..^2].Split("\r\n");
    }

    [Fact]
    public void Structured_bom_is_written_in_canonical_order_with_levels()
    {
        var csv = BomCsvWriter.Write(Frame());
        Assert.Equal(
            new[]
            {
                HeaderLine,
                "1,1,BR-001,Bracket,2,Each,\"Steel, Mild\",0.85,kg,NORMAL,No,BR-001.ipt,Yes",
                "1,2,SUB-200,Hinge subassembly,1,Each,,1.2,kg,NORMAL,No,sub-200.iam,Yes",
                "2,2.1,PIN-010,Pin,4,Each,Stainless Steel,0.015,kg,NORMAL,No,PIN-010.ipt,Yes",
                "2,2.2,SCR-M6,Screw M6x20,8,Each,,,,PURCHASED,Yes,ISO 4762 M6x20.ipt,Yes",
                "1,3,TUBE-25,Square tube 25x25,1250.5,mm,Aluminum 6061,2.75,kg,NORMAL,No,TUBE-25.ipt,Yes",
            },
            Lines(csv));
    }

    [Fact]
    public void Every_record_ends_with_crlf_and_there_are_no_bare_line_feeds_outside_quotes()
    {
        var csv = BomCsvWriter.Write(Frame());
        Assert.DoesNotContain("\n", csv.Replace("\r\n", string.Empty, StringComparison.Ordinal), StringComparison.Ordinal);
        Assert.Equal(6, Lines(csv).Length);
    }

    [Fact]
    public void Header_is_always_written_even_for_an_empty_bom()
    {
        Assert.Equal(HeaderLine + "\r\n", BomCsvWriter.Write(Structured()));
    }

    // ---------------- RFC 4180 quoting ----------------

    [Theory]
    [InlineData("plain", "plain")]
    [InlineData("a,b", "\"a,b\"")]
    [InlineData("say \"hi\"", "\"say \"\"hi\"\"\"")]
    [InlineData("line1\r\nline2", "\"line1\r\nline2\"")]
    [InlineData("line1\nline2", "\"line1\nline2\"")]
    [InlineData(" lead", "\" lead\"")]
    [InlineData("trail ", "\"trail \"")]
    [InlineData("", "")]
    [InlineData(null, "")]
    public void Fields_are_quoted_and_escaped_per_rfc_4180(string? value, string expected)
    {
        Assert.Equal(expected, BomCsvWriter.Field(value, guard: false));
    }

    [Fact]
    public void A_multi_line_description_with_quotes_round_trips_through_an_rfc_4180_reader()
    {
        var description = "First line, with \"quotes\"\r\nSecond line";
        var csv = BomCsvWriter.Write(Structured(Row("1", "P", description: description)));
        var records = ParseCsv(csv);
        Assert.Equal(2, records.Count);
        Assert.Equal(description, records[1][3]);
        Assert.Equal(13, records[1].Count);
    }

    // ---------------- formula-injection protection ----------------

    [Theory]
    [InlineData("=SUM(A1:A9)", "'=SUM(A1:A9)")]
    [InlineData("+1+1", "'+1+1")]
    [InlineData("-2+3", "'-2+3")]
    [InlineData("@SUM(1)", "'@SUM(1)")]
    [InlineData("\t=1", "'\t=1")]
    [InlineData("\r=1", "\"'\r=1\"")]
    [InlineData("＝1+1", "'＝1+1")]
    [InlineData("=HYPERLINK(\"http://x\",\"y\")", "\"'=HYPERLINK(\"\"http://x\"\",\"\"y\"\")\"")]
    [InlineData("A=1", "A=1")]
    [InlineData("M-6", "M-6")]
    public void Guarded_fields_starting_with_a_formula_trigger_are_prefixed_with_a_quote(string value, string expected)
    {
        Assert.Equal(expected, BomCsvWriter.Field(value, guard: true));
    }

    [Fact]
    public void Every_text_column_from_the_model_is_guarded()
    {
        var csv = BomCsvWriter.Write(Structured(Row(
            item: "=1",
            partNumber: "=cmd|' /C calc'!A0",
            quantity: 1m,
            unit: "+u",
            description: "-desc",
            material: "@mat",
            mass: new BomMass(1m, "=kg"),
            source: BomSourceDocument.Resolved("=file.ipt"))));

        var record = ParseCsv(csv)[1];
        foreach (var column in new[] { 1, 2, 3, 5, 6, 8, 11 })
        {
            Assert.StartsWith("'", record[column], StringComparison.Ordinal);
        }
    }

    [Fact]
    public void Text_that_only_becomes_a_formula_after_trimming_is_still_guarded()
    {
        var record = ParseCsv(BomCsvWriter.Write(Structured(Row("1", "   =1+1"))))[1];
        Assert.Equal("'=1+1", record[2]);
    }

    // ---------------- numbers, units and flags ----------------

    [Fact]
    public void Numbers_are_invariant_exact_and_without_trailing_zeros_even_under_a_comma_culture()
    {
        var original = System.Globalization.CultureInfo.CurrentCulture;
        try
        {
            System.Globalization.CultureInfo.CurrentCulture = new System.Globalization.CultureInfo("de-DE");
            var record = ParseCsv(BomCsvWriter.Write(Structured(
                Row("1", "P", 1250.500m, "mm", mass: new BomMass(0.1234567890123456789m, "kg")))))[1];
            Assert.Equal("1250.5", record[4]);
            Assert.Equal("mm", record[5]);
            Assert.Equal("0.1234567890123456789", record[7]);
        }
        finally
        {
            System.Globalization.CultureInfo.CurrentCulture = original;
        }
    }

    [Fact]
    public void Missing_mass_leaves_mass_and_mass_unit_empty()
    {
        var record = ParseCsv(BomCsvWriter.Write(Structured(Row("1", "P", mass: null))))[1];
        Assert.Equal(string.Empty, record[7]);
        Assert.Equal(string.Empty, record[8]);
    }

    [Fact]
    public void Purchased_and_resolution_flags_are_explicit()
    {
        var records = ParseCsv(BomCsvWriter.Write(PartsOnly(
            Row("1", "BUY", structure: BomStructure.Purchased),
            Row("2", "GONE", source: BomSourceDocument.Unresolved("gone.ipt")),
            Row("3", "VIRT", source: BomSourceDocument.Virtual()))));
        Assert.Equal(("Yes", "Yes"), (records[1][10], records[1][12]));
        Assert.Equal(("No", "No"), (records[2][10], records[2][12]));
        Assert.Equal(("No", "Virtual"), (records[3][10], records[3][12]));
        Assert.Equal("PURCHASED", records[1][9]);
        Assert.Equal(string.Empty, records[3][11]);
    }

    // ---------------- encoding ----------------

    [Fact]
    public void Utf8_output_starts_with_a_byte_order_mark_and_keeps_unicode()
    {
        var bytes = BomCsvWriter.WriteUtf8(Structured(Row("1", "Möbel-Ø", description: "Maß 中文")));
        Assert.Equal(new byte[] { 0xEF, 0xBB, 0xBF }, bytes[..3]);
        var text = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true).GetString(bytes, 3, bytes.Length - 3);
        Assert.Equal(BomCsvWriter.Write(Structured(Row("1", "Möbel-Ø", description: "Maß 中文"))), text);
        Assert.Contains("Möbel-Ø", text, StringComparison.Ordinal);
    }

    [Fact]
    public void Csv_text_is_normalized_like_the_hash_input()
    {
        var record = ParseCsv(BomCsvWriter.Write(Structured(Row(" 1 ", " Möbel ", description: "  x  "))))[1];
        Assert.Equal("1", record[1]);
        Assert.Equal("Möbel", record[2]);
        Assert.Equal("x", record[3]);
    }

    [Fact]
    public void Csv_never_contains_absolute_paths()
    {
        var csv = BomCsvWriter.Write(Frame());
        Assert.DoesNotContain(":\\", csv, StringComparison.Ordinal);
    }

    [Fact]
    public void Output_is_deterministic_regardless_of_input_order()
    {
        var a = Structured(Row("2", "B"), Row("1", "A", children: [Row("1.2", "D"), Row("1.1", "C")]));
        var b = Structured(Row("1", "A", children: [Row("1.1", "C"), Row("1.2", "D")]), Row("2", "B"));
        Assert.Equal(BomCsvWriter.Write(a), BomCsvWriter.Write(b));
    }

    /// <summary>A minimal, strict RFC 4180 reader used only to verify the writer.</summary>
    private static List<List<string>> ParseCsv(string csv)
    {
        var records = new List<List<string>>();
        var record = new List<string>();
        var field = new StringBuilder();
        var i = 0;
        var inQuotes = false;
        while (i < csv.Length)
        {
            var c = csv[i];
            if (inQuotes)
            {
                if (c == '"')
                {
                    if (i + 1 < csv.Length && csv[i + 1] == '"')
                    {
                        field.Append('"');
                        i += 2;
                        continue;
                    }

                    inQuotes = false;
                    i++;
                    continue;
                }

                field.Append(c);
                i++;
                continue;
            }

            switch (c)
            {
                case '"':
                    Assert.Equal(0, field.Length); // quotes only at the start of a field
                    inQuotes = true;
                    i++;
                    break;
                case ',':
                    record.Add(field.ToString());
                    field.Clear();
                    i++;
                    break;
                case '\r':
                    Assert.Equal('\n', csv[i + 1]);
                    record.Add(field.ToString());
                    field.Clear();
                    records.Add(record);
                    record = [];
                    i += 2;
                    break;
                default:
                    field.Append(c);
                    i++;
                    break;
            }
        }

        Assert.False(inQuotes);
        Assert.Empty(record);
        return records;
    }
}
