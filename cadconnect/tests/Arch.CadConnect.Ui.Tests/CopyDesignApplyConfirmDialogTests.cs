using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using System.Windows.Forms;

using Arch.CadConnect.Core;
using Arch.CadConnect.Core.CopyDesign.Apply;
using Arch.CadConnect.Inventor.Ui;

namespace Arch.CadConnect.Ui.Tests;

/// <summary>
/// M4.1 T6 follow-up: UI-level proof for the Copy Design Apply confirmation.
/// Apply is enabled only by typing the exact <c>APPLY N</c> phrase; Cancel,
/// Esc, Enter, the title-bar X and every other input never let Apply run; and
/// a focused, enabled Apply button behaves like a click.
///
/// "Apply runs" is modelled exactly as the controller gates it
/// (<c>RunCopyDesignApply</c>: the orchestrator is built only when
/// <c>ShowDialog</c> returned OK AND the confirmation CanApply - pinned by
/// <see cref="The_controller_applies_only_on_OK_and_CanApply"/>). The dialog
/// is the unchanged shipped source; no server, no Inventor, no files, and the
/// Copy-to-Clipboard button is never activated (it would overwrite the
/// user's clipboard).
/// </summary>
public class CopyDesignApplyConfirmDialogTests
{
    private const string Phrase = "APPLY 4";

    private static CopyDesignApplyConfirmation Confirmation(bool canApply) => new(
        Rows: new[] { "ROOT.iam", "PART-A.ipt", "PART-B.ipt", "ROOT.idw" }
            .Select(name => new CopyDesignApplyConfirmationRow(CopyDesignApplyEntryAction.Copy, CadDocumentType.Ipt,
                "P6D-REAL-" + name, null, "T6Z-REAL-" + name, null, @"C:\NotUsed\Dest"))
            .ToArray(),
        Issues: Array.Empty<Core.CopyDesign.CopyDesignPlanIssue>(),
        DestinationFolders: new[] { @"C:\NotUsed\Dest" },
        ModelFilesOnly: false,
        Fingerprint: canApply ? "test-fingerprint" : null,
        CanApply: canApply);

    /// <summary>Runs the dialog through <paramref name="steps"/>, then applies
    ///  the controller's gate; returns how often the stand-in for the
    ///  orchestrator ran.</summary>
    private static (DialogRun Run, int ApplyInvocations) RunGated(bool canApply, params Action<Form>[] steps)
    {
        var confirmation = Confirmation(canApply);
        var run = DialogHarness.Run(() => new CopyDesignApplyConfirmDialog(confirmation), steps);
        var invocations = run.Result == DialogResult.OK && confirmation.CanApply ? 1 : 0; // = ExecuteCopyDesignAttempt
        return (run, invocations);
    }

    private static Button Apply(Form f) => DialogHarness.Named<Button>(f, "apply");
    private static Button Cancel(Form f) => DialogHarness.Named<Button>(f, "cancel");
    private static TextBox Typed(Form f) => DialogHarness.Named<TextBox>(f, "typedConfirmation");
    private static void TypePhrase(Form f) => DialogHarness.Type(f, Phrase);
    private static void Close(Form f) => f.Close();

    private static void AssertCancelledWithoutApply((DialogRun Run, int Applied) outcome)
    {
        Assert.False(outcome.Run.StayedOpen);
        Assert.Equal(DialogResult.Cancel, outcome.Run.Result);
        Assert.Equal(0, outcome.Applied);
    }

    // ---- typed confirmation ------------------------------------------------

    [Fact]
    public void Apply_is_disabled_until_the_exact_phrase_is_typed_and_the_box_has_the_initial_focus()
    {
        bool? before = null, after = null;
        string? initialFocus = null;
        RunGated(true,
            f => { initialFocus = DialogHarness.Focused(f)?.Name; before = Apply(f).Enabled; },
            TypePhrase,
            f => after = Apply(f).Enabled,
            Close);

        Assert.Equal("typedConfirmation", initialFocus);
        Assert.False(before);
        Assert.True(after);
    }

    [Theory]
    [InlineData("apply 4")]
    [InlineData("Apply 4")]
    [InlineData("APPLY")]
    [InlineData("APPLY ")]
    [InlineData("APPLY 3")]
    [InlineData("APPLY 5")]
    [InlineData("APPLY 44")]
    [InlineData("APPLY  4")]
    [InlineData("APPLY4")]
    [InlineData("APPLY 4 files")]
    public void Typing_anything_but_the_exact_phrase_keeps_Apply_disabled(string typed)
    {
        bool? enabled = null;
        var outcome = RunGated(true,
            f => DialogHarness.Type(f, typed),
            f => enabled = Apply(f).Enabled,
            f => Apply(f).PerformClick(),   // a click on the disabled button does nothing
            f => { });

        Assert.False(enabled);
        Assert.True(outcome.Run.StayedOpen);
        Assert.Equal(0, outcome.ApplyInvocations);
    }

    [Fact]
    public void Leading_and_trailing_spaces_are_ignored()
    {
        bool? enabled = null;
        RunGated(true, f => DialogHarness.Type(f, "   " + Phrase + "  "), f => enabled = Apply(f).Enabled, Close);

        Assert.True(enabled);
    }

    [Fact]
    public void Changing_or_clearing_the_text_disables_Apply_immediately()
    {
        var states = new List<bool>();
        RunGated(true,
            TypePhrase, f => states.Add(Apply(f).Enabled),          // APPLY 4  -> on
            f => DialogHarness.Type(f, "\b"), f => states.Add(Apply(f).Enabled), // APPLY    -> off
            f => DialogHarness.Type(f, "4"), f => states.Add(Apply(f).Enabled),  // APPLY 4  -> on
            f => DialogHarness.Type(f, "4"), f => states.Add(Apply(f).Enabled),  // APPLY 44 -> off
            f => DialogHarness.Type(f, "\b"), f => states.Add(Apply(f).Enabled), // APPLY 4  -> on
            f => DialogHarness.Type(f, new string('\b', Phrase.Length)), f => states.Add(Apply(f).Enabled), // cleared -> off
            Close);

        Assert.Equal(new[] { true, false, true, false, true, false }, states);
    }

    // ---- Cancel / Esc / Enter / X never apply ------------------------------

    [Fact]
    public void Clicking_Cancel_closes_without_Apply__even_after_the_phrase()
    {
        AssertCancelledWithoutApply(RunGated(true, TypePhrase, f => Cancel(f).PerformClick()));
    }

    [Fact]
    public void Enter_in_the_empty_confirmation_box_does_nothing()
    {
        bool? openAfterEnter = null;
        string? focusAfterEnter = null;
        var outcome = RunGated(true,
            f => DialogHarness.PressKey(f, Keys.Enter),
            f => { openAfterEnter = f.Visible; focusAfterEnter = DialogHarness.Focused(f)?.Name; },
            Close);

        Assert.True(openAfterEnter);
        Assert.Equal("typedConfirmation", focusAfterEnter);
        AssertCancelledWithoutApply(outcome);
    }

    [Fact]
    public void Enter_in_the_confirmation_box_does_nothing__even_with_the_exact_phrase()
    {
        string? focus = null, text = null;
        bool? openAfterEnter = null, applyEnabledAfterEnter = null;
        var outcome = RunGated(true,
            TypePhrase,
            f => focus = DialogHarness.Focused(f)?.Name,
            f => DialogHarness.PressKey(f, Keys.Enter),
            f => { openAfterEnter = f.Visible; text = Typed(f).Text; applyEnabledAfterEnter = Apply(f).Enabled; },
            f => DialogHarness.PressKey(f, Keys.Escape));

        Assert.Equal("typedConfirmation", focus);
        Assert.True(openAfterEnter);                 // not closed, not applied
        Assert.Equal(Phrase, text);                  // nothing inserted
        Assert.True(applyEnabledAfterEnter);         // and the phrase still counts
        AssertCancelledWithoutApply(outcome);        // Esc afterwards still cancels
    }

    [Theory]
    [InlineData("typedConfirmation")]
    [InlineData("report")]
    [InlineData("cancel")]
    [InlineData("apply")]
    public void Esc_cancels_wherever_the_focus_is__even_on_an_enabled_Apply(string focus)
    {
        AssertCancelledWithoutApply(RunGated(true,
            TypePhrase,
            f => f.ActiveControl = DialogHarness.Named<Control>(f, focus),
            f => DialogHarness.PressKey(f, Keys.Escape)));
    }

    [Theory]
    [InlineData(Keys.Enter)]
    [InlineData(Keys.Space)]
    public void Enter_or_Space_on_a_focused_Cancel_cancels(Keys key)
    {
        AssertCancelledWithoutApply(RunGated(true,
            TypePhrase,
            f => f.ActiveControl = Cancel(f),
            f => DialogHarness.PressKey(f, key)));
    }

    [Fact]
    public void Enter_in_the_report_cancels()
    {
        AssertCancelledWithoutApply(RunGated(true,
            TypePhrase,
            f => f.ActiveControl = DialogHarness.Named<TextBox>(f, "report"),
            f => DialogHarness.PressKey(f, Keys.Enter)));
    }

    [Fact]
    public void The_title_bar_close_box_cancels__even_after_the_phrase()
    {
        AssertCancelledWithoutApply(RunGated(true, TypePhrase, DialogHarness.CloseBox));
    }

    // ---- focused-button keyboard activation --------------------------------

    [Fact]
    public void Tab_never_reaches_Apply_while_it_is_disabled()
    {
        var visited = new List<string?>();
        var steps = new List<Action<Form>>();
        for (var i = 0; i < 10; i++)
        {
            steps.Add(f => DialogHarness.PressKey(f, Keys.Tab));
            steps.Add(f => visited.Add(DialogHarness.Focused(f)?.Name));
        }
        steps.Add(f => DialogHarness.PressKey(f, Keys.Escape));

        var outcome = RunGated(true, steps.ToArray());

        Assert.DoesNotContain("apply", visited);
        Assert.Contains("cancel", visited);           // the cycle really moved through the buttons
        AssertCancelledWithoutApply(outcome);
    }

    [Fact]
    public void Once_enabled_Tab_can_reach_Apply()
    {
        var visited = new List<string?>();
        var steps = new List<Action<Form>> { TypePhrase };
        for (var i = 0; i < 10; i++)
        {
            steps.Add(f => DialogHarness.PressKey(f, Keys.Tab));
            steps.Add(f => visited.Add(DialogHarness.Focused(f)?.Name));
        }
        steps.Add(f => DialogHarness.PressKey(f, Keys.Escape));

        var outcome = RunGated(true, steps.ToArray());

        Assert.Contains("apply", visited);
        AssertCancelledWithoutApply(outcome);
    }

    /// <summary>Standard Windows behavior, kept as a tested, known fact: an
    ///  ENABLED Apply button that has keyboard focus is activated by Enter or
    ///  Space exactly like a click. It can only be focused after the exact
    ///  phrase was typed, so this is still a deliberate act.</summary>
    [Theory]
    [InlineData(Keys.Enter)]
    [InlineData(Keys.Space)]
    public void A_key_press_on_a_focused_enabled_Apply_applies_like_a_click(Keys key)
    {
        var outcome = RunGated(true,
            TypePhrase,
            f => f.ActiveControl = Apply(f),
            f => DialogHarness.PressKey(f, key));

        Assert.False(outcome.Run.StayedOpen);
        Assert.Equal(DialogResult.OK, outcome.Run.Result);
        Assert.Equal(1, outcome.ApplyInvocations);
    }

    // ---- only a deliberate Apply applies -----------------------------------

    [Fact]
    public void Clicking_Apply_after_the_exact_phrase_applies_exactly_once()
    {
        var outcome = RunGated(true, TypePhrase, f => Apply(f).PerformClick());

        Assert.False(outcome.Run.StayedOpen);
        Assert.Equal(DialogResult.OK, outcome.Run.Result);
        Assert.Equal(1, outcome.ApplyInvocations);
    }

    [Fact]
    public void Clicking_Apply_without_the_phrase_does_nothing()
    {
        var outcome = RunGated(true, f => Apply(f).PerformClick(), f => { });

        Assert.True(outcome.Run.StayedOpen);
        Assert.NotEqual(DialogResult.OK, outcome.Run.Result);
        Assert.Equal(0, outcome.ApplyInvocations);
    }

    [Fact]
    public void A_blocked_plan_cannot_be_applied_even_with_the_phrase_forced_into_the_box()
    {
        bool? boxEnabled = null, applyEnabled = null;
        string? initialFocus = null;
        var outcome = RunGated(false,
            f => { initialFocus = DialogHarness.Focused(f)?.Name; boxEnabled = Typed(f).Enabled; Typed(f).Text = Phrase; },
            f => { applyEnabled = Apply(f).Enabled; Apply(f).PerformClick(); },
            f => { });

        Assert.Equal("cancel", initialFocus);
        Assert.False(boxEnabled);
        Assert.False(applyEnabled);
        Assert.True(outcome.Run.StayedOpen);
        Assert.Equal(0, outcome.ApplyInvocations);
    }

    // ---- layout and defaults -----------------------------------------------

    [Fact]
    public void Cancel_is_both_the_Enter_and_the_Esc_button()
    {
        IButtonControl? accept = null, cancel = null;
        RunGated(true, f => { accept = f.AcceptButton; cancel = f.CancelButton; }, Close);

        Assert.Equal("cancel", ((Button)accept!).Name);
        Assert.Equal("cancel", ((Button)cancel!).Name);
    }

    [Fact]
    public void Apply_and_Cancel_are_far_apart_with_Apply_on_the_left()
    {
        System.Drawing.Rectangle apply = default, cancel = default;
        RunGated(true, f =>
        {
            apply = Apply(f).RectangleToScreen(Apply(f).ClientRectangle);
            cancel = Cancel(f).RectangleToScreen(Cancel(f).ClientRectangle);
        }, Close);

        Assert.True(apply.Right < cancel.Left, "Apply must be left of Cancel.");
        Assert.True(cancel.Left - apply.Right >= 300, $"Apply and Cancel are only {cancel.Left - apply.Right}px apart.");
    }

    [Fact]
    public void The_prompt_and_the_Apply_label_name_the_phrase_and_the_file_count()
    {
        string? prompt = null, apply = null;
        RunGated(true, f =>
        {
            prompt = string.Join(" ", DialogHarness.All(f).OfType<Label>().Select(l => l.Text));
            apply = Apply(f).Text;
        }, Close);

        Assert.Contains("type APPLY 4", prompt);
        Assert.Equal("Apply Copy Design (4 files)", apply);
    }

    // ---- the controller gate these tests model ---------------------------------

    private static string RepoRoot([CallerFilePath] string here = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(here)!, "..", ".."));

    [Fact]
    public void The_controller_applies_only_on_OK_and_CanApply()
    {
        var source = File.ReadAllText(Path.Combine(RepoRoot(), "src", "Arch.CadConnect.Inventor", "ArchAddInController.cs"));
        var start = source.IndexOf("private void RunCopyDesignApply(CopyDesignPlan plan)", StringComparison.Ordinal);
        Assert.True(start >= 0);
        var body = source[start..source.IndexOf("\n    }", start, StringComparison.Ordinal)];

        var gate = body.IndexOf(
            "if (confirm.ShowDialog(new Win32Owner(SafeMainHwnd())) != DialogResult.OK || !confirmation.CanApply)",
            StringComparison.Ordinal);
        var execute = body.IndexOf("ExecuteCopyDesignAttempt(", StringComparison.Ordinal);
        Assert.True(gate >= 0 && execute > gate, "Apply must run only after the OK + CanApply gate.");
        Assert.Matches(new Regex(@"!confirmation\.CanApply\)\s*\{\s*return;"), body);
        Assert.Single(Regex.Matches(body, @"ExecuteCopyDesignAttempt\("));
        // The confirmed fingerprint still reaches the orchestrator, which
        // refuses a plan that changed after confirmation.
        Assert.Contains("confirmedFingerprint: confirmation.Fingerprint", body);
    }
}
