using System.Windows.Forms;

using Arch.CadConnect.Core.CopyDesign;
using Arch.CadConnect.Core.CopyDesign.Apply;

namespace Arch.CadConnect.Inventor.Ui;

/// <summary>
/// P6D ROUND 3, item F: the MANDATORY explicit confirmation shown before a
/// Recover Copy Design attempt - DELIBERATELY separate from both
/// <see cref="CopyDesignApplyConfirmDialog"/> and
/// <see cref="CopyDesignResumeConfirmDialog"/> so a recovery of an UNCERTAIN
/// attempt (no confirmed server reservation at all) is never mistaken for
/// either an ordinary fresh apply or a resume of a CONFIRMED-but-unmaterialized
/// one. Names the EXACT idempotency key being reused, and is explicit that the
/// outcome of the earlier attempt is genuinely unknown - the engineer can see
/// this replays that SAME request rather than starting a new one. Purely a
/// summary/confirmation surface - it builds nothing, calls nothing, and
/// performs no I/O of its own.
///
/// M4.1 T6 follow-up: Recover stays disabled until the engineer types the
/// exact phrase from <see cref="CopyDesignRecoverTypedConfirmation"/>
/// (<c>RECOVER N</c>, N = files the replayed request will copy); changing or
/// clearing the text disables it again at once. Cancel is the Enter and Esc
/// button, Enter in the phrase box does nothing, and Recover sits at the far
/// left, away from Cancel at the far right.
/// </summary>
internal sealed class CopyDesignRecoverConfirmDialog : Form
{
    private readonly Label _summary = new() { AutoSize = true, MaximumSize = new System.Drawing.Size(560, 0), Name = "summary" };
    private readonly Label _prompt = new() { AutoSize = true, Margin = new Padding(0, 6, 8, 0) };
    private readonly ConfirmationPhraseBox _typed = new() { Width = 160, Name = "typedConfirmation" };
    private readonly Button _recover = new() { AutoSize = true, Name = "recover" };
    private readonly Button _cancel = new() { Text = "Cancel", DialogResult = DialogResult.Cancel, Width = 90, Name = "cancel" };

    public CopyDesignRecoverConfirmDialog(CopyDesignPlan plan, string idempotencyKey)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(idempotencyKey);

        var prepared = CopyDesignRecoverTypedConfirmation.Prepare(plan, idempotencyKey);
        var files = prepared.FilesToCopy;

        Text = "Recover Copy Design - confirm";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(16);
        // Never let Enter recover: Cancel is the default action.
        AcceptButton = _cancel;
        CancelButton = _cancel;

        _summary.Text =
            $"The outcome of the LAST Copy Design attempt (idempotency key: {idempotencyKey}) is UNKNOWN - its " +
            "reservation request itself never returned a trustworthy answer (a network/timeout/server problem), " +
            "so it is not known whether Arch PLM actually committed it.\n\n" +
            "Recovering REPLAYS the EXACT SAME request with the SAME idempotency key - it never creates a new " +
            "request. If the server already committed the earlier attempt, the SAME operation is returned and " +
            "nothing is duplicated; if it did not, it is safely created now. " +
            (prepared.CanConfirm
                ? $"{files} file{(files == 1 ? "" : "s")} will be copied and materialized - none was copied before, " +
                  "because nothing is copied until the server answers the reservation."
                : $"This attempt cannot be recovered: {prepared.Reason}") +
            "\n\nSource files are never modified. No new CadDocument identity is ever created beyond what this ONE " +
            "logical attempt would have created.";

        _recover.Text = $"Recover Copy Design ({files} file{(files == 1 ? "" : "s")})";
        _recover.Enabled = false;
        _typed.Enabled = prepared.CanConfirm;
        _prompt.Text = prepared.CanConfirm ? $"To enable Recover, type {prepared.Phrase} :" : "Recover is not available.";
        _typed.TextChanged += (_, _) => _recover.Enabled = CopyDesignRecoverTypedConfirmation.IsSatisfied(prepared, _typed.Text);

        var confirmRow = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, AutoSize = true, Dock = DockStyle.Fill };
        confirmRow.Controls.Add(_prompt);
        confirmRow.Controls.Add(_typed);

        // Recover far left, Cancel far right, so a click meant for one cannot
        // land on the other.
        var buttons = new TableLayoutPanel { ColumnCount = 3, RowCount = 1, AutoSize = true, Dock = DockStyle.Fill, MinimumSize = new System.Drawing.Size(560, 0) };
        buttons.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        buttons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        buttons.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        _cancel.Anchor = AnchorStyles.Right;
        buttons.Controls.Add(_recover, 0, 0);
        buttons.Controls.Add(_cancel, 2, 0);

        var root = new TableLayoutPanel { RowCount = 3, AutoSize = true, Dock = DockStyle.Fill };
        root.Controls.Add(_summary);
        root.Controls.Add(confirmRow);
        root.Controls.Add(buttons);
        Controls.Add(root);

        Shown += (_, _) => (prepared.CanConfirm ? (Control)_typed : _cancel).Select();

        _recover.Click += (_, _) =>
        {
            if (!CopyDesignRecoverTypedConfirmation.IsSatisfied(prepared, _typed.Text))
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
            _prompt.Dispose();
            _typed.Dispose();
            _recover.Dispose();
            _cancel.Dispose();
        }
        base.Dispose(disposing);
    }
}
