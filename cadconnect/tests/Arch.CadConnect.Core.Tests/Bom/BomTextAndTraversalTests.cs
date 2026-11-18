using System.Collections;
using System.Diagnostics;
using Arch.CadConnect.Core.Bom;
using static Arch.CadConnect.Core.Tests.Bom.BomFixtures;

namespace Arch.CadConnect.Core.Tests.Bom;

public sealed class BomTextAndTraversalTests
{
    // ---------------- BomText.FormatDecimal ----------------

    [Theory]
    [InlineData("1.50", "1.5")]
    [InlineData("1.5", "1.5")]
    [InlineData("2.000", "2")]
    [InlineData("0.1", "0.1")]
    [InlineData("0.0000000001", "0.0000000001")]
    [InlineData("1250.500", "1250.5")]
    [InlineData("100", "100")]
    [InlineData("1000000", "1000000")]
    [InlineData("-3.250", "-3.25")]
    [InlineData("0.000", "0")]
    public void FormatDecimal_is_exact_invariant_and_has_no_trailing_zeros(string input, string expected)
    {
        var value = decimal.Parse(input, System.Globalization.CultureInfo.InvariantCulture);
        Assert.Equal(expected, BomText.FormatDecimal(value));
    }

    [Fact]
    public void FormatDecimal_keeps_full_decimal_precision_and_never_uses_an_exponent()
    {
        Assert.Equal("0.1234567890123456789012345678", BomText.FormatDecimal(0.1234567890123456789012345678m));
        Assert.Equal("79228162514264337593543950335", BomText.FormatDecimal(decimal.MaxValue));
        Assert.Equal("0.0000000000000000000000000001", BomText.FormatDecimal(0.0000000000000000000000000001m));
        Assert.Equal("0.3", BomText.FormatDecimal(0.1m + 0.2m)); // exact - no binary floating point
    }

    [Fact]
    public void FormatDecimal_formats_negative_zero_as_zero()
    {
        var negativeZero = decimal.Negate(0.000m);
        Assert.Equal("0", BomText.FormatDecimal(negativeZero));
    }

    [Fact]
    public void FormatDecimal_ignores_the_current_culture()
    {
        var original = System.Globalization.CultureInfo.CurrentCulture;
        try
        {
            System.Globalization.CultureInfo.CurrentCulture = new System.Globalization.CultureInfo("de-DE");
            Assert.Equal("1250.5", BomText.FormatDecimal(1250.5m));
        }
        finally
        {
            System.Globalization.CultureInfo.CurrentCulture = original;
        }
    }

    // ---------------- BomText.Normalize ----------------

    [Fact]
    public void Normalize_trims_maps_empty_to_null_and_preserves_case_and_inner_spaces()
    {
        Assert.Null(BomText.Normalize(null));
        Assert.Null(BomText.Normalize(""));
        Assert.Null(BomText.Normalize("   \t "));
        Assert.Equal("Steel,  Mild", BomText.Normalize("  Steel,  Mild \r\n"));
        Assert.Equal("aBc", BomText.Normalize("aBc"));
    }

    [Fact]
    public void Normalize_applies_unicode_NFC()
    {
        var decomposed = "Möbel"; // o + combining diaeresis
        var composed = "Möbel";
        Assert.Equal(composed, BomText.Normalize(decomposed));
    }

    [Fact]
    public void Normalize_replaces_lone_surrogates_and_keeps_valid_pairs()
    {
        Assert.Equal("a�b", BomText.Normalize("a\uD800b"));
        Assert.Equal("a�b", BomText.Normalize("a\uDC00b"));
        Assert.Equal("x\U0001F600y", BomText.Normalize("x\U0001F600y"));
        Assert.True(BomText.HasLoneSurrogate("a\uD800"));
        Assert.False(BomText.HasLoneSurrogate("x\U0001F600y"));
    }

    [Fact]
    public void Control_characters_other_than_tab_cr_lf_are_detected()
    {
        Assert.True(BomText.HasDisallowedControlCharacter("a\u0000b"));
        Assert.True(BomText.HasDisallowedControlCharacter("a\u001Bb"));
        Assert.True(BomText.HasDisallowedControlCharacter("a\u0085b"));
        Assert.False(BomText.HasDisallowedControlCharacter("line 1\r\nline 2\tx"));
    }

    // ---------------- BomTraversal ----------------

    [Fact]
    public void Flatten_is_depth_first_with_levels_and_paths()
    {
        var entries = BomTraversal.Flatten(Frame());

        Assert.Equal(
            new[] { "1", "2", "2/2.1", "2/2.2", "3" },
            entries.Select(e => e.Path).ToArray());
        Assert.Equal(new[] { 1, 1, 2, 2, 1 }, entries.Select(e => e.Level).ToArray());
        Assert.Equal(new[] { "BR-001", "SUB-200", "PIN-010", "SCR-M6", "TUBE-25" }, entries.Select(e => e.Row.PartNumber).ToArray());
    }

    [Fact]
    public void Siblings_sort_by_natural_item_number_regardless_of_input_order()
    {
        var extract = Structured(
            Row("10", "J"), Row("2", "B"), Row("1", "A"), Row("1.10", "Z"), Row("1.9", "Y"), Row(null, "N"), Row("01", "A0"));

        var order = BomTraversal.Flatten(extract).Select(e => e.Row.PartNumber).ToArray();

        // "1" < "01" (same value, shorter first) < "1.9" < "1.10" < "2" < "10" < (no item number last)
        Assert.Equal(new[] { "A", "A0", "Y", "Z", "B", "J", "N" }, order);
    }

    [Fact]
    public void Rows_without_item_numbers_get_stable_position_tokens()
    {
        var extract = Structured(Row(null, "B"), Row(null, "A"));
        var paths = BomTraversal.Flatten(extract).Select(e => e.Path).ToArray();
        Assert.Equal(new[] { "#1", "#2" }, paths); // sorted by part number: A then B
        Assert.Equal("A", BomTraversal.Flatten(extract)[0].Row.PartNumber);
    }

    [Theory]
    [InlineData("1", "2", -1)]
    [InlineData("2", "10", -1)]
    [InlineData("1.2", "1.10", -1)]
    [InlineData("1", "1.1", -1)]
    [InlineData("1", "01", -1)]
    [InlineData("A", "B", -1)]
    [InlineData("3", "3", 0)]
    public void Item_numbers_compare_naturally(string a, string b, int expectedSign)
    {
        Assert.Equal(expectedSign, Math.Sign(BomTraversal.CompareItemNumbers(a, b)));
        Assert.Equal(-expectedSign, Math.Sign(BomTraversal.CompareItemNumbers(b, a)));
    }

    [Fact]
    public void Very_deep_hierarchies_are_rejected_deterministically_without_stack_overflow()
    {
        var row = Row("x", "LEAF");
        for (var i = 0; i < 20_000; i++)
        {
            row = Row("x", "P" + i, children: [row]);
        }

        var ex = Assert.Throws<BomIntegrityException>(() => BomTraversal.Flatten(Structured(row)));
        Assert.Equal(BomIssueCode.InvalidHierarchy, Assert.Single(ex.Issues).Code);
    }
}

/// <summary>
/// Independent-review corrections 1 and 2: bounded, cycle-safe traversal with
/// lazily built paths, and a deterministic, transitive total ordering.
/// </summary>
public sealed class BomTraversalSafetyAndOrderingTests
{
    // =====================================================================
    // Helpers
    // =====================================================================

    /// <summary>Every public entry point, each forced to fully process the extract.</summary>
    internal static readonly (string Name, Action<BomExtract> Run)[] ThrowingEntryPoints =
    [
        ("Flatten", e => BomTraversal.Flatten(e)),
        ("Serialize", e => BomCanonicalSerializer.Serialize(e)),
        ("ComputeSha256", e => BomCanonicalSerializer.ComputeSha256(e)),
        ("CsvWrite", e => BomCsvWriter.Write(e)),
        ("CsvWriteUtf8", e => BomCsvWriter.WriteUtf8(e)),
    ];

    internal static void AssertEveryEntryPointRefuses(BomExtract extract, BomIssueCode code)
    {
        foreach (var (name, run) in ThrowingEntryPoints)
        {
            var watch = Stopwatch.StartNew();
            var ex = Assert.Throws<BomIntegrityException>(() => run(extract));
            Assert.True(ex.Issues.Any(i => i.Code == code), $"{name}: expected {code}, got {string.Join(", ", ex.Issues.Select(i => i.Code))}");
            Assert.True(watch.Elapsed < TimeSpan.FromSeconds(10), $"{name} took {watch.Elapsed}");
        }

        var result = BomValidator.Validate(extract);
        Assert.Contains(result.Issues, i => i.Code == code && i.Severity == BomIssueSeverity.Error);
    }

    private static BomRow WithChildren(BomRow row, IReadOnlyList<BomRow> children) => row with { Children = children };

    private static BomExtract Chain(int levels)
    {
        var row = Row("1", "L" + levels);
        for (var i = levels - 1; i >= 1; i--)
        {
            row = Row("1", "L" + i, children: [row]);
        }

        return Structured(row);
    }

    /// <summary>A list that claims a huge size; reading any element fails the test.</summary>
    private sealed class HugeList(int count) : IReadOnlyList<BomRow>
    {
        public int Count => count;

        public BomRow this[int index] => throw new InvalidOperationException("The list was read before its size was checked.");

        public IEnumerator<BomRow> GetEnumerator() => throw new InvalidOperationException("The list was enumerated before its size was checked.");

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    /// <summary>
    /// A hostile collection: every Count read reports one MORE row than the
    /// last, and every element read returns a brand-new row. Code that reads
    /// it more than once would see different children each time.
    /// </summary>
    private sealed class ChangingList(int initialCount) : IReadOnlyList<BomRow>
    {
        private int _count = initialCount;

        public int CountReads { get; private set; }

        public int ElementReads { get; private set; }

        public int Count
        {
            get
            {
                CountReads++;
                return _count++;
            }
        }

        public BomRow this[int index]
        {
            get
            {
                ElementReads++;
                return Row("c." + ElementReads.ToString(System.Globalization.CultureInfo.InvariantCulture), "CHG-" + ElementReads);
            }
        }

        public IEnumerator<BomRow> GetEnumerator() => throw new InvalidOperationException("Enumeration is not expected.");

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    /// <summary>Claims a Count but fails part-way through reading.</summary>
    private sealed class FailingList(int count, int failAt) : IReadOnlyList<BomRow>
    {
        public int Count => count;

        public BomRow this[int index] => index >= failAt
            ? throw new ArgumentOutOfRangeException(nameof(index))
            : Row("f" + index.ToString(System.Globalization.CultureInfo.InvariantCulture), "F" + index);

        public IEnumerator<BomRow> GetEnumerator() => throw new InvalidOperationException("Enumeration is not expected.");

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    /// <summary>Counts how often a wrapped (stable) list is read.</summary>
    private sealed class CountingList(IReadOnlyList<BomRow> inner) : IReadOnlyList<BomRow>
    {
        public int CountReads { get; private set; }

        public int ElementReads { get; private set; }

        public int Count
        {
            get
            {
                CountReads++;
                return inner.Count;
            }
        }

        public BomRow this[int index]
        {
            get
            {
                ElementReads++;
                return inner[index];
            }
        }

        public IEnumerator<BomRow> GetEnumerator() => inner.GetEnumerator();

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    // =====================================================================
    // Final review: shared-row snapshot and traversal limits
    // =====================================================================

    [Fact]
    public void A_changing_child_collection_is_read_exactly_once_and_every_shared_occurrence_expands_identically()
    {
        var changing = new ChangingList(2);
        var shared = WithChildren(Row("9", "SHARED"), changing);
        var extract = Structured(Row("1", "SUB-A", children: [shared]), Row("2", "SUB-B", children: [shared]));

        var entries = BomTraversal.Flatten(extract);

        Assert.Equal(1, changing.CountReads);   // Count captured once
        Assert.Equal(2, changing.ElementReads); // each element read once
        var underA = entries.Where(e => e.Path.StartsWith("1/9/", StringComparison.Ordinal)).Select(e => e.Row.PartNumber).ToArray();
        var underB = entries.Where(e => e.Path.StartsWith("2/9/", StringComparison.Ordinal)).Select(e => e.Row.PartNumber).ToArray();
        Assert.Equal(2, underA.Length);
        Assert.Equal(underA, underB);           // the same snapshot for both occurrences
        Assert.Equal(new[] { "CHG-1", "CHG-2" }, underA);
    }

    [Fact]
    public void Each_entry_point_reads_a_changing_collection_once_per_build()
    {
        foreach (var (name, run) in new (string, Action<BomExtract>)[]
        {
            ("Validate", e => BomValidator.Validate(e)),
            ("Serialize", e => BomCanonicalSerializer.Serialize(e)),
            ("CsvWrite", e => BomCsvWriter.Write(e)),
        })
        {
            var changing = new ChangingList(3);
            var shared = WithChildren(Row("9", "SHARED"), changing);
            run(Structured(Row("1", "A", children: [shared]), Row("2", "B", children: [shared]), Row("3", "C", children: [shared])));
            Assert.True(changing.CountReads == 1 && changing.ElementReads == 3, $"{name}: Count read {changing.CountReads}x, elements read {changing.ElementReads}x");
        }
    }

    [Fact]
    public void A_collection_that_fails_while_being_read_is_refused_as_an_integrity_problem()
    {
        AssertEveryEntryPointRefuses(Structured(WithChildren(Row("1", "P"), new FailingList(3, failAt: 1))), BomIssueCode.InvalidHierarchy);
        AssertEveryEntryPointRefuses(Structured(Row("1", "P")) with { Rows = new FailingList(2, failAt: 0) }, BomIssueCode.InvalidHierarchy);
    }

    [Fact]
    public void Repeated_shared_subtrees_are_counted_per_occurrence_but_read_and_copied_once()
    {
        // node_k has children [node_(k-1), node_(k-1)]: 2^(k+1) - 1 occurrences.
        static (BomRow Root, List<CountingList> Lists) Doubling(int k)
        {
            var lists = new List<CountingList>();
            var row = Row("1", "N0");
            for (var i = 1; i <= k; i++)
            {
                var list = new CountingList(new[] { row, row });
                lists.Add(list);
                row = WithChildren(Row(i % 2 == 0 ? "1" : "2", "N" + i), list);
            }

            return (row, lists);
        }

        var (accepted, lists) = Doubling(15); // 65,535 occurrences
        var watch = Stopwatch.StartNew();
        Assert.Equal(65_535, BomTraversal.Flatten(Structured(accepted)).Count);
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(10), $"took {watch.Elapsed}");
        Assert.All(lists, l => Assert.True(l.CountReads == 1 && l.ElementReads == 2, $"Count {l.CountReads}x, elements {l.ElementReads}x"));

        var (refused, _) = Doubling(16); // 131,071 occurrences > MaxRows
        AssertEveryEntryPointRefuses(Structured(refused), BomIssueCode.TooManyRows);
    }

    [Fact]
    public void A_shared_subtree_that_fits_at_its_first_occurrence_is_refused_when_a_later_occurrence_is_too_deep()
    {
        // Shared subtree of height 10. First occurrence at level 2; the second
        // is placed under a chain so its deepest row lands exactly on / one
        // past MaxDepth. Only the shared-row depth charge can catch this.
        static BomRow SharedOfHeight(int height)
        {
            var row = Row("1", "S" + height);
            for (var i = height - 1; i >= 1; i--)
            {
                row = Row("1", "S" + i, children: [row]);
            }

            return row;
        }

        // The shared row's second occurrence sits at exactly `sharedLevel`
        // (hosts occupy levels 1 .. sharedLevel-1); its first sits at level 2.
        static BomExtract Placed(BomRow shared, int sharedLevel)
        {
            var host = Row(sharedLevel - 1 == 1 ? "2" : "1", "H" + (sharedLevel - 1), children: [shared]);
            for (var level = sharedLevel - 2; level >= 1; level--)
            {
                host = Row(level == 1 ? "2" : "1", "H" + level, children: [host]);
            }

            return Structured(Row("1", "FIRST-HOST", children: [shared]), host);
        }

        var sharedRow = SharedOfHeight(10);
        var fits = Placed(sharedRow, BomValidator.MaxDepth - 10 + 1);        // deepest row exactly at MaxDepth
        Assert.Equal(BomValidator.MaxDepth, BomTraversal.Flatten(fits).Max(e => e.Level));
        Assert.Equal(11, BomTraversal.Flatten(fits).Where(e => e.Path.StartsWith("1/", StringComparison.Ordinal)).Max(e => e.Level));
        Assert.DoesNotContain(BomValidator.Validate(fits).Issues, i => i.Code == BomIssueCode.InvalidHierarchy);

        AssertEveryEntryPointRefuses(Placed(sharedRow, BomValidator.MaxDepth - 10 + 2), BomIssueCode.InvalidHierarchy); // one past
    }

    [Fact]
    public void Shared_subtrees_at_exactly_the_row_limit_are_accepted_and_one_more_row_is_refused()
    {
        var children = Enumerable.Range(1, 49_999)
            .Select(i => Row(i.ToString(System.Globalization.CultureInfo.InvariantCulture), "K" + i)).ToArray();
        var shared = Row("1", "SHARED", children: children);       // 50,000 occurrences each

        Assert.Equal(BomValidator.MaxRows, BomTraversal.Flatten(Structured(shared, shared)).Count);
        AssertEveryEntryPointRefuses(Structured(shared, shared, Row("3", "ONE-MORE")), BomIssueCode.TooManyRows);
    }

    [Fact]
    public void A_cycle_reached_through_a_shared_row_is_detected()
    {
        // P -> S, Q -> S, S -> Q : S is shared and Q is reachable back from S.
        var sChildren = new List<BomRow>();
        var s = WithChildren(Row("9", "S"), sChildren);
        var q = Row("2", "Q", children: [s]);
        sChildren.Add(q);
        AssertEveryEntryPointRefuses(Structured(Row("1", "P", children: [s]), q), BomIssueCode.CyclicHierarchy);
    }

    // =====================================================================
    // 1. Bounded traversal and cycle protection
    // =====================================================================

    [Fact]
    public void A_self_cycle_is_refused_by_every_entry_point_without_hanging()
    {
        var children = new List<BomRow>();
        var self = WithChildren(Row("1", "SELF"), children);
        children.Add(self);

        AssertEveryEntryPointRefuses(Structured(self), BomIssueCode.CyclicHierarchy);
    }

    [Fact]
    public void An_indirect_cycle_is_refused_by_every_entry_point()
    {
        var aChildren = new List<BomRow>();
        var a = WithChildren(Row("1", "A"), aChildren);
        var c = Row("1.1.1", "C", children: [a]);
        var b = Row("1.1", "B", children: [c]);
        aChildren.Add(b);

        AssertEveryEntryPointRefuses(Structured(Row("0", "TOP", children: [a])), BomIssueCode.CyclicHierarchy);
    }

    [Fact]
    public void A_shared_subtree_is_not_a_cycle_and_is_expanded_under_each_parent()
    {
        var shared = Row("9", "SCREW", 4m);
        var extract = Structured(Row("1", "SUB-A", children: [shared]), Row("2", "SUB-B", children: [shared]));

        Assert.Equal(new[] { "1", "1/9", "2", "2/9" }, BomTraversal.Flatten(extract).Select(e => e.Path).ToArray());
        Assert.Empty(BomValidator.Validate(extract).Issues);
        Assert.Equal(5, BomCsvWriter.Write(extract).Split("\r\n").Length - 1); // header + 4 rows
    }

    [Fact]
    public void The_depth_limit_itself_is_accepted_by_every_entry_point()
    {
        var extract = Chain(BomValidator.MaxDepth);
        Assert.Equal(BomValidator.MaxDepth, BomTraversal.Flatten(extract)[^1].Level);
        Assert.Contains($"\"level\":{BomValidator.MaxDepth}", BomCanonicalSerializer.Serialize(extract), StringComparison.Ordinal);
        Assert.NotEmpty(BomCsvWriter.Write(extract));
        Assert.Empty(BomValidator.Validate(extract).Issues);
    }

    [Fact]
    public void One_level_past_the_depth_limit_is_refused_by_every_entry_point()
    {
        AssertEveryEntryPointRefuses(Chain(BomValidator.MaxDepth + 1), BomIssueCode.InvalidHierarchy);
    }

    [Fact]
    public void Exactly_the_row_limit_is_accepted_and_one_more_is_refused()
    {
        BomRow[] Rows(int n) => Enumerable.Range(1, n)
            .Select(i => Row(i.ToString(System.Globalization.CultureInfo.InvariantCulture), "P" + i))
            .ToArray();

        Assert.Equal(BomValidator.MaxRows, BomTraversal.Flatten(PartsOnly(Rows(BomValidator.MaxRows))).Count);
        AssertEveryEntryPointRefuses(PartsOnly(Rows(BomValidator.MaxRows + 1)), BomIssueCode.TooManyRows);
    }

    [Fact]
    public void Excessive_width_is_refused_before_the_list_is_read_or_sorted()
    {
        AssertEveryEntryPointRefuses(Structured(Row("1", "WIDE", children: [])) with { Rows = new HugeList(int.MaxValue) }, BomIssueCode.TooManyRows);
        var parent = WithChildren(Row("1", "PARENT"), new HugeList(BomValidator.MaxRows));
        AssertEveryEntryPointRefuses(Structured(parent), BomIssueCode.TooManyRows); // 1 parent + MaxRows children
    }

    [Fact]
    public void A_shared_subtree_explosion_is_refused_quickly()
    {
        // 30 levels, each row's two children are the SAME row: 2^30 occurrences if expanded.
        var row = Row("1", "LEAF");
        for (var i = 0; i < 30; i++)
        {
            row = Row("1", "N" + i, children: [row, row]);
        }

        AssertEveryEntryPointRefuses(Structured(row), BomIssueCode.TooManyRows);
    }

    [Fact]
    public void Null_and_incomplete_rows_are_refused_deterministically()
    {
        AssertEveryEntryPointRefuses(Structured(Row("1", "P", children: [null!])), BomIssueCode.InvalidHierarchy);
        AssertEveryEntryPointRefuses(Structured(Row("1", "P") with { Quantity = null! }), BomIssueCode.InvalidHierarchy);
        AssertEveryEntryPointRefuses(Structured(Row("1", "P") with { Source = null! }), BomIssueCode.InvalidHierarchy);
    }

    [Fact]
    public void Deep_assemblies_with_long_item_numbers_do_not_build_a_path_per_row()
    {
        // 64 levels, 20,000-character item numbers. Eagerly built paths would
        // total sum(1..64) x 20,000 = 41.6 million characters (~83 MB).
        static string Item(int level) => new string((char)('a' + (level % 26)), 20_000);
        var row = Row(Item(BomValidator.MaxDepth), "L" + BomValidator.MaxDepth);
        for (var level = BomValidator.MaxDepth - 1; level >= 1; level--)
        {
            row = Row(Item(level), "L" + level, children: [row]);
        }

        var extract = Structured(row);
        const long budget = 40L * 1024 * 1024;
        foreach (var (name, run) in new (string, Action)[]
        {
            ("Validate", () => Assert.Empty(BomValidator.Validate(extract).Issues)),
            ("ComputeSha256", () => BomCanonicalSerializer.ComputeSha256(extract)),
            ("CsvWrite", () => BomCsvWriter.Write(extract)),
            ("Flatten", () => BomTraversal.Flatten(extract)),
        })
        {
            run(); // warm-up (JIT)
            var before = GC.GetAllocatedBytesForCurrentThread();
            run();
            var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
            Assert.True(allocated < budget, $"{name} allocated {allocated:N0} bytes (budget {budget:N0}).");
        }

        // Paths are still exact when actually requested.
        var deepest = BomTraversal.Flatten(extract)[^1];
        Assert.Equal(BomValidator.MaxDepth, deepest.Level);
        Assert.Equal(string.Join('/', Enumerable.Range(1, BomValidator.MaxDepth).Select(Item)), deepest.Path);
    }

    [Fact]
    public void Issue_paths_are_exact_for_nested_rows_and_position_tokens()
    {
        var result = BomValidator.Validate(Structured(
            Row("2", "SUB", children: [Row(null, null), Row("2.5", "OK", children: [Row("2.5.1", null)])])));
        var paths = result.Issues.Where(i => i.Code == BomIssueCode.MissingPartNumber).Select(i => i.Path).ToArray();
        Assert.Equal(new[] { "2/2.5/2.5.1", "2/#2" }, paths);
    }

    [Fact]
    public void A_null_children_list_is_treated_as_no_children()
    {
        var extract = Structured(Row("1", "P") with { Children = null! });
        Assert.Single(BomTraversal.Flatten(extract));
        Assert.Empty(BomValidator.Validate(extract).Issues);
    }

    [Fact]
    public void Integrity_failures_are_identical_on_every_run()
    {
        var children = new List<BomRow>();
        var self = WithChildren(Row("1", "SELF"), children);
        children.Add(self);
        var first = BomValidator.Validate(Structured(self)).Issues;
        for (var i = 0; i < 5; i++)
        {
            Assert.Equal(first, BomValidator.Validate(Structured(self)).Issues);
        }
    }

    // =====================================================================
    // 2. Deterministic total ordering
    // =====================================================================

    private static readonly string?[] ItemSamples =
    [
        "1", "01", "001", "2", "9", "10", "100", "1.1", "1.01", "1.9", "1.10", "1.10.1", "1A", "1B", "A", "a", "B",
        "A.1", "A.10", "A.9", "1.A", "1.B", "10.2", "2.10", "x", "x.9", "9.x", "", ".", "1.", ".1", "1..1",
        "0", "00", "99999999999999999999999999999999", "100000000000000000000000000000000", null,
    ];

    [Fact]
    public void Item_number_comparison_is_a_total_order_reflexive_antisymmetric_and_transitive()
    {
        foreach (var a in ItemSamples)
        {
            Assert.Equal(0, BomTraversal.CompareItemNumbers(a, a));
            foreach (var b in ItemSamples)
            {
                var ab = Math.Sign(BomTraversal.CompareItemNumbers(a, b));
                var ba = Math.Sign(BomTraversal.CompareItemNumbers(b, a));
                Assert.Equal(-ab, ba);
                Assert.Equal(a == b, ab == 0); // only identical values compare equal

                foreach (var c in ItemSamples)
                {
                    if (ab <= 0 && Math.Sign(BomTraversal.CompareItemNumbers(b, c)) <= 0)
                    {
                        Assert.True(BomTraversal.CompareItemNumbers(a, c) <= 0, $"not transitive: {a} <= {b} <= {c}");
                    }
                }
            }
        }
    }

    [Fact]
    public void The_previously_non_transitive_triple_is_now_ordered_consistently()
    {
        // Before the correction: 9 < 10 (numeric), 10 < 1A and 1A < 9 (ordinal) - a cycle.
        Assert.True(BomTraversal.CompareItemNumbers("9", "10") < 0);
        Assert.True(BomTraversal.CompareItemNumbers("10", "1A") < 0);
        Assert.True(BomTraversal.CompareItemNumbers("9", "1A") < 0);
    }

    [Fact]
    public void Mixed_identifiers_sort_in_the_documented_order()
    {
        var rows = new[] { "A", "1A", "10", "2", "1.10", "1.9", "01", "1", "A.1" }
            .Select((item, i) => Row(item, "P" + i)).Append(Row(null, "PN")).ToArray();
        var order = BomTraversal.Flatten(Structured(rows)).Select(e => e.Row.ItemNumber).ToArray();
        Assert.Equal(new string?[] { "1", "01", "1.9", "1.10", "2", "10", "1A", "A", "A.1", null }, order);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(6)]
    [InlineData(7)]
    [InlineData(8)]
    public void Permutations_of_siblings_never_change_the_canonical_text_hash_or_csv(int seed)
    {
        BomRow[] Siblings() =>
        [
            Row("1", "A"), Row("01", "A0"), Row("1A", "MIX"), Row("10", "TEN"), Row("9", "NINE"),
            Row(null, "NOITEM-1", description: "first"), Row(null, "NOITEM-1", description: "second"), // equal item + part, different content
            Row("5", "SAME", description: "x", children: [Row("5.1", "CHILD-A")]),
            Row("5", "SAME", description: "x", children: [Row("5.1", "CHILD-B")]),                      // identical own fields, different subtree
            Row("7", "REP"), Row("8", "REP"),
        ];

        var reference = Structured(Siblings());

        // ONE seeded generator per shuffle (a generator recreated per element
        // would return the same key every time and leave the order unchanged).
        var orderRng = new Random(seed);
        var shuffled = Structured(Siblings().OrderBy(_ => orderRng.Next()).ToArray());
        var swapRng = new Random(seed + 1_000);
        var permuted = Siblings();
        for (var i = permuted.Length - 1; i > 0; i--)
        {
            var j = swapRng.Next(i + 1);
            (permuted[i], permuted[j]) = (permuted[j], permuted[i]);
        }

        // Each variant must genuinely present the rows in a different input order.
        static string InputOrder(BomExtract e) =>
            string.Join("|", e.Rows.Select(r => $"{r.ItemNumber}/{r.PartNumber}/{r.Description}/{r.Children.FirstOrDefault()?.PartNumber}"));
        var variants = new[] { shuffled, Structured(permuted), Structured(Enumerable.Reverse(Siblings()).ToArray()) };
        foreach (var variant in variants)
        {
            Assert.NotEqual(InputOrder(reference), InputOrder(variant));
        }

        Assert.NotEqual(InputOrder(variants[0]), InputOrder(variants[1]));

        foreach (var variant in variants)
        {
            Assert.Equal(BomCanonicalSerializer.Serialize(reference), BomCanonicalSerializer.Serialize(variant));
            Assert.Equal(BomCanonicalSerializer.ComputeSha256(reference), BomCanonicalSerializer.ComputeSha256(variant));
            Assert.Equal(BomCsvWriter.Write(reference), BomCsvWriter.Write(variant));
            Assert.Equal(BomValidator.Validate(reference).Issues, BomValidator.Validate(variant).Issues);
        }
    }

    [Fact]
    public void Rows_with_equal_item_and_part_numbers_are_ordered_by_content()
    {
        var a = Structured(Row(null, "P", description: "beta"), Row(null, "P", description: "alpha"));
        var descriptions = BomTraversal.Flatten(a).Select(e => e.Row.Description).ToArray();
        Assert.Equal(new[] { "alpha", "beta" }, descriptions); // by canonical own fields, not input position
    }

    [Fact]
    public void The_golden_and_purely_numeric_canonical_output_is_unchanged_by_the_new_ordering()
    {
        // Numeric dotted item numbers sort exactly as before the correction.
        var text = BomCanonicalSerializer.Serialize(Structured(Row("10", "J"), Row("2", "B"), Row("1.10", "Z"), Row("1", "A", children: [Row("1.2", "C"), Row("1.10", "D")])));
        var parts = System.Text.RegularExpressions.Regex.Matches(text, "\"partNumber\":\"([^\"]+)\"").Select(m => m.Groups[1].Value).ToArray();
        Assert.Equal(new[] { "A", "C", "D", "Z", "B", "J" }, parts);
    }
}
