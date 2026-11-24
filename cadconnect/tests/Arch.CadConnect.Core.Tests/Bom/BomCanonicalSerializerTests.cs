using System.Security.Cryptography;
using System.Text;
using Arch.CadConnect.Core.Bom;
using static Arch.CadConnect.Core.Tests.Bom.BomFixtures;

namespace Arch.CadConnect.Core.Tests.Bom;

public sealed class BomCanonicalSerializerTests
{
    /// <summary>The golden fixture: deliberately delivered out of order, with
    /// trailing-zero decimals and a quote in a description.</summary>
    private static BomExtract Golden() => Structured(
        Row("2", "SUB-200", 1m, "Each", "Hinge \"HD\"", null, new BomMass(1.20m, "kg"),
            BomStructure.Normal, BomSourceDocument.Resolved("sub-200.iam"),
            Row("2.1", "SCR-M6", 8m, "Each", "Screw", null, null, BomStructure.Purchased, BomSourceDocument.Resolved("screw.ipt"))),
        Row("1", "BR-001", 2.00m, "Each", "Bracket", "Steel, Mild", new BomMass(0.850m, "kg")));

    /// <summary>Written by hand from the format specification - NOT produced by the code under test.</summary>
    private const string GoldenCanonical =
        """{"format":"arch-plm.bom.canonical.v1","view":"STRUCTURED_ALL_LEVELS","rootFileName":"top.iam","rootPartNumber":"TOP-100","rows":[{"level":1,"item":"1","partNumber":"BR-001","description":"Bracket","quantity":"2","unit":"Each","material":"Steel, Mild","mass":"0.85","massUnit":"kg","structure":"NORMAL","sourceFileName":"BR-001.ipt","resolved":true,"virtual":false},{"level":1,"item":"2","partNumber":"SUB-200","description":"Hinge \"HD\"","quantity":"1","unit":"Each","material":null,"mass":"1.2","massUnit":"kg","structure":"NORMAL","sourceFileName":"sub-200.iam","resolved":true,"virtual":false},{"level":2,"item":"2.1","partNumber":"SCR-M6","description":"Screw","quantity":"8","unit":"Each","material":null,"mass":null,"massUnit":null,"structure":"PURCHASED","sourceFileName":"screw.ipt","resolved":true,"virtual":false}]}""";

    /// <summary>SHA-256 of <see cref="GoldenCanonical"/>, computed independently
    /// (PowerShell / .NET SHA256 over the UTF-8 bytes of the literal above).</summary>
    private const string GoldenSha256 = "5c720ab411e3ffac8d2f1fc21e7d8d748e4d804370580f77312f0b36744027a3";

    [Fact]
    public void Canonical_text_matches_the_hand_written_specification_exactly()
    {
        Assert.Equal(GoldenCanonical, BomCanonicalSerializer.Serialize(Golden()));
    }

    [Fact]
    public void Hash_matches_the_independently_computed_golden_value()
    {
        Assert.Equal(GoldenSha256, BomCanonicalSerializer.ComputeSha256(Golden()));
    }

    // ---------------- Unicode hash stability (BOM-L4) ----------------

    /// <summary>Non-ASCII fixture: Latin-1, CJK, an astral emoji, and a file
    /// name delivered DECOMPOSED ("o" + U+0308) that NFC composes.</summary>
    private static BomExtract UnicodeGolden() => Structured(
        Row("1", "Ø-100", description: "Möbel 中文 \U0001F600",
            source: BomSourceDocument.Resolved("Möbel.ipt")));

    /// <summary>Written by hand (NFC applied by hand to the file name).</summary>
    private const string UnicodeGoldenCanonical =
        "{\"format\":\"arch-plm.bom.canonical.v1\",\"view\":\"STRUCTURED_ALL_LEVELS\",\"rootFileName\":\"top.iam\",\"rootPartNumber\":\"TOP-100\",\"rows\":[{\"level\":1,\"item\":\"1\",\"partNumber\":\"Ø-100\",\"description\":\"Möbel 中文 \U0001F600\",\"quantity\":\"1\",\"unit\":\"Each\",\"material\":null,\"mass\":null,\"massUnit\":null,\"structure\":\"NORMAL\",\"sourceFileName\":\"Möbel.ipt\",\"resolved\":true,\"virtual\":false}]}";

    /// <summary>SHA-256 of the UTF-8 bytes of <see cref="UnicodeGoldenCanonical"/>,
    /// computed independently with PowerShell / .NET Framework SHA256. If this
    /// changes, existing BOM hashes of non-ASCII names change: that needs a new
    /// <see cref="BomCanonicalSerializer.FormatId"/>, not a new constant.</summary>
    private const string UnicodeGoldenSha256 = "7d2e3fb0e0c8c3016ed002480c7b38133cb0dc48110b3dcbc410c0ee79528139";

    [Fact]
    public void Non_ascii_text_is_nfc_normalized_and_hashed_as_utf8_with_a_pinned_value()
    {
        Assert.Equal(UnicodeGoldenCanonical, BomCanonicalSerializer.Serialize(UnicodeGolden()));
        Assert.Equal(UnicodeGoldenSha256, BomCanonicalSerializer.ComputeSha256(UnicodeGolden()));
        Assert.Equal(
            UnicodeGoldenSha256,
            Convert.ToHexString(SHA256.HashData(new UTF8Encoding(false).GetBytes(UnicodeGoldenCanonical))).ToLowerInvariant());
    }

    [Theory]
    [InlineData("ö", "ö")]          // precomposed vs decomposed
    [InlineData("Å", "Å")]          // A-ring vs Angstrom sign (canonical singleton)
    [InlineData("ệ", "ệ")]   // combining marks in canonical order
    [InlineData("ệ", "ệ")]   // ... and in non-canonical order
    public void Canonically_equivalent_names_hash_identically(string a, string b)
    {
        Assert.Equal(HashOfName(a), HashOfName(b));
    }

    [Theory]
    [InlineData("fi", "ﬁ")]               // ligature (compatibility only)
    [InlineData("A", "Ａ")]                // full-width letter
    [InlineData("a", "а")]                // Latin a vs Cyrillic a (homoglyph)
    [InlineData("ab", "a​b")]             // zero-width space
    [InlineData("ab", "a­b")]             // soft hyphen
    [InlineData("bracket", "Bracket")]         // letter case
    public void Look_alike_names_that_are_not_canonically_equivalent_hash_differently(string a, string b)
    {
        Assert.NotEqual(HashOfName(a), HashOfName(b));
    }

    private static string HashOfName(string name) => BomCanonicalSerializer.ComputeSha256(
        Structured(Row("1", "P-" + name, description: name, source: BomSourceDocument.Resolved(name + ".ipt"))));

    [Fact]
    public void Hash_is_lowercase_hex_sha256_of_the_utf8_canonical_text()
    {
        var text = BomCanonicalSerializer.Serialize(Frame());
        var expected = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
        var actual = BomCanonicalSerializer.ComputeSha256(Frame());
        Assert.Equal(expected, actual);
        Assert.Matches("^[0-9a-f]{64}$", actual);
    }

    [Fact]
    public void Hash_is_stable_across_repeated_calls_and_new_instances()
    {
        var hashes = Enumerable.Range(0, 5).Select(_ => BomCanonicalSerializer.ComputeSha256(Frame())).Distinct().ToArray();
        Assert.Single(hashes);
    }

    [Fact]
    public void Hash_ignores_the_current_culture()
    {
        var invariant = BomCanonicalSerializer.ComputeSha256(Frame());
        var original = System.Globalization.CultureInfo.CurrentCulture;
        try
        {
            foreach (var name in new[] { "de-DE", "fr-FR", "tr-TR", "ar-SA" })
            {
                System.Globalization.CultureInfo.CurrentCulture = new System.Globalization.CultureInfo(name);
                Assert.Equal(invariant, BomCanonicalSerializer.ComputeSha256(Frame()));
            }
        }
        finally
        {
            System.Globalization.CultureInfo.CurrentCulture = original;
        }
    }

    // ---------------- equivalent inputs hash the same ----------------

    [Fact]
    public void Sibling_order_from_the_reader_does_not_change_the_hash()
    {
        var a = Structured(Row("1", "A"), Row("2", "B", children: [Row("2.1", "C"), Row("2.2", "D")]), Row("3", "E"));
        var b = Structured(Row("3", "E"), Row("2", "B", children: [Row("2.2", "D"), Row("2.1", "C")]), Row("1", "A"));
        Assert.Equal(BomCanonicalSerializer.ComputeSha256(a), BomCanonicalSerializer.ComputeSha256(b));
    }

    [Theory]
    [InlineData("1.5", "1.50")]
    [InlineData("2", "2.000")]
    [InlineData("1250.5", "1250.500000")]
    [InlineData("0.1", "0.10")]
    public void Decimal_scale_does_not_change_the_hash(string a, string b)
    {
        var qa = decimal.Parse(a, System.Globalization.CultureInfo.InvariantCulture);
        var qb = decimal.Parse(b, System.Globalization.CultureInfo.InvariantCulture);
        Assert.Equal(
            BomCanonicalSerializer.ComputeSha256(Structured(Row("1", "P", qa, "mm", mass: new BomMass(qa, "kg")))),
            BomCanonicalSerializer.ComputeSha256(Structured(Row("1", "P", qb, "mm", mass: new BomMass(qb, "kg")))));
    }

    [Fact]
    public void Surrounding_whitespace_empty_strings_and_unicode_normalization_do_not_change_the_hash()
    {
        // Same component file on both sides: only the TEXT presentation differs.
        var a = Structured(Row("1", "Möbel", description: "Bracket", material: null,
            source: BomSourceDocument.Resolved("möbel.ipt")));
        var b = Structured(Row(" 1 ", " Möbel\t", description: "  Bracket ", material: "   ",
            source: BomSourceDocument.Resolved(" möbel.ipt ")));
        Assert.Equal(BomCanonicalSerializer.Serialize(a), BomCanonicalSerializer.Serialize(b));
    }

    // ---------------- every meaningful change changes the hash ----------------

    [Fact]
    public void Each_meaningful_field_change_produces_a_different_hash()
    {
        var baseline = Golden();
        var baseHash = BomCanonicalSerializer.ComputeSha256(baseline);
        var first = baseline.Rows[1]; // BR-001

        BomExtract With(BomRow changed) => baseline with { Rows = [baseline.Rows[0], changed] };

        var variants = new Dictionary<string, BomExtract>
        {
            ["view"] = baseline with { ViewType = BomViewType.PartsOnly },
            ["rootFileName"] = baseline with { RootFileName = "other.iam" },
            ["rootPartNumber"] = baseline with { RootPartNumber = "TOP-101" },
            ["item"] = With(first with { ItemNumber = "4" }),
            ["partNumber"] = With(first with { PartNumber = "BR-002" }),
            ["partNumber case"] = With(first with { PartNumber = "br-001" }),
            ["description"] = With(first with { Description = "Bracket " + "LH" }),
            ["quantity"] = With(first with { Quantity = new BomQuantity(3m, "Each") }),
            ["quantity tiny"] = With(first with { Quantity = new BomQuantity(2.0000000001m, "Each") }),
            ["unit"] = With(first with { Quantity = new BomQuantity(2m, "EA") }),
            ["material"] = With(first with { Material = "Steel, Stainless" }),
            ["mass"] = With(first with { Mass = new BomMass(0.86m, "kg") }),
            ["mass unit"] = With(first with { Mass = new BomMass(0.85m, "lbmass") }),
            ["no mass"] = With(first with { Mass = null }),
            ["structure"] = With(first with { Structure = BomStructure.Purchased }),
            ["source file"] = With(first with { Source = BomSourceDocument.Resolved("br-001-v2.ipt") }),
            ["unresolved"] = With(first with { Source = BomSourceDocument.Unresolved("BR-001.ipt") }),
            ["virtual"] = With(first with { Source = BomSourceDocument.Virtual() }),
            ["moved to child"] = baseline with
            {
                Rows = [baseline.Rows[0] with { Children = [.. baseline.Rows[0].Children, first with { ItemNumber = "2.2" }] }],
            },
        };

        var hashes = new HashSet<string> { baseHash };
        foreach (var (name, variant) in variants)
        {
            Assert.True(hashes.Add(BomCanonicalSerializer.ComputeSha256(variant)), $"'{name}' did not change the hash (or collided).");
        }
    }

    [Fact]
    public void Hierarchy_is_part_of_the_hash_not_just_the_row_set()
    {
        var nested = Structured(Row("1", "A", children: [Row("1.1", "B")]));
        var flat = Structured(Row("1", "A"), Row("1.1", "B"));
        Assert.NotEqual(BomCanonicalSerializer.ComputeSha256(nested), BomCanonicalSerializer.ComputeSha256(flat));
    }

    // ---------------- format details ----------------

    [Fact]
    public void Decimals_are_written_as_exact_strings_never_as_json_numbers()
    {
        var text = BomCanonicalSerializer.Serialize(Structured(Row("1", "P", 0.1234567890123456789012345678m, "m")));
        Assert.Contains("\"quantity\":\"0.1234567890123456789012345678\"", text, StringComparison.Ordinal);
        Assert.DoesNotContain("E+", text, StringComparison.Ordinal);
        Assert.DoesNotContain("E-", text, StringComparison.Ordinal);
    }

    [Fact]
    public void Control_characters_quotes_and_backslashes_are_escaped_and_unicode_is_kept()
    {
        // Explicit plain file name: the fixture's default would be "P\1.ipt",
        // which is (correctly) refused as a path.
        var text = BomCanonicalSerializer.Serialize(Structured(
            Row("1", "P\\1", description: "a\"b\tc\r\nd\u0001e Ø \U0001F600", source: BomSourceDocument.Resolved("p1.ipt"))));
        Assert.Contains("\"partNumber\":\"P\\\\1\"", text, StringComparison.Ordinal);
        Assert.Contains("\"description\":\"a\\\"b\\u0009c\\u000d\\u000ad\\u0001e Ø \U0001F600\"", text, StringComparison.Ordinal);
        Assert.DoesNotContain('\n', text);
        Assert.DoesNotContain('\r', text);
    }

    [Fact]
    public void Missing_values_are_null_and_booleans_are_lowercase()
    {
        var text = BomCanonicalSerializer.Serialize(new BomExtract
        {
            ViewType = BomViewType.PartsOnly,
            Rows = [Row(null, null, 1m, null, source: BomSourceDocument.Virtual())],
        });
        Assert.Equal(
            """{"format":"arch-plm.bom.canonical.v1","view":"PARTS_ONLY","rootFileName":null,"rootPartNumber":null,"rows":[{"level":1,"item":null,"partNumber":null,"description":null,"quantity":"1","unit":null,"material":null,"mass":null,"massUnit":null,"structure":"NORMAL","sourceFileName":null,"resolved":true,"virtual":true}]}""",
            text);
    }

    [Fact]
    public void Canonical_text_never_contains_absolute_paths_or_timestamps()
    {
        var text = BomCanonicalSerializer.Serialize(Frame());
        Assert.DoesNotContain(":\\", text, StringComparison.Ordinal);
        Assert.DoesNotContain("/Users/", text, StringComparison.Ordinal);
        Assert.DoesNotContain(DateTime.UtcNow.Year.ToString(System.Globalization.CultureInfo.InvariantCulture), text, StringComparison.Ordinal);
    }

    [Fact]
    public void Every_view_and_structure_has_a_stable_name()
    {
        Assert.Equal(new[] { "STRUCTURED_ALL_LEVELS", "PARTS_ONLY" }, Enum.GetValues<BomViewType>().Select(BomCanonicalSerializer.ViewName).ToArray());
        Assert.Equal(
            new[] { "NORMAL", "PURCHASED", "PHANTOM", "REFERENCE", "INSEPARABLE", "UNKNOWN" },
            Enum.GetValues<BomStructure>().Select(BomCanonicalSerializer.StructureName).ToArray());
        Assert.Throws<ArgumentOutOfRangeException>(() => BomCanonicalSerializer.ViewName((BomViewType)99));
        Assert.Throws<ArgumentOutOfRangeException>(() => BomCanonicalSerializer.StructureName((BomStructure)99));
    }

    [Fact]
    public void A_very_deep_hierarchy_is_refused_without_stack_overflow()
    {
        var row = Row("x", "LEAF");
        for (var i = 0; i < 20_000; i++)
        {
            row = Row("x", "P" + i, children: [row]);
        }

        var ex = Assert.Throws<BomIntegrityException>(() => BomCanonicalSerializer.Serialize(Structured(row)));
        Assert.Equal(BomIssueCode.InvalidHierarchy, Assert.Single(ex.Issues).Code);
    }
}
