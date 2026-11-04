using Arch.CadConnect.Core.Workspace;
using Arch.CadConnect.Core.Workspace.Locking;

namespace Arch.CadConnect.Core.Tests.Workspace.Locking;

/// <summary>
/// P6 M4.4 Phase 2: the Get Latest nested-workspace entry check (pure, with a
/// scripted root lookup), and the refusal wording shown to the engineer.
/// </summary>
public class GetLatestNestingAndMessageTests
{
    private static WorkspacePlan Plan(params string[] relativePaths) => new()
    {
        Entries = relativePaths.Select((p, i) => new WorkspacePlanEntry
        {
            CadDocumentId = "cad-" + i,
            Placement = new WorkspacePlanPlacement { GeneratedRelativePath = p },
        }).ToArray(),
    };

    [Fact]
    public void Entries_of_a_new_workspace_or_of_the_root_itself_pass()
    {
        var plan = Plan("a.iam", "b.ipt");

        Assert.Empty(GetLatestNestingCheck.FindNestedEntries(plan, @"D:\WS", _ => null));
        Assert.Empty(GetLatestNestingCheck.FindNestedEntries(plan, @"D:\WS", _ => @"D:\WS"));
        Assert.Empty(GetLatestNestingCheck.FindNestedEntries(plan, @"D:\WS\", _ => @"d:\ws\"));
    }

    [Fact]
    public void Entries_that_would_land_in_another_workspace_are_each_reported()
    {
        var plan = Plan("a.iam", "b.ipt");

        var problems = GetLatestNestingCheck.FindNestedEntries(plan, @"D:\Outer\WS", _ => @"D:\Outer");

        Assert.Equal(2, problems.Count);
        Assert.All(problems, p => Assert.Equal(GetLatestNestingCheck.ProblemKind, p.Kind));
        Assert.Equal(new[] { "cad-0", "cad-1" }, problems.Select(p => p.CadDocumentId));
        Assert.Contains(@"D:\Outer", problems[0].Message);
        Assert.Equal("a.iam", problems[0].WorkspacePath);
    }

    [Fact]
    public void Only_the_entries_in_another_workspace_are_reported()
    {
        var plan = Plan("a.iam", "b.ipt");

        var problems = GetLatestNestingCheck.FindNestedEntries(plan, @"D:\WS", p => p.EndsWith("b.ipt", StringComparison.Ordinal) ? @"D:\Other" : null);

        Assert.Equal("cad-1", Assert.Single(problems).CadDocumentId);
    }

    [Fact]
    public void An_unusable_entry_path_is_left_to_the_materializer()
    {
        var lookups = 0;

        var problems = GetLatestNestingCheck.FindNestedEntries(Plan("../escape.ipt", "sub/x.ipt"), @"D:\WS", _ => { lookups++; return @"D:\Other"; });

        Assert.Empty(problems);
        Assert.Equal(0, lookups);
    }

    // ---- messages -----------------------------------------------------------------------------

    public static TheoryData<string> AllCodes()
    {
        var data = new TheoryData<string>();
        foreach (var field in typeof(WorkspaceLockErrorCodes).GetFields().Where(f => f.IsLiteral))
        {
            data.Add((string)field.GetValue(null)!);
        }
        return data;
    }

    [Theory]
    [MemberData(nameof(AllCodes))]
    public void Every_refusal_code_has_words_that_say_nothing_was_sent_or_changed(string code)
    {
        var text = WorkspaceLockMessages.Describe(new WorkspaceLockRefusal(code, Path: @"D:\WS"));

        Assert.EndsWith("Nothing was sent to the server and nothing was changed.", text, StringComparison.Ordinal);
        Assert.DoesNotContain("lock-", text.Replace(code, ""), StringComparison.Ordinal);
        Assert.True(text.Length > 60, text);
    }

    [Fact]
    public void A_live_holder_on_this_machine_is_named_for_the_engineer()
    {
        var holder = WorkspaceLockHolderRecord.ForCurrentProcess("Get Latest", LockMode.Exclusive) with { MachineName = "ENG-PC-7" };

        var text = WorkspaceLockMessages.Describe(new WorkspaceLockRefusal(
            WorkspaceLockErrorCodes.WorkspaceLocked, LockScope.Workspace, LockMode.Exclusive, @"D:\WS", Holder: holder, HolderProcessId: holder.ProcessId));

        Assert.Contains("Get Latest", text);
        Assert.Contains("ENG-PC-7", text);
        Assert.Contains(holder.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture), text);
    }

    [Fact]
    public void Without_a_live_holder_the_message_does_not_guess()
    {
        var text = WorkspaceLockMessages.Describe(new WorkspaceLockRefusal(WorkspaceLockErrorCodes.WorkspaceLocked, Path: @"D:\WS"));

        Assert.Contains("possibly on another computer", text);
        Assert.DoesNotContain("process", text);
    }
}
