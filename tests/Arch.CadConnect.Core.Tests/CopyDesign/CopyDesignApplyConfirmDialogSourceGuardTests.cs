using System.Text.RegularExpressions;

namespace Arch.CadConnect.Core.Tests.CopyDesign;

/// <summary>
/// P6 Milestone 2: the WinForms confirmation and its controller wiring have
/// no UI test harness (see <c>CopyDesignPreviewZeroMutationSourceTests</c>),
/// so cancellation, the disabled Apply button and the confirmed-fingerprint
/// hand-off are locked in at source level.
/// </summary>
public class CopyDesignApplyConfirmDialogSourceGuardTests
{
    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "Arch.CadConnect.sln")))
        {
            dir = dir.Parent;
        }
        return dir?.FullName ?? throw new InvalidOperationException("Repository root (Arch.CadConnect.sln) not found.");
    }

    private static string Code(params string[] relative) =>
        Regex.Replace(File.ReadAllText(Path.Combine(new[] { RepoRoot(), "src" }.Concat(relative).ToArray())), @"//.*$", "", RegexOptions.Multiline);

    private static string Dialog() => Code("Arch.CadConnect.Inventor", "Ui", "CopyDesignApplyConfirmDialog.cs");

    private static string ApplyMethod()
    {
        var controller = Code("Arch.CadConnect.Inventor", "ArchAddInController.cs");
        var start = controller.IndexOf("private void RunCopyDesignApply(CopyDesignPlan plan)", StringComparison.Ordinal);
        Assert.True(start >= 0, "RunCopyDesignApply not found - source layout changed.");
        var end = controller.IndexOf("\n    private ", start + 10, StringComparison.Ordinal);
        return controller[start..end];
    }

    [Fact]
    public void The_dialog_renders_the_full_confirmation_and_never_the_old_count_only_summary()
    {
        var dialog = Dialog();

        Assert.Contains("public CopyDesignApplyConfirmDialog(CopyDesignApplyConfirmation confirmation)", dialog, StringComparison.Ordinal);
        Assert.Contains("CopyDesignApplyConfirmationTextReport.Render(confirmation)", dialog, StringComparison.Ordinal);
        Assert.DoesNotContain("CopyDesignApplyConfirmDialog(CopyDesignPlan plan)", dialog, StringComparison.Ordinal);
    }

    [Fact]
    public void Apply_is_enabled_only_by_the_typed_confirmation_and_Enter_never_applies()
    {
        var dialog = Dialog();

        // M4.1 T6 follow-up: Apply starts disabled and only the typed APPLY N
        // phrase (which itself requires CanApply) enables it - on every text
        // change, and again on the click itself.
        Assert.Contains("_apply.Enabled = false;", dialog, StringComparison.Ordinal);
        Assert.DoesNotContain("_apply.Enabled = confirmation.CanApply;", dialog, StringComparison.Ordinal);
        Assert.Contains(
            "_apply.Enabled = CopyDesignApplyTypedConfirmation.IsSatisfied(confirmation, _typed.Text);",
            dialog, StringComparison.Ordinal);
        Assert.Contains(
            "if (!CopyDesignApplyTypedConfirmation.IsSatisfied(confirmation, _typed.Text))",
            dialog, StringComparison.Ordinal);
        Assert.Equal(2, Regex.Matches(dialog, @"_apply\.Enabled = ").Count);  // the two above, nothing else
        Assert.Contains("AcceptButton = _cancel;", dialog, StringComparison.Ordinal);
        Assert.Contains("CancelButton = _cancel;", dialog, StringComparison.Ordinal);
        Assert.Single(Regex.Matches(dialog, @"DialogResult = DialogResult\.OK"));
    }

    [Fact]
    public void Cancelling_or_a_blocked_confirmation_returns_before_any_attempt_is_minted_or_executed()
    {
        var method = ApplyMethod();

        var build = method.IndexOf("CopyDesignApplyConfirmationBuilder.Build(plan, destinationExists: SafeFileExists)", StringComparison.Ordinal);
        var guard = method.IndexOf("!= DialogResult.OK || !confirmation.CanApply)", StringComparison.Ordinal);
        var mint = method.IndexOf("CopyDesignApplyAttempt.StartNewAttempt()", StringComparison.Ordinal);
        var execute = method.IndexOf("ExecuteCopyDesignAttempt(", StringComparison.Ordinal);

        Assert.True(build >= 0 && guard > build, "The confirmation must be built from the plan before the dialog result is checked.");
        Assert.True(mint > guard && execute > mint, "No attempt may be minted or executed before the OK + CanApply guard.");
    }

    [Fact]
    public void The_confirmed_fingerprint_is_handed_to_the_orchestrator_for_a_fresh_Apply()
    {
        Assert.Contains("confirmedFingerprint: confirmation.Fingerprint", ApplyMethod(), StringComparison.Ordinal);
        Assert.Contains("orchestrator.ExecuteAsync(plan, idempotencyKey, label, ct, confirmedFingerprint)",
            Code("Arch.CadConnect.Inventor", "ArchAddInController.cs"), StringComparison.Ordinal);
    }
}
