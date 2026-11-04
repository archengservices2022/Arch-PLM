using System.Windows.Forms;

using Arch.CadConnect.Core.CopyDesign;
using Arch.CadConnect.Core.CopyDesign.Apply;

namespace Arch.CadConnect.Inventor.Ui;

/// <summary>
/// P6D ROUND 2, HIGH fix (RESUME): the MANDATORY explicit confirmation shown
/// before a Resume Copy Design attempt - DELIBERATELY separate from
/// <see cref="CopyDesignApplyConfirmDialog"/> so a resume is never mistaken
/// for (or silently treated as) an ordinary fresh apply. Names the EXACT
/// idempotency key being reused, so the engineer can see this is a
/// continuation of a specific prior attempt, not a new one. Purely a
/// summary/confirmation surface - it builds nothing, calls nothing, and
/// performs no I/O of its own.
///
/// M4.1 T6 follow-up: Resume stays disabled until the engineer types the
/// exact phrase from <see cref="CopyDesignResumeTypedConfirmation"/>
/// (<c>RESUME</c> + the key's last 6 characters, original case), shown
/// directly under the full key; changing or clearing the text disables it
/// again at once, and a missing or malformed key is never confirmable. Cancel
/// is the Enter and Esc button, Enter in the phrase box does nothing, and
/// Resume sits at the far left, away from Cancel at the far right. The SAME
/// dialog serves the in-session and the durable resume path.
/// </summary>
internal sealed class CopyDesignResumeConfirmDialog : Form
{
    private readonly Label _summary = new() { AutoSize = true, MaximumSize = new System.Drawing.Size(560, 0), Name = "summary" };
    private readonly Label _key = new() { AutoSize = true, MaximumSize = new System.Drawing.Size(560, 0), Name = "key", Margin = new Padding(0, 8, 0, 4) };
    private readonly Label _prompt = new() { AutoSize = true, Margin = new Padding(0, 6, 8, 0) };
    private readonly ConfirmationPhraseBox _typed = new() { Width = 160, Name = "typedConfirmation" };
    private readonly Button _resume = new() { Text = "Resume Copy Design", AutoSize = true, Name = "resume" };
    private readonly Button _cancel = new() { Text = "Cancel", DialogResult = DialogResult.Cancel, Width = 90, Name = "cancel" };

    public CopyDesignResumeConfirmDialog(CopyDesignPlan plan, string? idempotencyKey)
    {
        ArgumentNullException.ThrowIfNull(plan);

        var prepared = CopyDesignResumeTypedConfirmation.Prepare(idempotencyKey);
        var copyCount = plan.Nodes.Count(n => n.ProposedAction == CopyDesignAction.Copy);

        Text = "Resume Copy Design - confirm";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(16);
        // Never let Enter resume: Cancel is the default action.
        AcceptButton = _cancel;
        CancelButton = _cancel;

        _summary.Text =
            $"This CONTINUES the SAME Copy Design operation (idempotency key: {idempotencyKey ?? "(none)"}) that was previously " +
            "reserved but did not fully materialize - it does NOT create a new Copy Design request.\n\n" +
            $"Up to {copyCount} entr{(copyCount == 1 ? "y" : "ies")} will be checked against the server: anything " +
            "already materialized in the prior attempt is left exactly as-is (never re-copied, never a second " +
            "FileVersion 1); anything still pending is completed normally.\n\n" +
            "Source files are never modified. No new CadDocument identity is ever created by this resume." +
            (prepared.CanConfirm ? "" : $"\n\nThis attempt cannot be resumed: {prepared.Reason}");

        _key.Text = $"Idempotency key: {idempotencyKey ?? "(none)"}";
        _resume.Enabled = false;
        _typed.Enabled = prepared.CanConfirm;
        _prompt.Text = prepared.CanConfirm ? $"To enable Resume, type {prepared.Phrase} :" : "Resume is not available.";
        _typed.TextChanged += (_, _) => _resume.Enabled = CopyDesignResumeTypedConfirmation.IsSatisfied(prepared, _typed.Text);

        var confirmRow = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, AutoSize = true, Dock = DockStyle.Fill };
        confirmRow.Controls.Add(_prompt);
        confirmRow.Controls.Add(_typed);

        // Resume far left, Cancel far right, so a click meant for one cannot
        // land on the other.
        var buttons = new TableLayoutPanel { ColumnCount = 3, RowCount = 1, AutoSize = true, Dock = DockStyle.Fill, MinimumSize = new System.Drawing.Size(560, 0) };
        buttons.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        buttons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        buttons.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        _cancel.Anchor = AnchorStyles.Right;
        buttons.Controls.Add(_resume, 0, 0);
        buttons.Controls.Add(_cancel, 2, 0);

        var root = new TableLayoutPanel { RowCount = 4, AutoSize = true, Dock = DockStyle.Fill };
        root.Controls.Add(_summary);
        root.Controls.Add(_key);
        root.Controls.Add(confirmRow);
        root.Controls.Add(buttons);
        Controls.Add(root);

        Shown += (_, _) => (prepared.CanConfirm ? (Control)_typed : _cancel).Select();

        _resume.Click += (_, _) =>
        {
            if (!CopyDesignResumeTypedConfirmation.IsSatisfied(prepared, _typed.Text))
            {
                return; // defense in depth - the button is disabled anyway
            }
            DialogResult = DialogResult.OK;
            Close();
        };
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _summary.Dispose();
            _key.Dispose();
            _prompt.Dispose();
            _typed.Dispose();
            _resume.Dispose();
            _cancel.Dispose();
        }
        base.Dispose(disposing);
    }
}
