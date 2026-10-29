using System.Windows.Forms;

using Arch.CadConnect.Core.CopyDesign.Apply;

namespace Arch.CadConnect.Inventor.Ui;

/// <summary>
/// P6C/P6D: the MANDATORY explicit confirmation shown between an EXECUTABLE
/// P6A preview and the actual apply. Purely a confirmation surface - it
/// builds nothing, calls nothing, and performs no I/O of its own.
///
/// P6 Milestone 2: shows the COMPLETE mapping the orchestrator will execute -
/// for every entry the COPY/REUSE action, source file name and document
/// number, destination file name, proposed new document number and
/// destination folder, plus every blocking error, warning and informational
/// message - rendered by <see cref="CopyDesignApplyConfirmationTextReport"/>
/// from a <see cref="CopyDesignApplyConfirmation"/> (previously: file counts
/// and one destination folder only). The Apply button is ENABLED ONLY when
/// <see cref="CopyDesignApplyConfirmation.CanApply"/> is true - a blocked
/// confirmation can be read and copied, never applied. The caller passes the
/// confirmation's <see cref="CopyDesignApplyConfirmation.Fingerprint"/> to
/// the orchestrator, which refuses to run any mapping that differs from it.
///
/// M4.1 T6 follow-up (two accidental live Applies): Apply also stays disabled
/// until the engineer types the exact phrase from
/// <see cref="CopyDesignApplyTypedConfirmation"/> (<c>APPLY N</c>, N = files
/// to be copied); changing or clearing the text disables it again at once.
/// Cancel stays the Enter and Esc button, the typed-confirmation box has the
/// initial focus (Enter there does nothing - see
/// <see cref="ConfirmationPhraseBox"/>), and Apply sits at the far left, away
/// from Cancel at the far right.
/// </summary>
internal sealed class CopyDesignApplyConfirmDialog : Form
{
    private readonly TextBox _report = new()
    {
        Multiline = true,
        ReadOnly = true,
        ScrollBars = ScrollBars.Both,
        WordWrap = false,
        Font = new System.Drawing.Font(System.Drawing.FontFamily.GenericMonospace, 9f),
        Width = 760,
        Height = 420,
        Name = "report",
    };
    private readonly Label _prompt = new() { AutoSize = true, Margin = new Padding(0, 6, 8, 0) };
    private readonly ConfirmationPhraseBox _typed = new() { Width = 160, Name = "typedConfirmation" };
    private readonly Button _apply = new() { AutoSize = true, Name = "apply" };
    private readonly Button _copy = new() { Text = "Copy to Clipboard", Width = 140, Name = "copy" };
    private readonly Button _cancel = new() { Text = "Cancel", DialogResult = DialogResult.Cancel, Width = 90, Name = "cancel" };

    public CopyDesignApplyConfirmDialog(CopyDesignApplyConfirmation confirmation)
    {
        ArgumentNullException.ThrowIfNull(confirmation);

        Text = confirmation.CanApply ? "Apply Copy Design - confirm" : "Apply Copy Design - BLOCKED";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(12);
        // Never let Enter apply: Cancel is the default action.
        AcceptButton = _cancel;
        CancelButton = _cancel;

        _report.Text = CopyDesignApplyConfirmationTextReport.Render(confirmation).Replace("\n", Environment.NewLine);
        _report.Select(0, 0);

        var phrase = CopyDesignApplyTypedConfirmation.ExpectedPhrase(confirmation);
        _apply.Text = $"Apply Copy Design ({confirmation.CopyCount} file{(confirmation.CopyCount == 1 ? "" : "s")})";
        _apply.Enabled = false;
        _typed.Enabled = confirmation.CanApply;
        _prompt.Text = confirmation.CanApply
            ? $"To enable Apply, type {phrase} :"
            : "This plan cannot be applied.";
        _typed.TextChanged += (_, _) =>
            _apply.Enabled = CopyDesignApplyTypedConfirmation.IsSatisfied(confirmation, _typed.Text);

        var confirmRow = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, AutoSize = true, Dock = DockStyle.Fill };
        confirmRow.Controls.Add(_prompt);
        confirmRow.Controls.Add(_typed);

        // Apply far left, Cancel far right, so a click meant for one cannot
        // land on the other.
        var rightButtons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, AutoSize = true, Anchor = AnchorStyles.Right };
        rightButtons.Controls.Add(_cancel);
        rightButtons.Controls.Add(_copy);
        var buttons = new TableLayoutPanel { ColumnCount = 3, RowCount = 1, AutoSize = true, Dock = DockStyle.Fill };
        buttons.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        buttons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        buttons.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        buttons.Controls.Add(_apply, 0, 0);
        buttons.Controls.Add(rightButtons, 2, 0);

        var root = new TableLayoutPanel { RowCount = 3, AutoSize = true, Dock = DockStyle.Fill };
        root.Controls.Add(_report);
        root.Controls.Add(confirmRow);
        root.Controls.Add(buttons);
        Controls.Add(root);

        // The typed-confirmation box gets the initial focus (Enter there does
        // nothing); for a blocked plan, Cancel does.
        Shown += (_, _) => (confirmation.CanApply ? (Control)_typed : _cancel).Select();

        _apply.Click += (_, _) =>
        {
            if (!CopyDesignApplyTypedConfirmation.IsSatisfied(confirmation, _typed.Text))
            {
                return; // defense in depth - the button is disabled anyway
            }
            DialogResult = DialogResult.OK;
            Close();
        };
        _copy.Click += (_, _) =>
        {
            try { Clipboard.SetText(_report.Text); } catch { /* clipboard busy - non-fatal */ }
        };
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _report.Dispose();
            _prompt.Dispose();
            _typed.Dispose();
            _apply.Dispose();
            _copy.Dispose();
            _cancel.Dispose();
        }
        base.Dispose(disposing);
    }
}
