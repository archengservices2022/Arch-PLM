using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using System.Windows.Forms;

using Arch.CadConnect.Core;
using Arch.CadConnect.Core.CopyDesign;
using Arch.CadConnect.Core.References;
using Arch.CadConnect.Inventor.Ui;

namespace Arch.CadConnect.Ui.Tests;

/// <summary>
/// M4.1 T6 follow-up: UI-level proof for the Resume Copy Design confirmation
/// (shared by the in-session and the durable resume path): Resume is enabled
/// only by the exact <c>RESUME &lt;key suffix&gt;</c> phrase shown under the
/// full key; Cancel, Esc, the title-bar X, Enter in the phrase box and
/// accidental clicks never let Resume run; a missing or malformed key is
/// never confirmable; a focused, enabled Resume button behaves like a click.
///
/// "Resume runs" is modelled exactly as the controller gates both paths
/// (<c>ExecuteCopyDesignAttempt</c> only when <c>ShowDialog</c> returned OK -
/// pinned by <see cref="Both_resume_paths_resume_only_on_OK_with_the_same_key_they_confirmed"/>).
/// Shipped dialog source, no server, no Inventor, no files.
/// </summary>
public class CopyDesignResumeConfirmDialogTests
{
    private const string Key = "cadconnect-p6c-6554cba9289e42768165fe56549f2152";
    private const string Phrase = "RESUME 9f2152";

    private static CopyDesignPlan Plan() => new(
        RootAbsolutePath: @"C:\NotUsed\src\ROOT.iam",
        Nodes: new[] { "ROOT.iam", "PART-A.ipt", "PART-B.ipt", "ROOT.idw" }.Select((name, i) => new CopyDesignNode(
            CadDocumentId: "doc-" + i, CurrentFileVersionId: "fv-" + i,
            DocumentType: i == 0 ? CadDocumentType.Iam : i == 3 ? CadDocumentType.Idw : CadDocumentType.Ipt,
            SourceAbsolutePath: @"C:\NotUsed\src\" + name, SourceFileName: name,
            RelationshipToParent: i == 0 ? null : CadRelationshipKind.Component,
            IsManaged: true, IsVerified: true, IsResolved: true, ProposedAction: CopyDesignAction.Copy,
            ProposedDestinationFileName: "NEW-" + name, ProposedDestinationAbsolutePath: @"C:\NotUsed\dst\NEW-" + name,
            Reasons: Array.Empty<string>(), IsRoot: i == 0)).ToArray(),
        Edges: Array.Empty<CopyDesignEdge>(), Warnings: Array.Empty<string>(),
        IsExecutable: true, ScanWasComplete: true, DrawingAssociationAvailable: true, ModelFilesOnlyAcknowledged: false);

    private static (DialogRun Run, int Resumed) RunGated(string? key, params Action<Form>[] steps)
    {
        var run = DialogHarness.Run(() => new CopyDesignResumeConfirmDialog(Plan(), key), steps);
        return (run, run.Result == DialogResult.OK ? 1 : 0);   // = ExecuteCopyDesignAttempt(..., Resume)
    }

    private static (DialogRun Run, int Resumed) RunGated(params Action<Form>[] steps) => RunGated(Key, steps);

    private static Button Resume(Form f) => DialogHarness.Named<Button>(f, "resume");
    private static Button Cancel(Form f) => DialogHarness.Named<Button>(f, "cancel");
    private static TextBox Typed(Form f) => DialogHarness.Named<TextBox>(f, "typedConfirmation");
    private static void TypePhrase(Form f) => DialogHarness.Type(f, Phrase);
    private static void Close(Form f) => f.Close();

    private static void AssertCancelledWithoutResume((DialogRun Run, int Resumed) outcome)
    {
        Assert.False(outcome.Run.StayedOpen);
        Assert.Equal(DialogResult.Cancel, outcome.Run.Result);
        Assert.Equal(0, outcome.Resumed);
    }

    // ---- typed confirmation ------------------------------------------------

    [Fact]
    public void Resume_is_disabled_until_the_exact_phrase_is_typed_and_the_box_has_the_initial_focus()
    {
        bool? before = null, after = null;
        string? initialFocus = null;
        RunGated(
            f => { initialFocus = DialogHarness.Focused(f)?.Name; before = Resume(f).Enabled; },
            TypePhrase,
            f => after = Resume(f).Enabled,
            Close);

        Assert.Equal("typedConfirmation", initialFocus);
        Assert.False(before);
        Assert.True(after);
    }

    [Theory]
    [InlineData("resume 9f2152")]
    [InlineData("RESUME 9F2152")]
    [InlineData("RESUME f2152")]
    [InlineData("RESUME 49f2152")]
    [InlineData("RESUME 4")]
    [InlineData("APPLY 9f2152")]
    public void Typing_anything_but_the_exact_phrase_keeps_Resume_disabled(string typed)
    {
        bool? enabled = null;
        var outcome = RunGated(
            f => DialogHarness.Type(f, typed),
            f => enabled = Resume(f).Enabled,
            f => Resume(f).PerformClick(),   // an accidental click on the disabled button does nothing
            f => { });

        Assert.False(enabled);
        Assert.True(outcome.Run.StayedOpen);
        Assert.Equal(0, outcome.Resumed);
    }

    [Fact]
    public void Changing_or_clearing_the_text_disables_Resume_immediately()
    {
        var states = new List<bool>();
        RunGated(
            TypePhrase, f => states.Add(Resume(f).Enabled),
            f => DialogHarness.Type(f, "\b"), f => states.Add(Resume(f).Enabled),
            f => DialogHarness.Type(f, "2"), f => states.Add(Resume(f).Enabled),
            f => DialogHarness.Type(f, "x"), f => states.Add(Resume(f).Enabled),
            f => DialogHarness.Type(f, new string('\b', Phrase.Length + 1)), f => states.Add(Resume(f).Enabled),
            Close);

        Assert.Equal(new[] { true, false, true, false, false }, states);
    }

    // ---- Cancel / Esc / Enter / X never resume -----------------------------

    [Fact]
    public void Clicking_Cancel_closes_without_Resume__even_after_the_phrase()
    {
        AssertCancelledWithoutResume(RunGated(TypePhrase, f => Cancel(f).PerformClick()));
    }

    [Fact]
    public void Enter_in_the_confirmation_box_does_nothing__even_with_the_exact_phrase()
    {
        bool? open = null, enabled = null;
        string? text = null;
        var outcome = RunGated(
            TypePhrase,
            f => DialogHarness.PressKey(f, Keys.Enter),
            f => { open = f.Visible; text = Typed(f).Text; enabled = Resume(f).Enabled; },
            f => DialogHarness.PressKey(f, Keys.Escape));

        Assert.True(open);
        Assert.Equal(Phrase, text);
        Assert.True(enabled);
        AssertCancelledWithoutResume(outcome);
    }

    [Theory]
    [InlineData("typedConfirmation")]
    [InlineData("cancel")]
    [InlineData("resume")]
    public void Esc_cancels_wherever_the_focus_is__even_on_an_enabled_Resume(string focus)
    {
        AssertCancelledWithoutResume(RunGated(
            TypePhrase,
            f => f.ActiveControl = DialogHarness.Named<Control>(f, focus),
            f => DialogHarness.PressKey(f, Keys.Escape)));
    }

    [Theory]
    [InlineData(Keys.Enter)]
    [InlineData(Keys.Space)]
    public void Enter_or_Space_on_a_focused_Cancel_cancels(Keys key)
    {
        AssertCancelledWithoutResume(RunGated(TypePhrase, f => f.ActiveControl = Cancel(f), f => DialogHarness.PressKey(f, key)));
    }

    [Fact]
    public void The_title_bar_close_box_cancels__even_after_the_phrase()
    {
        AssertCancelledWithoutResume(RunGated(TypePhrase, DialogHarness.CloseBox));
    }

    // ---- keyboard focus ---------------------------------------------------------

    [Fact]
    public void Tab_never_reaches_Resume_while_it_is_disabled()
    {
        var visited = new List<string?>();
        var steps = new List<Action<Form>>();
        for (var i = 0; i < 8; i++)
        {
            steps.Add(f => DialogHarness.PressKey(f, Keys.Tab));
            steps.Add(f => visited.Add(DialogHarness.Focused(f)?.Name));
        }
        steps.Add(f => DialogHarness.PressKey(f, Keys.Escape));

        var outcome = RunGated(steps.ToArray());

        Assert.DoesNotContain("resume", visited);
        Assert.Contains("cancel", visited);
        AssertCancelledWithoutResume(outcome);
    }

    [Theory]
    [InlineData(Keys.Enter)]
    [InlineData(Keys.Space)]
    public void A_key_press_on_a_focused_enabled_Resume_resumes_like_a_click(Keys key)
    {
        var outcome = RunGated(TypePhrase, f => f.ActiveControl = Resume(f), f => DialogHarness.PressKey(f, key));

        Assert.False(outcome.Run.StayedOpen);
        Assert.Equal(DialogResult.OK, outcome.Run.Result);
        Assert.Equal(1, outcome.Resumed);
    }

    // ---- only a deliberate Resume resumes ----------------------------------------

    [Fact]
    public void Clicking_Resume_after_the_exact_phrase_resumes_exactly_once()
    {
        var outcome = RunGated(TypePhrase, f => Resume(f).PerformClick());

        Assert.False(outcome.Run.StayedOpen);
        Assert.Equal(DialogResult.OK, outcome.Run.Result);
        Assert.Equal(1, outcome.Resumed);
    }

    [Fact]
    public void Clicking_Resume_without_the_phrase_does_nothing()
    {
        var outcome = RunGated(f => Resume(f).PerformClick(), f => { });

        Assert.True(outcome.Run.StayedOpen);
        Assert.Equal(0, outcome.Resumed);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("too-short")]
    [InlineData("cadconnect-p6c 6554cba9289e42768165fe56549f2152")]
    public void A_missing_or_invalid_key_cannot_be_resumed_even_with_a_phrase_forced_into_the_box(string? key)
    {
        bool? boxEnabled = null, resumeEnabled = null;
        string? initialFocus = null, summary = null;
        var outcome = RunGated(key,
            f =>
            {
                initialFocus = DialogHarness.Focused(f)?.Name;
                boxEnabled = Typed(f).Enabled;
                summary = DialogHarness.Named<Label>(f, "summary").Text;
                Typed(f).Text = Phrase;
            },
            f => { resumeEnabled = Resume(f).Enabled; Resume(f).PerformClick(); },
            f => { });

        Assert.Equal("cancel", initialFocus);
        Assert.False(boxEnabled);
        Assert.False(resumeEnabled);
        Assert.Contains("cannot be resumed", summary);
        Assert.True(outcome.Run.StayedOpen);
        Assert.Equal(0, outcome.Resumed);
    }

    // ---- layout and defaults -----------------------------------------------------

    [Fact]
    public void Cancel_is_both_the_Enter_and_the_Esc_button()
    {
        IButtonControl? accept = null, cancel = null;
        RunGated(f => { accept = f.AcceptButton; cancel = f.CancelButton; }, Close);

        Assert.Equal("cancel", ((Button)accept!).Name);
        Assert.Equal("cancel", ((Button)cancel!).Name);
    }

    [Fact]
    public void Resume_and_Cancel_are_far_apart_with_Resume_on_the_left()
    {
        System.Drawing.Rectangle resume = default, cancel = default;
        RunGated(f =>
        {
            resume = Resume(f).RectangleToScreen(Resume(f).ClientRectangle);
            cancel = Cancel(f).RectangleToScreen(Cancel(f).ClientRectangle);
        }, Close);

        Assert.True(resume.Right < cancel.Left, "Resume must be left of Cancel.");
        Assert.True(cancel.Left - resume.Right >= 200, $"Resume and Cancel are only {cancel.Left - resume.Right}px apart.");
    }

    [Fact]
    public void The_full_key_is_shown_directly_above_the_phrase_box_and_the_phrase_uses_its_suffix()
    {
        string? keyText = null, labels = null;
        int keyBottom = 0, boxTop = 0;
        RunGated(f =>
        {
            var keyLabel = DialogHarness.Named<Label>(f, "key");
            keyText = keyLabel.Text;
            keyBottom = keyLabel.RectangleToScreen(keyLabel.ClientRectangle).Bottom;
            boxTop = Typed(f).RectangleToScreen(Typed(f).ClientRectangle).Top;
            labels = string.Join(" ", DialogHarness.All(f).OfType<Label>().Select(l => l.Text));
        }, Close);

        Assert.Equal("Idempotency key: " + Key, keyText);
        Assert.True(keyBottom <= boxTop, "The key must be shown above the phrase box.");
        Assert.Contains("type RESUME 9f2152", labels);
    }

    // ---- the controller gate: both resume paths ---------------------------------

    private static string RepoRoot([CallerFilePath] string here = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(here)!, "..", ".."));

    private static string Body(string source, string signature)
    {
        var start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, signature);
        return source[start..source.IndexOf("\n    }", start, StringComparison.Ordinal)];
    }

    [Theory]
    [InlineData("private void RunCopyDesignResume()", "resumable.Plan, resumable.IdempotencyKey",
        "ExecuteCopyDesignAttempt(resumable.Plan, resumable.IdempotencyKey, resumable.Label, CopyDesignAttemptKind.Resume)")]
    [InlineData("private void FinishDurableCopyDesignResume(", "reconstruction.Plan!, reconstruction.IdempotencyKey!",
        "ExecuteCopyDesignAttempt(reconstruction.Plan!, reconstruction.IdempotencyKey!, label: null, CopyDesignAttemptKind.Resume)")]
    public void Both_resume_paths_resume_only_on_OK_with_the_same_key_they_confirmed(string method, string dialogArgs, string execute)
    {
        var body = Body(File.ReadAllText(Path.Combine(RepoRoot(), "src", "Arch.CadConnect.Inventor", "ArchAddInController.cs")), method);

        var dialog = body.IndexOf($"new CopyDesignResumeConfirmDialog({dialogArgs})", StringComparison.Ordinal);
        var gate = body.IndexOf("if (confirm.ShowDialog(new Win32Owner(SafeMainHwnd())) != DialogResult.OK)", dialog < 0 ? 0 : dialog, StringComparison.Ordinal);
        var run = body.IndexOf(execute, StringComparison.Ordinal);
        Assert.True(dialog >= 0, $"{method}: the resume dialog is not shown with the attempt's own key.");
        Assert.True(gate > dialog && run > gate, $"{method}: Resume must run only after the OK gate.");
        Assert.Single(Regex.Matches(body, @"ExecuteCopyDesignAttempt\("));
    }
}
