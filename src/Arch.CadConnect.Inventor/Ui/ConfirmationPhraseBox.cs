using System.Windows.Forms;

namespace Arch.CadConnect.Inventor.Ui;

/// <summary>
/// M4.1 T6 follow-up: the text box a typed Copy Design confirmation phrase is
/// entered into. Enter here does NOTHING - it is consumed by the box, so it
/// neither confirms nor reaches the dialog's default (Cancel) button and
/// unexpectedly closes the dialog. Esc is left alone, so it still cancels.
/// </summary>
internal sealed class ConfirmationPhraseBox : TextBox
{
    protected override bool IsInputKey(Keys keyData) =>
        (keyData & Keys.KeyCode) == Keys.Enter || base.IsInputKey(keyData);

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Enter)
        {
            e.Handled = true;
            e.SuppressKeyPress = true;   // no WM_CHAR, no beep
            return;
        }
        base.OnKeyDown(e);
    }
}
