using Arch.CadConnect.Core.CopyDesign;
using Arch.CadConnect.Core.CopyDesign.Apply;

using static Arch.CadConnect.Core.Tests.CopyDesign.Apply.CopyDesignApplyFixtures;

namespace Arch.CadConnect.Core.Tests.CopyDesign.Apply;

/// <summary>
/// M4.1 T6 follow-up: the typed <c>RECOVER N</c> phrase that unlocks Recover
/// Copy Design, and the shared exact-match rule. N is the number of COPY
/// entries in the SAME request mapping the orchestrator replays - every one
/// of them is still pending, because Recover only exists after the
/// reservation call itself failed (nothing is copied before that answer).
/// </summary>
public class CopyDesignRecoverTypedConfirmationTests
{
    private const string Key = "cadconnect-p6c-0123456789abcdef0123456789abcdef";

    private static readonly CopyDesignNode Root = CopyNode("doc-root", @"C:\src\ROOT.iam", @"C:\dst\NEW-ROOT.iam", CadDocumentType.Iam, isRoot: true);
    private static readonly CopyDesignNode PartA = CopyNode("doc-a", @"C:\src\PART-A.ipt", @"C:\dst\NEW-PART-A.ipt");
    private static readonly CopyDesignNode PartB = CopyNode("doc-b", @"C:\src\PART-B.ipt", @"C:\dst\NEW-PART-B.ipt");
    private static readonly CopyDesignNode Drawing = CopyNode("doc-dwg", @"C:\src\ROOT.idw", @"C:\dst\NEW-ROOT.idw", CadDocumentType.Idw);
    private static readonly CopyDesignNode ReusedPart = ReuseNode("doc-lib", @"C:\lib\BOLT.ipt");

    /// <summary>The T6 shape: root, two parts and the root's drawing.</summary>
    private static CopyDesignPlan FourFilePlan() => Plan(new[] { Root, PartA, PartB, Drawing });

    [Fact]
    public void The_T6_shaped_attempt_asks_for_RECOVER_4()
    {
        var prepared = CopyDesignRecoverTypedConfirmation.Prepare(FourFilePlan(), Key);

        Assert.True(prepared.CanConfirm);
        Assert.Equal(4, prepared.FilesToCopy);
        Assert.Equal("RECOVER 4", prepared.Phrase);
    }

    [Fact]
    public void N_is_exactly_the_COPY_entries_of_the_request_the_orchestrator_replays()
    {
        var plan = Plan(new[] { Root, PartA, ReusedPart, Drawing });

        var prepared = CopyDesignRecoverTypedConfirmation.Prepare(plan, Key);
        var replayed = CopyDesignApplyRequestMapper.Map(plan, Key, label: null, includeDrawings: true);

        Assert.True(replayed.Success);
        Assert.Equal(replayed.Request!.Entries.Count(e => e.Entry.Action == CopyDesignApplyEntryAction.Copy), prepared.FilesToCopy);
        Assert.Equal(3, prepared.FilesToCopy);          // the reused part is neither copied nor materialized
        Assert.Equal("RECOVER 3", prepared.Phrase);
    }

    [Fact]
    public void A_model_files_only_plan_does_not_count_its_drawing()
    {
        var plan = FourFilePlan() with { ModelFilesOnlyAcknowledged = true };

        var prepared = CopyDesignRecoverTypedConfirmation.Prepare(plan, Key);

        Assert.Equal(3, prepared.FilesToCopy);
        Assert.Equal("RECOVER 3", prepared.Phrase);
    }

    [Fact]
    public void A_plan_the_orchestrator_could_not_map_is_never_confirmable()
    {
        var prepared = CopyDesignRecoverTypedConfirmation.Prepare(Plan(new[] { Root, PartA }, isExecutable: false), Key);

        Assert.False(prepared.CanConfirm);
        Assert.Null(prepared.Phrase);
        Assert.NotNull(prepared.Reason);
        Assert.False(CopyDesignRecoverTypedConfirmation.IsSatisfied(prepared, "RECOVER 2"));
        Assert.False(CopyDesignRecoverTypedConfirmation.IsSatisfied(prepared, "RECOVER 0"));
    }

    [Fact]
    public void An_attempt_with_nothing_to_copy_is_never_confirmable()
    {
        var prepared = CopyDesignRecoverTypedConfirmation.Prepare(Plan(new[] { ReusedPart }), Key);

        Assert.False(prepared.CanConfirm);
        Assert.False(CopyDesignRecoverTypedConfirmation.IsSatisfied(prepared, "RECOVER 0"));
    }

    [Theory]
    [InlineData("RECOVER 4")]
    [InlineData("  RECOVER 4 ")]
    [InlineData("\tRECOVER 4\r\n")]
    public void The_exact_phrase_is_accepted_ignoring_only_leading_and_trailing_whitespace(string typed)
    {
        Assert.True(CopyDesignRecoverTypedConfirmation.IsSatisfied(CopyDesignRecoverTypedConfirmation.Prepare(FourFilePlan(), Key), typed));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("recover 4")]
    [InlineData("Recover 4")]
    [InlineData("RECOVER")]
    [InlineData("RECOVER 3")]
    [InlineData("RECOVER 5")]
    [InlineData("RECOVER 04")]
    [InlineData("RECOVER  4")]
    [InlineData("RECOVER4")]
    [InlineData("RECOVER 4 files")]
    [InlineData("APPLY 4")]       // the other dialogs' phrases never unlock Recover
    [InlineData("RESUME 4")]
    [InlineData("ＲＥＣＯＶＥＲ ４")]
    public void Any_other_text_does_not_enable_Recover(string? typed)
    {
        Assert.False(CopyDesignRecoverTypedConfirmation.IsSatisfied(CopyDesignRecoverTypedConfirmation.Prepare(FourFilePlan(), Key), typed));
    }

    [Fact]
    public void Arguments_are_validated()
    {
        Assert.Throws<ArgumentNullException>(() => CopyDesignRecoverTypedConfirmation.Prepare(null!, Key));
        Assert.Throws<ArgumentException>(() => CopyDesignRecoverTypedConfirmation.Prepare(FourFilePlan(), " "));
        Assert.Throws<ArgumentNullException>(() => CopyDesignRecoverTypedConfirmation.IsSatisfied(null!, "RECOVER 4"));
    }

    // ---- the shared matching rule -----------------------------------------

    [Theory]
    [InlineData("APPLY 4", "APPLY 4", true)]
    [InlineData("APPLY 4", " APPLY 4 ", true)]
    [InlineData("APPLY 4", "apply 4", false)]
    [InlineData("APPLY 4", "APPLY  4", false)]
    [InlineData("APPLY 4", null, false)]
    [InlineData("RECOVER 2", "RECOVER 2", true)]
    [InlineData("RECOVER 2", "RECOVER 20", false)]
    public void TypedConfirmationPhrase_matches_exactly_after_trimming(string expected, string? typed, bool matches)
    {
        Assert.Equal(matches, TypedConfirmationPhrase.Matches(expected, typed));
    }

    [Theory]
    [InlineData("")]
    [InlineData("  ")]
    public void A_blank_expected_phrase_is_a_programming_error(string expected)
    {
        Assert.Throws<ArgumentException>(() => TypedConfirmationPhrase.Matches(expected, expected));
    }
}
