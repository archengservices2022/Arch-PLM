using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Arch.CadConnect.Ui.Tests;

/// <summary>
/// Runs a real modal WinForms dialog (<c>ShowDialog</c>, its own message
/// loop) on a dedicated STA thread, performs input steps once it is shown,
/// and reports how it closed. Key presses and typed characters are POSTED as
/// window messages to the focused control, so they travel the same path a
/// physical key does (message loop -> PreProcessMessage -> dialog keys /
/// text input); nothing calls the dialog's handlers directly. Each step runs
/// only after every message the previous step posted has been processed.
/// The window is fully transparent so it cannot be clicked by a person while
/// a test runs. A dialog that does not close within the timeout is closed by
/// the harness and reported as <see cref="DialogRun.StayedOpen"/>.
/// </summary>
internal static class DialogHarness
{
    private const int WmKeyDown = 0x0100;
    private const int WmKeyUp = 0x0101;
    private const int WmChar = 0x0102;
    private const int WmClose = 0x0010;

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    public static DialogRun Run(Func<Form> create, params Action<Form>[] steps) => Run(create, 3000, steps);

    public static DialogRun Run(Func<Form> create, int timeoutMs, params Action<Form>[] steps)
    {
        DialogRun? run = null;
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                using var form = create();
                form.Opacity = 0;
                form.ShowInTaskbar = false;
                var stayedOpen = false;
                using var guard = new System.Windows.Forms.Timer { Interval = timeoutMs };
                guard.Tick += (_, _) => { guard.Stop(); stayedOpen = true; form.Close(); };

                // Steps are driven by a timer, not chained BeginInvoke calls:
                // WinForms drains every queued BeginInvoke callback in one go,
                // ahead of messages a step posted, whereas WM_TIMER is only
                // delivered once the queue is empty - so each step sees the
                // effects of everything the previous one posted.
                var next = 0;
                using var stepper = new System.Windows.Forms.Timer { Interval = 15 };
                stepper.Tick += (_, _) =>
                {
                    stepper.Stop();
                    if (next >= steps.Length || form.IsDisposed || !form.Visible) return;
                    steps[next++](form);
                    if (!form.IsDisposed && form.Visible) stepper.Start();
                };

                form.Shown += (_, _) => { guard.Start(); stepper.Start(); };
                var result = form.ShowDialog();
                run = new DialogRun(result, stayedOpen);
            }
            catch (Exception ex)
            {
                failure = ex;
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        Assert.True(thread.Join(timeoutMs + 10_000), "The dialog thread did not finish.");
        if (failure is not null)
        {
            throw new InvalidOperationException("Dialog run failed", failure);
        }
        return run!;
    }

    /// <summary>Post a key press to the control that currently has focus.</summary>
    public static void PressKey(Form form, Keys key)
    {
        var target = FocusedHandle(form);
        PostMessage(target, WmKeyDown, (IntPtr)(int)key, IntPtr.Zero);
        PostMessage(target, WmKeyUp, (IntPtr)(int)key, (IntPtr)unchecked((int)0xC0000001));
    }

    /// <summary>Post typed characters to the control that currently has focus.</summary>
    public static void Type(Form form, string text)
    {
        var target = FocusedHandle(form);
        foreach (var ch in text)
        {
            PostMessage(target, WmChar, (IntPtr)ch, IntPtr.Zero);
        }
    }

    /// <summary>Post WM_CLOSE to the form - what the title-bar X does.</summary>
    public static void CloseBox(Form form) => PostMessage(form.Handle, WmClose, IntPtr.Zero, IntPtr.Zero);

    public static T Named<T>(Form form, string name) where T : Control =>
        All(form).OfType<T>().Single(c => c.Name == name);

    public static IEnumerable<Control> All(Control root)
    {
        foreach (Control child in root.Controls)
        {
            yield return child;
            foreach (var grandchild in All(child))
            {
                yield return grandchild;
            }
        }
    }

    public static Control? Focused(Form form)
    {
        var control = form.ActiveControl;
        while (control is ContainerControl { ActiveControl: { } inner })
        {
            control = inner;
        }
        return control;
    }

    private static IntPtr FocusedHandle(Form form) => (Focused(form) ?? form).Handle;
}

internal sealed record DialogRun(DialogResult Result, bool StayedOpen);
