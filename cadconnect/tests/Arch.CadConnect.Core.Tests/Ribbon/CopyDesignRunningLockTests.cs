using Arch.CadConnect.Core;
using Arch.CadConnect.Core.Connection;
using Arch.CadConnect.Core.Ribbon;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Core.Tests.Ribbon;

/// <summary>
/// P6 M4.1a CONNECTION LOCK: while a Copy Design Apply / Resume / Recover is
/// running, the ribbon offers ONLY the read-only commands in
/// <see cref="RibbonCommandPolicy.IsAllowedWhileCopyDesignRuns"/> - never a
/// connection change (Sign In / Sign Out / Server Status) and never a
/// document operation that could conflict with the running attempt.
/// </summary>
public class CopyDesignRunningLockTests
{
    private static CadDocumentContext Doc(LocalCheckoutState state) =>
        CadDocumentContext.Create(@"C:\work\proj\housing.iam", displayNameFallback: null, isDirty: false)
            with { PlmIdentity = new PlmIdentity("cad_1"), CheckoutState = state, WorkspaceRoot = @"C:\work\proj" };

    public static TheoryData<ConnectionState> AllStates => new()
    {
        ConnectionState.SignedOut, ConnectionState.Connecting, ConnectionState.Connected,
        ConnectionState.Unauthorized, ConnectionState.ServerUnavailable,
    };

    [Theory]
    [MemberData(nameof(AllStates))]
    public void While_Copy_Design_runs_every_command_outside_the_allow_list_is_disabled(ConnectionState state)
    {
        foreach (var checkout in new[] { LocalCheckoutState.Controlled, LocalCheckoutState.CheckedOutByMe })
        {
            var map = RibbonCommandPolicy.Evaluate(state, Doc(checkout), "ENGINEER",
                hasRememberedUndoTarget: true, hasResumableCopyDesignAttempt: true, hasUncertainCopyDesignAttempt: true,
                copyDesignRunning: true);

            foreach (var (command, enabled) in map)
            {
                if (!RibbonCommandPolicy.IsAllowedWhileCopyDesignRuns(command))
                {
                    Assert.False(enabled, $"{command} must be disabled while Copy Design runs ({state}, {checkout}).");
                }
            }
        }
    }

    [Theory]
    [InlineData(ArchCommand.SignIn)]
    [InlineData(ArchCommand.SignOut)]
    [InlineData(ArchCommand.ServerStatus)]
    [InlineData(ArchCommand.GetLatest)]
    [InlineData(ArchCommand.Checkout)]
    [InlineData(ArchCommand.CheckIn)]
    [InlineData(ArchCommand.UndoCheckout)]
    [InlineData(ArchCommand.RepairReference)]
    [InlineData(ArchCommand.CopyDesignPreview)]
    [InlineData(ArchCommand.CopyDesignResume)]
    [InlineData(ArchCommand.CopyDesignRecover)]
    [InlineData(ArchCommand.CopyDesignVerify)]
    public void Connection_and_conflicting_document_commands_are_not_on_the_allow_list(ArchCommand command)
    {
        Assert.False(RibbonCommandPolicy.IsAllowedWhileCopyDesignRuns(command));
    }

    [Fact]
    public void The_allow_list_is_exactly_the_local_read_only_inspection_commands()
    {
        var allowed = ArchCommands.All.Where(RibbonCommandPolicy.IsAllowedWhileCopyDesignRuns).ToArray();

        Assert.Equal(new[] { ArchCommand.ScanReferences, ArchCommand.ReferenceHealth }.OrderBy(c => c), allowed.OrderBy(c => c));
    }

    [Fact]
    public void Sign_in_is_disabled_while_Copy_Design_runs_even_in_states_that_normally_allow_it()
    {
        foreach (var state in new[] { ConnectionState.SignedOut, ConnectionState.Unauthorized, ConnectionState.ServerUnavailable })
        {
            Assert.True(RibbonCommandPolicy.IsEnabled(ArchCommand.SignIn, state, CadDocumentContext.None));
            Assert.False(RibbonCommandPolicy.IsEnabled(ArchCommand.SignIn, state, CadDocumentContext.None, copyDesignRunning: true));
        }
    }

    [Theory]
    [MemberData(nameof(AllStates))]
    public void When_nothing_is_running_enablement_is_unchanged(ConnectionState state)
    {
        var doc = Doc(LocalCheckoutState.CheckedOutByMe);

        Assert.Equal(
            RibbonCommandPolicy.Evaluate(state, doc, "ENGINEER", true, true, true),
            RibbonCommandPolicy.Evaluate(state, doc, "ENGINEER", true, true, true, copyDesignRunning: false));
    }
}
