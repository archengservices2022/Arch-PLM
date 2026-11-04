using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using System.Windows.Forms;

using Arch.CadConnect.Core;
using Arch.CadConnect.Core.CopyDesign;
using Arch.CadConnect.Core.References;
using Arch.CadConnect.Inventor.Ui;

namespace Arch.CadConnect.Ui.Tests;

/// <summary>
/// M4.1 T6 follow-up: UI-level proof for the Recover Copy Design
/// confirmation, mirroring <see cref="CopyDesignApplyConfirmDialogTests"/>:
/// Recover is enabled only by the exact <c>RECOVER N</c> phrase; Cancel, Esc,
/// the title-bar X, Enter in the phrase box and accidental clicks never let
/// Recover run; a focused, enabled Recover button behaves like a click.
///
/// "Recover runs" is modelled exactly as the controller gates it
/// (<c>RunCopyDesignRecover</c>: <c>ExecuteCopyDesignAttempt</c> only when
/// <c>ShowDialog</c> returned OK - pinned by
/// <see cref="The_controller_recovers_only_on_OK"/>). Shipped dialog source,
/// no server, no Inventor, no files.
/// </summary>
public class CopyDesignRecoverConfirmDialogTests
{
    private const string Key = "cadconnect-p6c-0123456789abcdef0123456789abcdef";
    private const string Phrase = "RECOVER 4";

    private static CopyDesignNode Node(string id, string name, CadDocumentType type, CopyDesignAction action, bool isRoot = false) => new(
        CadDocumentId: id, CurrentFileVersionId: "fv-" + id, DocumentType: type,
        SourceAbsolutePath: @"C:\NotUsed\src\" + name, SourceFileName: name,
        RelationshipToParent: isRoot ? null : CadRelationshipKind.Component,
        IsManaged: true, IsVerified: true, IsResolved: true, ProposedAction: action,
        ProposedDestinationFileName: action == CopyDesignAction.Copy ? "NEW-" + name : null,
        ProposedDestinationAbsolutePath: action == CopyDesignAction.Copy ? @"C:\NotUsed\dst\NEW-" + name : null,
        Reasons: Array.Empty<string>(), IsRoot: isRoot);

    /// <summary>The T6 shape: root, two parts and the root's drawing.</summary>
    private static CopyDesignPlan Plan(bool executable = true) => new(
        RootAbsolutePath: @"C:\NotUsed\src\ROOT.iam",
        Nodes: new[]
        {
            Node("doc-root", "ROOT.iam", CadDocumentType.Iam, CopyDesignAction.Copy, isRoot: true),
            Node("doc-a", "PART-A.ipt", CadDocumentType.Ipt, CopyDesignAction.Copy),
            Node("doc-b", "PART-B.ipt", CadDocumentType.Ipt, CopyDesignAction.Copy),
            Node("doc-dwg", "ROOT.idw", CadDocumentType.Idw, CopyDesignAction.Copy),
        },
        Edges: Array.Empty<CopyDesignEdge>(), Warnings: Array.Empty<string>(),
        IsExecutable: executable, ScanWasComplete: true, DrawingAssociationAvailable: true, ModelFilesOnlyAcknowledged: false);

    private static (DialogRun Run, int Recovered) RunGated(bool executable, params Action<Form>[] steps)
    {
        var run = DialogHarness.Run(() => new CopyDesignRecoverConfirmDialog(Plan(executable), Key), steps);
        return (run, run.Result == DialogResult.OK ? 1 : 0);   // = ExecuteCopyDesignAttempt(..., Recover)
    }

    private static Button Recover(Form f) => DialogHarness.Named<Button>(f, "recover");
    private static Button Cancel(Form f) => DialogHarness.Named<Button>(f, "cancel");
    private static TextBox Typed(Form f) => DialogHarness.Named<TextBox>(f, "typedConfirmation");
    private static void TypePhrase(Form f) => DialogHarness.Type(f, Phrase);
    private static void Close(Form f) => f.Close();

    private static void AssertCancelledWithoutRecover((DialogRun Run, int Recovered) outcome)
    {
        Assert.False(outcome.Run.StayedOpen);
        Assert.Equal(DialogResult.Cancel, outcome.Run.Result);
        Assert.Equal(0, outcome.Recovered);
    }

    // ---- typed confirmation ------------------------------------------------

    [Fact]
    public void Recover_is_disabled_until_the_exact_phrase_is_typed_and_the_box_has_the_initial_focus()
    {
        bool? before = null, after = null;
        string? initialFocus = null;
        RunGated(true,
            f => { initialFocus = DialogHarness.Focused(f)?.Name; before = Recover(f).Enabled; },
            TypePhrase,
            f => after = Recover(f).Enabled,
            Close);

        Assert.Equal("typedConfirmation", initialFocus);
        Assert.False(before);
        Assert.True(after);
    }

    [Theory]
    [InlineData("recover 4")]
    [InlineData("RECOVER")]
    [InlineData("RECOVER 3")]
    [InlineData("RECOVER 44")]
    [InlineData("RECOVER  4")]
    [InlineData("APPLY 4")]
    public void Typing_anything_but_the_exact_phrase_keeps_Recover_disabled(string typed)
    {
        bool? enabled = null;
        var outcome = RunGated(true,
            f => DialogHarness.Type(f, typed),
            f => enabled = Recover(f).Enabled,
            f => Recover(f).PerformClick(),   // an accidental click on the disabled button does nothing
            f => { });

        Assert.False(enabled);
        Assert.True(outcome.Run.StayedOpen);
        Assert.Equal(0, outcome.Recovered);
    }

    [Fact]
    public void Changing_or_clearing_the_text_disables_Recover_immediately()
    {
        var states = new List<bool>();
        RunGated(true,
            TypePhrase, f => states.Add(Recover(f).Enabled),
            f => DialogHarness.Type(f, "\b"), f => states.Add(Recover(f).Enabled),
            f => DialogHarness.Type(f, "4"), f => states.Add(Recover(f).Enabled),
            f => DialogHarness.Type(f, "4"), f => states.Add(Recover(f).Enabled),
            f => DialogHarness.Type(f, new string('\b', Phrase.Length + 1)), f => states.Add(Recover(f).Enabled),
            Close);

        Assert.Equal(new[] { true, false, true, false, false }, states);
    }

    // ---- Cancel / Esc / Enter / X never recover ----------------------------

    [Fact]
    public void Clicking_Cancel_closes_without_Recover__even_after_the_phrase()
    {
        AssertCancelledWithoutRecover(RunGated(true, TypePhrase, f => Cancel(f).PerformClick()));
    }

    [Fact]
    public void Enter_in_the_confirmation_box_does_nothing__even_with_the_exact_phrase()
    {
        bool? open = null, enabled = null;
        string? text = null;
        var outcome = RunGated(true,
            TypePhrase,
            f => DialogHarness.PressKey(f, Keys.Enter),
            f => { open = f.Visible; text = Typed(f).Text; enabled = Recover(f).Enabled; },
            f => DialogHarness.PressKey(f, Keys.Escape));

        Assert.True(open);
        Assert.Equal(Phrase, text);
        Assert.True(enabled);
        AssertCancelledWithoutRecover(outcome);
    }

    [Theory]
    [InlineData("typedConfirmation")]
    [InlineData("cancel")]
    [InlineData("recover")]
    public void Esc_cancels_wherever_the_focus_is__even_on_an_enabled_Recover(string focus)
    {
        AssertCancelledWithoutRecover(RunGated(true,
            TypePhrase,
            f => f.ActiveControl = DialogHarness.Named<Control>(f, focus),
            f => DialogHarness.PressKey(f, Keys.Escape)));
    }

    [Theory]
    [InlineData(Keys.Enter)]
    [InlineData(Keys.Space)]
    public void Enter_or_Space_on_a_focused_Cancel_cancels(Keys key)
    {
        AssertCancelledWithoutRecover(RunGated(true, TypePhrase, f => f.ActiveControl = Cancel(f), f => DialogHarness.PressKey(f, key)));
    }

    [Fact]
    public void The_title_bar_close_box_cancels__even_after_the_phrase()
    {
        AssertCancelledWithoutRecover(RunGated(true, TypePhrase, DialogHarness.CloseBox));
    }

    // ---- keyboard focus ---------------------------------------------------------

    [Fact]
    public void Tab_never_reaches_Recover_while_it_is_disabled()
    {
        var visited = new List<string?>();
        var steps = new List<Action<Form>>();
        for (var i = 0; i < 8; i++)
        {
            steps.Add(f => DialogHarness.PressKey(f, Keys.Tab));
            steps.Add(f => visited.Add(DialogHarness.Focused(f)?.Name));
        }
        steps.Add(f => DialogHarness.PressKey(f, Keys.Escape));

        var outcome = RunGated(true, steps.ToArray());

        Assert.DoesNotContain("recover", visited);
        Assert.Contains("cancel", visited);
        AssertCancelledWithoutRecover(outcome);
    }

    [Theory]
    [InlineData(Keys.Enter)]
    [InlineData(Keys.Space)]
    public void A_key_press_on_a_focused_enabled_Recover_recovers_like_a_click(Keys key)
    {
        var outcome = RunGated(true, TypePhrase, f => f.ActiveControl = Recover(f), f => DialogHarness.PressKey(f, key));

        Assert.False(outcome.Run.StayedOpen);
        Assert.Equal(DialogResult.OK, outcome.Run.Result);
        Assert.Equal(1, outcome.Recovered);
    }

    // ---- only a deliberate Recover recovers --------------------------------------

    [Fact]
    public void Clicking_Recover_after_the_exact_phrase_recovers_exactly_once()
    {
        var outcome = RunGated(true, TypePhrase, f => Recover(f).PerformClick());

        Assert.False(outcome.Run.StayedOpen);
        Assert.Equal(DialogResult.OK, outcome.Run.Result);
        Assert.Equal(1, outcome.Recovered);
    }

    [Fact]
    public void Clicking_Recover_without_the_phrase_does_nothing()
    {
        var outcome = RunGated(true, f => Recover(f).PerformClick(), f => { });

        Assert.True(outcome.Run.StayedOpen);
        Assert.Equal(0, outcome.Recovered);
    }

    [Fact]
    public void An_unrecoverable_attempt_cannot_be_recovered_even_with_the_phrase_forced_into_the_box()
    {
        bool? boxEnabled = null, recoverEnabled = null;
        string? initialFocus = null, summary = null;
        var outcome = RunGated(false,
            f =>
            {
                initialFocus = DialogHarness.Focused(f)?.Name;
                boxEnabled = Typed(f).Enabled;
                summary = DialogHarness.Named<Label>(f, "summary").Text;
                Typed(f).Text = "RECOVER 0";
                Typed(f).Text = Phrase;
            },
            f => { recoverEnabled = Recover(f).Enabled; Recover(f).PerformClick(); },
            f => { });

        Assert.Equal("cancel", initialFocus);
        Assert.False(boxEnabled);
        Assert.False(recoverEnabled);
        Assert.Contains("cannot be recovered", summary);
        Assert.True(outcome.Run.StayedOpen);
        Assert.Equal(0, outcome.Recovered);
    }

    // ---- layout and defaults -----------------------------------------------------

    [Fact]
    public void Cancel_is_both_the_Enter_and_the_Esc_button()
    {
        IButtonControl? accept = null, cancel = null;
        RunGated(true, f => { accept = f.AcceptButton; cancel = f.CancelButton; }, Close);

        Assert.Equal("cancel", ((Button)accept!).Name);
        Assert.Equal("cancel", ((Button)cancel!).Name);
    }

    [Fact]
    public void Recover_and_Cancel_are_far_apart_with_Recover_on_the_left()
    {
        System.Drawing.Rectangle recover = default, cancel = default;
        RunGated(true, f =>
        {
            recover = Recover(f).RectangleToScreen(Recover(f).ClientRectangle);
            cancel = Cancel(f).RectangleToScreen(Cancel(f).ClientRectangle);
        }, Close);

        Assert.True(recover.Right < cancel.Left, "Recover must be left of Cancel.");
        Assert.True(cancel.Left - recover.Right >= 200, $"Recover and Cancel are only {cancel.Left - recover.Right}px apart.");
    }

    [Fact]
    public void The_dialog_names_the_phrase_the_file_count_and_the_reused_key()
    {
        string? labels = null, recover = null;
        RunGated(true, f =>
        {
            labels = string.Join(" ", DialogHarness.All(f).OfType<Label>().Select(l => l.Text));
            recover = Recover(f).Text;
        }, Close);

        Assert.Contains("type RECOVER 4", labels);
        Assert.Contains("4 files will be copied and materialized", labels);
        Assert.Contains(Key, labels);
        Assert.Equal("Recover Copy Design (4 files)", recover);
    }

    // ---- the controller gate these tests model ---------------------------------

    private static string RepoRoot([CallerFilePath] string here = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(here)!, "..", ".."));

    [Fact]
    public void The_controller_recovers_only_on_OK()
    {
        var source = File.ReadAllText(Path.Combine(RepoRoot(), "src", "Arch.CadConnect.Inventor", "ArchAddInController.cs"));
        var start = source.IndexOf("private void RunCopyDesignRecover()", StringComparison.Ordinal);
        Assert.True(start >= 0);
        var body = source[start..source.IndexOf("\n    }", start, StringComparison.Ordinal)];

        var dialog = body.IndexOf("new CopyDesignRecoverConfirmDialog(uncertain.Plan, uncertain.IdempotencyKey)", StringComparison.Ordinal);
        var gate = body.IndexOf("if (confirm.ShowDialog(new Win32Owner(SafeMainHwnd())) != DialogResult.OK)", StringComparison.Ordinal);
        var execute = body.IndexOf("ExecuteCopyDesignAttempt(", StringComparison.Ordinal);
        Assert.True(dialog >= 0 && gate > dialog && execute > gate, "Recover must run only after the OK gate.");
        Assert.Single(Regex.Matches(body, @"ExecuteCopyDesignAttempt\("));
        Assert.Contains("uncertain.IdempotencyKey, uncertain.Label, CopyDesignAttemptKind.Recover", body);
    }
}
