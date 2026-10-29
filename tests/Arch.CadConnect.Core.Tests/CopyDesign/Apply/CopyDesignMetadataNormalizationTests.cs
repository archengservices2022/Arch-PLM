using Arch.CadConnect.Core.CopyDesign.Apply;

namespace Arch.CadConnect.Core.Tests.CopyDesign.Apply;

/// <summary>
/// P6 METADATA FIX (P1 "temporary name in Part Number"): the PURE Part Number
/// policy, the temp-name leak detector, and the verification evaluator's
/// leak rule. The first live acceptance run produced Part Number
/// ".p6c-tmp-664164fdc80849babfa2b6b25a1a3d36-ARCH-TEST-002" in the final
/// ARCH-TEST-002.ipt - that exact value is used as the regression case.
/// </summary>
public class CopyDesignMetadataNormalizationTests
{
    private const string LiveTempFileName = ".p6c-tmp-664164fdc80849babfa2b6b25a1a3d36-ARCH-TEST-002.ipt";
    private const string LiveLeakedPartNumber = ".p6c-tmp-664164fdc80849babfa2b6b25a1a3d36-ARCH-TEST-002";

    // ---- Part Number policy ----------------------------------------------

    [Fact]
    public void The_live_acceptance_leak_is_replaced_with_the_final_file_stem()
    {
        var decision = CopyDesignPartNumberPolicy.Decide(LiveLeakedPartNumber, LiveTempFileName, "ARCH-TEST-002.ipt");

        Assert.Equal(CopyDesignPartNumberDecisionKind.Replace, decision.Kind);
        Assert.Equal("ARCH-TEST-002", decision.NewPartNumber);
        Assert.Null(decision.FailureReason);
    }

    [Theory]
    [InlineData(".p6c-tmp-c8b2d48a370543b39a99955fc28e9ca1-P6DNEW-REAL-ROOT.iam", "P6DNEW-REAL-ROOT.iam", "P6DNEW-REAL-ROOT")]
    [InlineData(".p6c-tmp-0cdf54fa3687420bbdbddbe8a93a9a07-P6DNEW-REAL-ROOT.idw", "P6DNEW-REAL-ROOT.idw", "P6DNEW-REAL-ROOT")]
    [InlineData(".p6c-tmp-0cdf54fa3687420bbdbddbe8a93a9a07-SHEET-1.dwg", "SHEET-1.dwg", "SHEET-1")]
    [InlineData(".p6c-tmp-0cdf54fa3687420bbdbddbe8a93a9a07-A.B.ipt", "A.B.ipt", "A.B")]
    public void An_exact_temp_stem_is_replaced_for_every_document_type(string tempFileName, string finalFileName, string expected)
    {
        var leaked = Path.GetFileNameWithoutExtension(tempFileName);

        var decision = CopyDesignPartNumberPolicy.Decide(leaked, tempFileName, finalFileName);

        Assert.Equal(CopyDesignPartNumberDecisionKind.Replace, decision.Kind);
        Assert.Equal(expected, decision.NewPartNumber);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void An_empty_Part_Number_is_preserved(string? current)
    {
        var decision = CopyDesignPartNumberPolicy.Decide(current, LiveTempFileName, "ARCH-TEST-002.ipt");

        Assert.Equal(CopyDesignPartNumberDecisionKind.Keep, decision.Kind);
        Assert.Null(decision.NewPartNumber);
    }

    [Theory]
    [InlineData("ARCH-TEST-002")] // already the final name
    [InlineData("ARCH-TEST-001")] // an explicitly assigned (source) number
    [InlineData("PN-123")]        // an explicitly assigned custom number
    [InlineData("   ")]           // whitespace is not a leak
    public void A_final_name_or_explicit_custom_Part_Number_is_preserved_unchanged(string current)
    {
        var decision = CopyDesignPartNumberPolicy.Decide(current, LiveTempFileName, "ARCH-TEST-002.ipt");

        Assert.Equal(CopyDesignPartNumberDecisionKind.Keep, decision.Kind);
        Assert.Null(decision.NewPartNumber);
        Assert.Null(decision.FailureReason);
    }

    [Theory]
    [InlineData(".p6c-tmp-ffffffffffffffffffffffffffffffff-ARCH-TEST-002")] // a DIFFERENT attempt's temp stem
    [InlineData(".P6C-TMP-664164FDC80849BABFA2B6B25A1A3D36-ARCH-TEST-002")] // case variant - not an exact match
    [InlineData(".p6c-tmp-664164fdc80849babfa2b6b25a1a3d36-ARCH-TEST-002 rev A")] // decorated
    [InlineData("p6c-tmp-664164fdc80849babfa2b6b25a1a3d36-ARCH-TEST-002")] // leading dot dropped
    [InlineData(LiveTempFileName)] // the full temp name including extension
    public void A_temp_token_in_any_unexpected_form_is_rejected(string current)
    {
        var decision = CopyDesignPartNumberPolicy.Decide(current, LiveTempFileName, "ARCH-TEST-002.ipt");

        Assert.Equal(CopyDesignPartNumberDecisionKind.Reject, decision.Kind);
        Assert.Null(decision.NewPartNumber);
        Assert.Contains("temporary file name", decision.FailureReason, StringComparison.Ordinal);
    }

    [Fact]
    public void Without_a_reported_temp_name_a_token_is_rejected_and_a_custom_value_is_kept()
    {
        Assert.Equal(CopyDesignPartNumberDecisionKind.Reject,
            CopyDesignPartNumberPolicy.Decide(LiveLeakedPartNumber, null, "ARCH-TEST-002.ipt").Kind);
        Assert.Equal(CopyDesignPartNumberDecisionKind.Keep,
            CopyDesignPartNumberPolicy.Decide("PN-123", null, "ARCH-TEST-002.ipt").Kind);
    }

    [Fact]
    public void A_blank_final_file_name_is_a_programming_error()
    {
        Assert.Throws<ArgumentException>(() => CopyDesignPartNumberPolicy.Decide("x", LiveTempFileName, " "));
    }

    // ---- leak detector ----------------------------------------------------

    [Fact]
    public void Every_generated_temp_name_is_recognized_by_the_leak_detector()
    {
        var temp = CopyDesignAtomicPromotion.NewTempPath(@"C:\dst\ARCH-TEST-002.ipt");
        var name = Path.GetFileName(temp);

        Assert.StartsWith(CopyDesignAtomicPromotion.TempFileNamePrefix, name, StringComparison.Ordinal);
        Assert.True(CopyDesignTempNameLeak.Contains(Path.GetFileNameWithoutExtension(name)));
    }

    [Theory]
    [InlineData(null, false)]
    [InlineData("", false)]
    [InlineData("ARCH-TEST-002", false)]
    [InlineData("tmp-p6c", false)]
    [InlineData(LiveLeakedPartNumber, true)]
    [InlineData("prefix P6C-TMP-abc", true)]
    public void The_leak_detector_is_case_insensitive_and_substring_based(string? value, bool expected)
    {
        Assert.Equal(expected, CopyDesignTempNameLeak.Contains(value));
    }

    // ---- verification evaluator -------------------------------------------

    private static CopyDesignNodeVerificationFacts Facts(
        IReadOnlyList<CopyDesignStringPropertyFact>? properties, bool propertyEnumerationSucceeded = true) => new(
        "cad-1", @"C:\src\ARCH-TEST-001.ipt", @"C:\dst\ARCH-TEST-002.ipt",
        DestinationExists: true, DocumentTypeMatches: true, OpenableThroughInventor: true,
        ResultingSha256: "resulthash", ResultingFileSize: 143360L,
        SourceSha256BeforeOperation: "samehash", SourceSha256AfterOperation: "samehash",
        ReferenceResolutions: Array.Empty<CopyDesignReferenceResolutionFact>(),
        ActualComponentOccurrences: Array.Empty<CopyDesignActualComponentOccurrence>(),
        StringProperties: properties,
        PropertyEnumerationSucceeded: propertyEnumerationSucceeded);

    [Fact]
    public void A_leaked_Part_Number_fails_verification_and_names_the_property()
    {
        var result = CopyDesignVerificationEvaluator.Evaluate(Facts(new[]
        {
            new CopyDesignStringPropertyFact("Design Tracking Properties", "Part Number", LiveLeakedPartNumber),
        }));

        Assert.False(result.Passed);
        Assert.Contains(result.Reasons, r => r.Contains("Design Tracking Properties / Part Number", StringComparison.Ordinal)
            && r.Contains(LiveLeakedPartNumber, StringComparison.Ordinal));
    }

    [Fact]
    public void A_leak_in_ANY_other_string_iProperty_also_fails_verification()
    {
        var result = CopyDesignVerificationEvaluator.Evaluate(Facts(new[]
        {
            new CopyDesignStringPropertyFact("Design Tracking Properties", "Part Number", "ARCH-TEST-002"),
            new CopyDesignStringPropertyFact("Inventor Summary Information", "Title", "copy of .p6c-tmp-abc-ARCH-TEST-002"),
        }));

        Assert.False(result.Passed);
        Assert.Single(result.Reasons);
        Assert.Contains("Inventor Summary Information / Title", result.Reasons[0], StringComparison.Ordinal);
    }

    [Fact]
    public void Clean_normalized_and_custom_properties_pass_verification()
    {
        var result = CopyDesignVerificationEvaluator.Evaluate(Facts(new[]
        {
            new CopyDesignStringPropertyFact("Design Tracking Properties", "Part Number", "PN-123"),
            new CopyDesignStringPropertyFact("Inventor Summary Information", "Title", ""),
        }));

        Assert.True(result.Passed);
        Assert.Empty(result.Reasons);
    }

    [Fact]
    public void A_failed_iProperty_read_fails_verification_even_with_no_properties_listed()
    {
        var result = CopyDesignVerificationEvaluator.Evaluate(Facts(Array.Empty<CopyDesignStringPropertyFact>(), propertyEnumerationSucceeded: false));

        Assert.False(result.Passed);
        Assert.Contains(result.Reasons, r => r.Contains("iProperties could not be read", StringComparison.Ordinal));
    }

    [Fact]
    public void Facts_from_a_gatherer_that_predates_the_fix_still_evaluate_as_before()
    {
        // null StringProperties + the default PropertyEnumerationSucceeded -
        // exactly the shape every pre-fix construction site produces.
        Assert.True(CopyDesignVerificationEvaluator.Evaluate(Facts(null)).Passed);
    }
}
