using System.Diagnostics;
using Arch.CadConnect.Core.Bom;
using static Arch.CadConnect.Core.Tests.Bom.BomFixtures;

namespace Arch.CadConnect.Core.Tests.Bom;

public sealed class BomValidatorTests
{
    private static BomIssue Single(BomValidationResult result, BomIssueCode code) =>
        Assert.Single(result.Issues, i => i.Code == code);

    [Fact]
    public void A_correct_structured_bom_has_no_issues()
    {
        var result = BomValidator.Validate(Frame());
        Assert.Empty(result.Issues);
        Assert.False(result.HasErrors);
    }

    [Fact]
    public void A_correct_parts_only_bom_has_no_issues()
    {
        var result = BomValidator.Validate(PartsOnly(
            Row("1", "BR-001", 2m), Row("2", "PIN-010", 4m), Row("3", "SCR-M6", 8m, structure: BomStructure.Purchased)));
        Assert.Empty(result.Issues);
    }

    [Fact]
    public void Empty_bom_is_an_error()
    {
        var issue = Single(BomValidator.Validate(Structured()), BomIssueCode.EmptyBom);
        Assert.Equal(BomIssueSeverity.Error, issue.Severity);
        Assert.Null(issue.Path);
    }

    // ---------------- part numbers ----------------

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Missing_part_number_is_an_error_with_the_row_path(string? partNumber)
    {
        var result = BomValidator.Validate(Structured(Row("1", "OK-1"), Row("2", partNumber)));
        var issue = Single(result, BomIssueCode.MissingPartNumber);
        Assert.Equal(BomIssueSeverity.Error, issue.Severity);
        Assert.Equal("2", issue.Path);
        Assert.True(result.HasErrors);
    }

    [Fact]
    public void Missing_part_number_in_a_child_reports_the_nested_path()
    {
        var result = BomValidator.Validate(Structured(Row("2", "SUB", children: [Row("2.1", null)])));
        Assert.Equal("2/2.1", Single(result, BomIssueCode.MissingPartNumber).Path);
    }

    // ---------------- quantities and units ----------------

    [Theory]
    [InlineData("0")]
    [InlineData("-1")]
    [InlineData("-0.001")]
    public void Zero_or_negative_quantity_is_an_error(string quantity)
    {
        var q = decimal.Parse(quantity, System.Globalization.CultureInfo.InvariantCulture);
        var issue = Single(BomValidator.Validate(Structured(Row("1", "P", q))), BomIssueCode.InvalidQuantity);
        Assert.Equal(BomIssueSeverity.Error, issue.Severity);
        Assert.Contains(BomText.FormatDecimal(q), issue.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("Each")]
    [InlineData("each")]
    [InlineData("EA")]
    [InlineData("pcs")]
    [InlineData(" Each ")]
    public void A_fractional_count_quantity_is_an_error(string unit)
    {
        var issue = Single(BomValidator.Validate(Structured(Row("1", "P", 2.5m, unit))), BomIssueCode.InvalidQuantity);
        Assert.Contains("whole number", issue.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void A_whole_count_quantity_written_with_trailing_zeros_is_valid()
    {
        Assert.Empty(BomValidator.Validate(Structured(Row("1", "P", 2.000m, "Each"))).Issues);
    }

    [Theory]
    [InlineData("mm", "1250.5")]
    [InlineData("m", "0.001")]
    [InlineData("in", "36.375")]
    [InlineData("kg", "0.0000001")]
    [InlineData("l", "2.25")]
    public void Fractional_quantities_in_measured_units_are_valid(string unit, string quantity)
    {
        var q = decimal.Parse(quantity, System.Globalization.CultureInfo.InvariantCulture);
        Assert.Empty(BomValidator.Validate(Structured(Row("1", "P", q, unit))).Issues);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("  ")]
    public void Missing_quantity_unit_is_an_error(string? unit)
    {
        var issue = Single(BomValidator.Validate(Structured(Row("1", "P", 2m, unit))), BomIssueCode.MissingUnit);
        Assert.Contains("quantity", issue.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void A_mass_without_a_unit_is_an_error_and_no_mass_at_all_is_fine()
    {
        var issue = Single(BomValidator.Validate(Structured(Row("1", "P", mass: new BomMass(1.2m, null)))), BomIssueCode.MissingUnit);
        Assert.Contains("mass", issue.Message, StringComparison.Ordinal);
        Assert.Empty(BomValidator.Validate(Structured(Row("1", "P", mass: null))).Issues);
    }

    [Fact]
    public void A_negative_mass_is_an_error_and_zero_mass_is_allowed()
    {
        Single(BomValidator.Validate(Structured(Row("1", "P", mass: new BomMass(-0.5m, "kg")))), BomIssueCode.InvalidMass);
        Assert.Empty(BomValidator.Validate(Structured(Row("1", "P", mass: new BomMass(0m, "kg")))).Issues);
    }

    // ---------------- duplicates ----------------

    [Fact]
    public void A_repeated_part_number_among_siblings_with_distinct_item_numbers_is_a_warning()
    {
        var result = BomValidator.Validate(Structured(Row("1", "P-1"), Row("2", "P-2"), Row("3", " P-1 ")));
        var issue = Single(result, BomIssueCode.DuplicateRow);
        Assert.Equal("3", issue.Path);
        Assert.Equal(BomIssueSeverity.Warning, issue.Severity);
        Assert.Contains("P-1", issue.Message, StringComparison.Ordinal);
        Assert.False(result.HasErrors);
    }

    [Fact]
    public void The_same_part_number_under_different_parents_is_not_a_duplicate()
    {
        var result = BomValidator.Validate(Structured(
            Row("1", "SUB-A", children: Row("1.1", "SCREW")),
            Row("2", "SUB-B", children: Row("2.1", "SCREW"))));
        Assert.DoesNotContain(result.Issues, i => i.Code == BomIssueCode.DuplicateRow);
    }

    [Fact]
    public void A_repeated_part_number_among_children_reports_the_nested_path_as_a_warning()
    {
        var result = BomValidator.Validate(Structured(Row("2", "SUB", children: [Row("2.1", "PIN"), Row("2.2", "PIN")])));
        var issue = Single(result, BomIssueCode.DuplicateRow);
        Assert.Equal("2/2.2", issue.Path);
        Assert.Equal(BomIssueSeverity.Warning, issue.Severity);
    }

    [Fact]
    public void Part_numbers_differing_only_by_case_are_distinct()
    {
        var result = BomValidator.Validate(Structured(Row("1", "abc"), Row("2", "ABC")));
        Assert.DoesNotContain(result.Issues, i => i.Code == BomIssueCode.DuplicateRow);
    }

    [Fact]
    public void A_repeated_part_number_in_a_parts_only_list_with_distinct_item_numbers_is_a_warning()
    {
        var result = BomValidator.Validate(PartsOnly(Row("1", "P-1"), Row("2", "P-1")));
        Assert.Equal(BomIssueSeverity.Warning, Single(result, BomIssueCode.DuplicateRow).Severity);
        Assert.False(result.HasErrors);
    }

    [Fact]
    public void A_duplicate_item_number_among_siblings_is_an_error()
    {
        var result = BomValidator.Validate(Structured(Row("1", "A"), Row("1", "B")));
        Single(result, BomIssueCode.DuplicateItemNumber);
    }

    // ---------------- unresolved / virtual components ----------------

    [Fact]
    public void An_unresolved_component_is_an_error_naming_only_the_file_name()
    {
        var result = BomValidator.Validate(Structured(Row("1", "P", source: BomSourceDocument.Unresolved("missing.ipt"))));
        var issue = Single(result, BomIssueCode.UnresolvedComponent);
        Assert.Contains("missing.ipt", issue.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void An_unresolved_component_without_a_file_name_is_still_an_error()
    {
        Single(BomValidator.Validate(Structured(Row("1", "P", source: BomSourceDocument.Unresolved(null)))), BomIssueCode.UnresolvedComponent);
    }

    [Fact]
    public void A_virtual_component_is_not_unresolved()
    {
        Assert.Empty(BomValidator.Validate(Structured(Row("1", "GREASE", 1m, source: BomSourceDocument.Virtual()))).Issues);
    }

    // ---------------- hierarchy and limits ----------------

    [Fact]
    public void A_parts_only_row_with_children_is_an_error()
    {
        var result = BomValidator.Validate(PartsOnly(Row("1", "SUB", children: [Row("1.1", "PIN")])));
        Assert.Contains(result.Issues, i => i.Code == BomIssueCode.InvalidHierarchy && i.Path == "1");
    }

    [Fact]
    public void Nesting_deeper_than_the_limit_is_an_error_and_the_limit_itself_is_allowed()
    {
        static BomExtract Chain(int levels)
        {
            var row = Row("1", "L" + levels);
            for (var i = levels - 1; i >= 1; i--)
            {
                row = Row("1", "L" + i, children: [row]);
            }

            return Structured(row);
        }

        Assert.DoesNotContain(BomValidator.Validate(Chain(BomValidator.MaxDepth)).Issues, i => i.Code == BomIssueCode.InvalidHierarchy);
        var deep = BomValidator.Validate(Chain(BomValidator.MaxDepth + 1));
        Assert.Single(deep.Issues, i => i.Code == BomIssueCode.InvalidHierarchy);
    }

    [Fact]
    public void More_rows_than_the_limit_is_an_error()
    {
        var rows = Enumerable.Range(1, BomValidator.MaxRows + 1)
            .Select(i => Row(i.ToString(System.Globalization.CultureInfo.InvariantCulture), "P" + i))
            .ToArray();
        var result = BomValidator.Validate(PartsOnly(rows));
        Assert.Equal(BomIssueCode.TooManyRows, Assert.Single(result.Issues).Code);
    }

    // ---------------- text ----------------

    [Fact]
    public void Control_characters_and_lone_surrogates_are_errors()
    {
        // Explicit clean file names, so only the part number / description are bad.
        var result = BomValidator.Validate(Structured(
            Row("1", "P\u0000X", description: "ok", source: BomSourceDocument.Resolved("p.ipt")),
            Row("2", "Q", description: "bad \uD800 text", source: BomSourceDocument.Resolved("q.ipt"))));
        var invalid = result.Issues.Where(i => i.Code == BomIssueCode.InvalidText).ToArray();
        Assert.Equal(2, invalid.Length);
        Assert.Contains(invalid, i => i.Path == "1" && i.Message.Contains("part number", StringComparison.Ordinal));
        Assert.Contains(invalid, i => i.Path == "2" && i.Message.Contains("description", StringComparison.Ordinal));
    }

    [Fact]
    public void A_control_character_in_a_component_file_name_is_also_an_error()
    {
        var result = BomValidator.Validate(Structured(Row("1", "P", source: BomSourceDocument.Resolved("p\u0007.ipt"))));
        Assert.Contains(result.Issues, i => i.Code == BomIssueCode.InvalidText && i.Message.Contains("file name", StringComparison.Ordinal));
    }

    [Fact]
    public void Multi_line_descriptions_are_allowed()
    {
        Assert.Empty(BomValidator.Validate(Structured(Row("1", "P", description: "line 1\r\nline 2\tdetail"))).Issues);
    }

    // ---------------- determinism ----------------

    [Fact]
    public void Validation_is_deterministic_and_independent_of_input_order()
    {
        BomRow[] rows =
        [
            Row("1", null), Row("2", "P", 0m), Row("3", "Q", 1m, null),
            Row("4", "R", source: BomSourceDocument.Unresolved("r.ipt")), Row("5", "P"),
        ];

        var forward = BomValidator.Validate(Structured(rows)).Issues;
        var reversed = BomValidator.Validate(Structured(Enumerable.Reverse(rows).ToArray())).Issues;

        Assert.Equal(forward, reversed);
        Assert.Equal(5, forward.Count);
        // The repeated part number "P" (items 2 and 5) is a WARNING (distinct item numbers); the rest are errors.
        Assert.Equal(4, forward.Count(i => i.Severity == BomIssueSeverity.Error));
        Assert.Equal(BomIssueCode.DuplicateRow, Assert.Single(forward, i => i.Severity == BomIssueSeverity.Warning).Code);
    }
}

/// <summary>
/// Independent-review corrections 3 and 4: file-name-only enforcement and the
/// duplicate part-number policy.
/// </summary>
public sealed class BomFileNameAndDuplicatePolicyTests
{
    // =====================================================================
    // 3. File-name-only enforcement
    // =====================================================================

    public static readonly TheoryData<string> PathLikeNames = new()
    {
        "C:\\Work\\Vault\\bracket.ipt",          // Windows absolute
        "C:bracket.ipt",                         // drive-relative
        "\\\\fileserver\\cad\\bracket.ipt",      // UNC
        "\\\\?\\C:\\long\\bracket.ipt",          // extended-length
        "/home/designer/cad/bracket.ipt",        // Unix absolute
        "~/cad/bracket.ipt",                     // home-relative
        "parts/bracket.ipt",                     // relative with '/'
        "parts\\bracket.ipt",                    // relative with '\'
        "..\\bracket.ipt",                       // traversal
        "bracket.ipt:Zone.Identifier",           // NTFS stream
        "..",
        ".",
        "brack?et.ipt",
        "brack|et.ipt",
        "bracket.ipt.",
    };

    [Theory]
    [MemberData(nameof(PathLikeNames))]
    public void A_row_source_that_is_not_a_plain_file_name_is_reported_and_refused(string name)
    {
        var extract = Structured(Row("1", "BR-1", source: BomSourceDocument.Resolved(name)));

        var issue = Assert.Single(BomValidator.Validate(extract).Issues, i => i.Code == BomIssueCode.InvalidFileName);
        Assert.Equal(BomIssueSeverity.Error, issue.Severity);
        Assert.Equal("1", issue.Path);
        Assert.DoesNotContain("designer", issue.Message, StringComparison.Ordinal); // the path itself is never echoed

        foreach (var (entryName, run) in BomTraversalSafetyAndOrderingTests.ThrowingEntryPoints.Where(e => e.Name != "Flatten"))
        {
            var ex = Assert.Throws<BomIntegrityException>(() => run(extract));
            Assert.True(ex.Issues.All(i => i.Code == BomIssueCode.InvalidFileName), entryName);
        }
    }

    [Theory]
    [MemberData(nameof(PathLikeNames))]
    public void A_root_file_name_that_is_not_a_plain_file_name_is_reported_and_refused(string name)
    {
        var extract = Frame() with { RootFileName = name };

        var issue = Assert.Single(BomValidator.Validate(extract).Issues, i => i.Code == BomIssueCode.InvalidFileName);
        Assert.Null(issue.Path);
        Assert.Throws<BomIntegrityException>(() => BomCanonicalSerializer.ComputeSha256(extract));
        Assert.Throws<BomIntegrityException>(() => BomCsvWriter.Write(extract));
    }

    [Fact]
    public void Paths_are_reported_not_silently_stripped()
    {
        var extract = Structured(Row("1", "BR-1", source: BomSourceDocument.Resolved("C:\\Work\\bracket.ipt")));
        // No hash is produced at all (the stripped name "bracket.ipt" would hash fine),
        // and the refusal never echoes the path itself.
        var ex = Assert.Throws<BomIntegrityException>(() => BomCanonicalSerializer.Serialize(extract));
        Assert.Equal(BomIssueCode.InvalidFileName, Assert.Single(ex.Issues).Code);
        Assert.DoesNotContain("Work", ex.Message, StringComparison.Ordinal);
        Assert.Throws<BomIntegrityException>(() => BomCanonicalSerializer.ComputeSha256(extract));
        Assert.Matches("^[0-9a-f]{64}$",
            BomCanonicalSerializer.ComputeSha256(Structured(Row("1", "BR-1", source: BomSourceDocument.Resolved("bracket.ipt")))));
    }

    [Fact]
    public void A_resolved_non_virtual_source_without_a_file_name_is_an_error()
    {
        foreach (var name in new[] { null, "", "   " })
        {
            var extract = Structured(Row("1", "BR-1", source: new BomSourceDocument(name, IsResolved: true, IsVirtual: false)));
            Assert.Single(BomValidator.Validate(extract).Issues, i => i.Code == BomIssueCode.InvalidFileName);
            Assert.Throws<BomIntegrityException>(() => BomCsvWriter.Write(extract));
        }
    }

    [Fact]
    public void Virtual_components_and_unresolved_components_may_have_no_file_name()
    {
        Assert.Empty(BomValidator.Validate(Structured(Row("1", "GREASE", source: BomSourceDocument.Virtual()))).Issues);
        var unresolved = BomValidator.Validate(Structured(Row("1", "GONE", source: BomSourceDocument.Unresolved(null))));
        Assert.Equal(BomIssueCode.UnresolvedComponent, Assert.Single(unresolved.Issues).Code);
    }

    [Fact]
    public void An_unresolved_component_with_a_path_is_still_a_file_name_error()
    {
        var result = BomValidator.Validate(Structured(Row("1", "GONE", source: BomSourceDocument.Unresolved("D:\\Old\\gone.ipt"))));
        Assert.Contains(result.Issues, i => i.Code == BomIssueCode.InvalidFileName);
        Assert.Contains(result.Issues, i => i.Code == BomIssueCode.UnresolvedComponent);
    }

    public static readonly TheoryData<string> ReservedDeviceNames = new()
    {
        "CON", "con", "Prn", "aux", "NUL",
        "COM1", "com9", "LPT1", "lpt9",
        "COM¹", "lpt³",                // superscript digits are reserved too
        "con.txt", "NUL.ipt", "Aux.iam", "com1.ipt", "LPT2.idw",
        "con.tar.gz",                            // only the part before the first '.' counts
        "con .ipt", "NUL  .iam",                 // trailing spaces before the extension
        "CON ", " con",                          // surrounding whitespace is trimmed first
        "con.", "nul. ",                         // trailing dots (already refused as such)
    };

    [Theory]
    [MemberData(nameof(ReservedDeviceNames))]
    public void A_windows_reserved_device_name_is_reported_and_refused_as_row_source_and_root(string name)
    {
        var row = Structured(Row("1", "BR-1", source: BomSourceDocument.Resolved(name)));
        var rowIssue = Assert.Single(BomValidator.Validate(row).Issues, i => i.Code == BomIssueCode.InvalidFileName);
        Assert.Equal(BomIssueSeverity.Error, rowIssue.Severity);
        Assert.Equal("1", rowIssue.Path);
        Assert.StartsWith("The component file name ", rowIssue.Message, StringComparison.Ordinal);
        Assert.Throws<BomIntegrityException>(() => BomCanonicalSerializer.ComputeSha256(row));
        Assert.Throws<BomIntegrityException>(() => BomCsvWriter.Write(row));

        var root = Frame() with { RootFileName = name };
        var rootIssue = Assert.Single(BomValidator.Validate(root).Issues, i => i.Code == BomIssueCode.InvalidFileName);
        Assert.Null(rootIssue.Path);
        Assert.StartsWith("The assembly file name ", rootIssue.Message, StringComparison.Ordinal);
        Assert.Throws<BomIntegrityException>(() => BomCanonicalSerializer.ComputeSha256(root));
        Assert.Throws<BomIntegrityException>(() => BomCsvWriter.Write(root));
    }

    [Fact]
    public void A_reserved_device_name_has_its_own_message()
    {
        var issue = Assert.Single(
            BomValidator.Validate(Structured(Row("1", "BR-1", source: BomSourceDocument.Resolved("Con.ipt")))).Issues,
            i => i.Code == BomIssueCode.InvalidFileName);
        Assert.Equal(
            "The component file name is a reserved Windows device name (such as CON, NUL, COM1 or LPT1), with or without an extension.",
            issue.Message);
    }

    [Theory]
    [InlineData("bracket.con")]          // reserved word only as the extension
    [InlineData("console.ipt")]
    [InlineData("auxiliary.iam")]
    [InlineData("nul-bracket.ipt")]
    [InlineData("CON1.ipt")]
    [InlineData("COM10.ipt")]
    [InlineData("LPT.ipt")]
    [InlineData("my con.ipt")]
    [InlineData("ＣＯＮ.ipt")] // full-width CON: not reserved (NFC keeps it full-width)
    // Intentional exclusions from the conservative naming policy (see BomFileName):
    [InlineData("COM0")]
    [InlineData("COM0.ipt")]
    [InlineData("LPT0")]
    [InlineData("lpt0.ipt")]
    [InlineData("CONIN$")]
    [InlineData("conin$.ipt")]
    [InlineData("CONOUT$")]
    [InlineData("CONOUT$.ipt")]
    public void Names_that_merely_contain_a_reserved_word_or_are_excluded_by_policy_are_accepted(string name)
    {
        var extract = Structured(Row("1", "BR-1", source: BomSourceDocument.Resolved(name))) with { RootFileName = name };
        Assert.DoesNotContain(BomValidator.Validate(extract).Issues, i => i.Code == BomIssueCode.InvalidFileName);
        Assert.Matches("^[0-9a-f]{64}$", BomCanonicalSerializer.ComputeSha256(extract));
    }

    [Theory]
    [InlineData("bracket.ipt")]
    [InlineData("Bracket - LH (v2).ipt")]
    [InlineData("ISO 4762 M6x20.ipt")]
    [InlineData("M\u00F6bel-\u00D8 \u4E2D\u6587.iam")]
    [InlineData("=formula-looking.ipt")]
    [InlineData("no-extension")]
    [InlineData("..bracket.ipt")]
    public void Plain_file_names_are_accepted(string name)
    {
        var extract = Structured(Row("1", "BR-1", source: BomSourceDocument.Resolved(name))) with { RootFileName = name };
        Assert.DoesNotContain(BomValidator.Validate(extract).Issues, i => i.Code == BomIssueCode.InvalidFileName);
        Assert.Matches("^[0-9a-f]{64}$", BomCanonicalSerializer.ComputeSha256(extract));
        Assert.NotEmpty(BomCsvWriter.Write(extract));
    }

    // =====================================================================
    // 4. Duplicate part-number policy
    // =====================================================================

    [Fact]
    public void Repeated_part_numbers_with_distinct_item_numbers_are_warnings_and_are_not_merged()
    {
        var extract = Structured(Row("1", "SCREW", 4m), Row("2", "SCREW", 6m), Row("3", "SCREW", 2m));
        var result = BomValidator.Validate(extract);

        Assert.False(result.HasErrors);
        Assert.Equal(2, result.Warnings.Count(i => i.Code == BomIssueCode.DuplicateRow));

        // Nothing merged: three rows, original quantities.
        var quantities = BomTraversal.Flatten(extract).Select(e => e.Row.Quantity.Value).ToArray();
        Assert.Equal(new[] { 4m, 6m, 2m }, quantities);
        Assert.Equal(4, BomCsvWriter.Write(extract).Split("\r\n").Length - 1);
    }

    [Fact]
    public void Conflicting_duplicate_item_numbers_are_errors()
    {
        var result = BomValidator.Validate(Structured(Row("1", "SCREW"), Row("1", "SCREW")));
        Assert.Contains(result.Issues, i => i.Code == BomIssueCode.DuplicateItemNumber && i.Severity == BomIssueSeverity.Error);
        Assert.Contains(result.Issues, i => i.Code == BomIssueCode.DuplicateRow && i.Severity == BomIssueSeverity.Error);
    }

    [Fact]
    public void A_duplicate_item_number_with_different_part_numbers_is_still_an_error()
    {
        var result = BomValidator.Validate(Structured(Row("1", "A"), Row("1", "B")));
        Assert.Equal(BomIssueSeverity.Error, Assert.Single(result.Issues, i => i.Code == BomIssueCode.DuplicateItemNumber).Severity);
        Assert.DoesNotContain(result.Issues, i => i.Code == BomIssueCode.DuplicateRow);
    }

    [Fact]
    public void Repeated_part_numbers_without_item_numbers_cannot_be_told_apart_and_are_errors()
    {
        var result = BomValidator.Validate(Structured(Row(null, "SCREW", description: "a"), Row(null, "SCREW", description: "b")));
        Assert.Equal(BomIssueSeverity.Error, Assert.Single(result.Issues, i => i.Code == BomIssueCode.DuplicateRow).Severity);
    }

    [Fact]
    public void The_same_component_in_different_subassemblies_is_not_a_duplicate()
    {
        var result = BomValidator.Validate(Structured(
            Row("1", "SUB-A", children: [Row("1.1", "SCREW", 4m)]),
            Row("2", "SUB-B", children: [Row("2.1", "SCREW", 8m)])));
        Assert.Empty(result.Issues);
    }

    // ---------------- final review: duplicate validation is not quadratic ----------------

    private readonly Xunit.Abstractions.ITestOutputHelper _output;

    public BomFileNameAndDuplicatePolicyTests(Xunit.Abstractions.ITestOutputHelper output) => _output = output;

    private static BomRow[] SamePart(int count, Func<int, string?> item) =>
        Enumerable.Range(1, count).Select(i => Row(item(i), "SCREW", 1m)).ToArray();

    [Fact]
    public void A_maximum_size_bom_repeating_one_part_number_validates_quickly_with_warnings_only()
    {
        // MaxRows rows, ONE part number, distinct item numbers. The previous
        // linear scan over earlier item numbers made this ~5 x 10^9 steps.
        var extract = PartsOnly(SamePart(BomValidator.MaxRows, i => i.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        var watch = Stopwatch.StartNew();
        var result = BomValidator.Validate(extract);
        watch.Stop();
        _output.WriteLine($"Validate, {BomValidator.MaxRows:N0} rows sharing one part number: {watch.Elapsed.TotalMilliseconds:N0} ms");

        Assert.False(result.HasErrors);
        Assert.Equal(BomValidator.MaxRows - 1, result.Warnings.Count(i => i.Code == BomIssueCode.DuplicateRow));
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(20), $"took {watch.Elapsed}");
    }

    [Fact]
    public void Ambiguity_is_still_detected_at_scale_missing_and_repeated_item_numbers_are_errors()
    {
        // 1 row without an item number among 49,999 distinct ones. Rows are
        // checked in CANONICAL order, where a missing item number sorts last:
        // the 49,998 later distinct rows are warnings and the item-less row is
        // the one ambiguous ERROR.
        var withMissing = PartsOnly(SamePart(50_000, i => i == 1 ? null : i.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        var r1 = BomValidator.Validate(withMissing);
        var missingError = Assert.Single(r1.Errors, i => i.Code == BomIssueCode.DuplicateRow);
        Assert.Equal("#50000", missingError.Path);
        Assert.Equal(49_998, r1.Warnings.Count(i => i.Code == BomIssueCode.DuplicateRow));

        // Two rows without item numbers can never be told apart: both after the first are errors.
        var twoMissing = PartsOnly(SamePart(3, i => i == 3 ? "3" : null));
        var r3 = BomValidator.Validate(twoMissing);
        Assert.Equal(2, r3.Errors.Count(i => i.Code == BomIssueCode.DuplicateRow));
        Assert.Empty(r3.Warnings);

        // Distinct item numbers except the last row, which repeats the first.
        var withRepeat = PartsOnly(SamePart(50_000, i => i == 50_000 ? "1" : i.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        var r2 = BomValidator.Validate(withRepeat);
        Assert.Single(r2.Errors, i => i.Code == BomIssueCode.DuplicateItemNumber);
        Assert.Single(r2.Errors, i => i.Code == BomIssueCode.DuplicateRow);
        Assert.Equal(49_998, r2.Warnings.Count(i => i.Code == BomIssueCode.DuplicateRow));
    }

    [Fact]
    public void Validation_of_a_maximum_size_bom_with_distinct_rows_is_practical()
    {
        var rows = Enumerable.Range(1, BomValidator.MaxRows)
            .Select(i => Row(i.ToString(System.Globalization.CultureInfo.InvariantCulture), "P-" + i, 1m))
            .ToArray();
        var watch = Stopwatch.StartNew();
        var result = BomValidator.Validate(PartsOnly(rows));
        watch.Stop();
        _output.WriteLine($"Validate, {BomValidator.MaxRows:N0} distinct rows: {watch.Elapsed.TotalMilliseconds:N0} ms");
        Assert.Empty(result.Issues);
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(20), $"took {watch.Elapsed}");
    }

    [Fact]
    public void Duplicate_findings_never_merge_rows_or_quantities_at_scale()
    {
        var extract = PartsOnly(Enumerable.Range(1, 1_000)
            .Select(i => Row(i.ToString(System.Globalization.CultureInfo.InvariantCulture), "SCREW", i)).ToArray());
        Assert.Equal(1_000, BomTraversal.Flatten(extract).Count);
        Assert.Equal(Enumerable.Range(1, 1_000).Sum(), BomTraversal.Flatten(extract).Sum(e => (int)e.Row.Quantity.Value));
    }
}
