using Arch.CadConnect.Core.Workspace.Locking;

namespace Arch.CadConnect.Core.Tests.Workspace.Locking;

/// <summary>
/// P6 M4.4: the lock MATRIX and coverage rules, over a scripted file system -
/// which locks each command needs and in which order, the fail-closed path
/// classes, nested and ambiguous roots, overlapping destinations, and the
/// after-acquisition revalidation.
/// </summary>
public class WorkspaceLockPlannerTests
{
    private const string Origin = "http://localhost:3100";

    private static (LockScope, LockMode, string)[] Shape(WorkspaceLockPlanResult result)
    {
        Assert.Null(result.Refusal);
        return result.Plan!.Targets.Select(t => (t.Scope, t.Mode, t.Key)).ToArray();
    }

    private static string RefusalCode(WorkspaceLockPlanResult result)
    {
        Assert.Null(result.Plan);
        return result.Refusal!.ErrorCode;
    }

    // ---- Get Latest -----------------------------------------------------------

    [Fact]
    public void Get_Latest_locks_its_target_workspace_exclusively()
    {
        var fs = new FakeLockPathSystem().Workspace(@"D:\WS");

        var result = new WorkspaceLockPlanner(fs).Plan(WorkspaceLockRequest.ForGetLatest("Get Latest", @"D:\WS"));

        Assert.Equal(new[] { (LockScope.Workspace, LockMode.Exclusive, @"D:\WS") }, Shape(result));
        var identity = result.Plan!.Targets[0].Identity!;
        Assert.True(identity.Exists);
        Assert.Equal(Origin, identity.Binding!.ServerOrigin);
    }

    [Fact]
    public void Get_Latest_into_a_new_folder_locks_the_folder_it_will_create()
    {
        var fs = new FakeLockPathSystem().Dir(@"D:\Projects");

        var result = new WorkspaceLockPlanner(fs).Plan(WorkspaceLockRequest.ForGetLatest("Get Latest", @"D:\Projects\New"));

        Assert.Equal(new[] { (LockScope.Workspace, LockMode.Exclusive, @"D:\Projects\New") }, Shape(result));
        var identity = result.Plan!.Targets[0].Identity!;
        Assert.False(identity.Exists);
        Assert.Equal(@"D:\Projects", identity.ExistingAncestor);
        Assert.Equal(WorkspaceBindingSnapshot.None, identity.Binding);
    }

    [Fact]
    public void Get_Latest_into_a_folder_inside_another_workspace_is_refused_as_nested()
    {
        var fs = new FakeLockPathSystem().Workspace(@"D:\WS").Dir(@"D:\WS\sub");

        Assert.Equal(WorkspaceLockErrorCodes.NestedWorkspace,
            RefusalCode(new WorkspaceLockPlanner(fs).Plan(WorkspaceLockRequest.ForGetLatest("Get Latest", @"D:\WS\sub"))));
    }

    [Fact]
    public void Get_Latest_onto_a_file_is_refused()
    {
        var fs = new FakeLockPathSystem().File(@"D:\data\a.ipt");

        Assert.Equal(WorkspaceLockErrorCodes.PathUnresolvable,
            RefusalCode(new WorkspaceLockPlanner(fs).Plan(WorkspaceLockRequest.ForGetLatest("Get Latest", @"D:\data\a.ipt"))));
    }

    [Theory]
    [InlineData(PathLocality.Network, WorkspaceLockErrorCodes.PathNetworkUnsupported)]
    [InlineData(PathLocality.CloudSync, WorkspaceLockErrorCodes.PathSyncUnsupported)]
    [InlineData(PathLocality.UnsupportedDrive, WorkspaceLockErrorCodes.PathTypeUnsupported)]
    [InlineData(PathLocality.Unresolvable, WorkspaceLockErrorCodes.PathUnresolvable)]
    public void Every_non_local_path_class_fails_closed_for_every_command(PathLocality locality, string expected)
    {
        var fs = new FakeLockPathSystem().Workspace(@"N:\WS").File(@"N:\WS\a.ipt").Dir(@"D:\out");
        fs.Localities[@"N:\"] = locality;
        var planner = new WorkspaceLockPlanner(fs);

        Assert.Equal(expected, RefusalCode(planner.Plan(WorkspaceLockRequest.ForGetLatest("Get Latest", @"N:\WS"))));
        Assert.Equal(expected, RefusalCode(planner.Plan(WorkspaceLockRequest.ForDocument("Checkout", @"N:\WS\a.ipt"))));
        // a Copy Design SOURCE workspace there cannot be locked either
        var copy = planner.Plan(WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", Origin, "key-1",
            new[] { @"N:\WS\a.ipt" }, new[] { @"D:\out\b.ipt" }));
        Assert.Equal(expected, RefusalCode(copy));
        // ...nor a destination
        var fs2 = new FakeLockPathSystem().File(@"D:\src\a.ipt").Dir(@"N:\out");
        fs2.Localities[@"N:\"] = locality;
        Assert.Equal(expected, RefusalCode(new WorkspaceLockPlanner(fs2).Plan(WorkspaceLockRequest.ForCopyDesign(
            "Apply Copy Design", Origin, "key-1", new[] { @"D:\src\a.ipt" }, new[] { @"N:\out\b.ipt" }))));
    }

    // ---- Checkout / Check In / Undo ---------------------------------------------

    [Theory]
    [InlineData("Checkout")]
    [InlineData("Check In")]
    [InlineData("Undo Checkout")]
    public void A_document_command_locks_the_file_s_workspace_exclusively(string command)
    {
        var fs = new FakeLockPathSystem().Workspace(@"D:\WS").File(@"D:\WS\parts\a.ipt");

        var result = new WorkspaceLockPlanner(fs).Plan(WorkspaceLockRequest.ForDocument(command, @"D:\WS\parts\a.ipt"));

        Assert.Equal(new[] { (LockScope.Workspace, LockMode.Exclusive, @"D:\WS") }, Shape(result));
    }

    [Fact]
    public void A_document_outside_any_workspace_is_refused()
    {
        var fs = new FakeLockPathSystem().File(@"D:\loose\a.ipt");

        Assert.Equal(WorkspaceLockErrorCodes.NotInWorkspace,
            RefusalCode(new WorkspaceLockPlanner(fs).Plan(WorkspaceLockRequest.ForDocument("Checkout", @"D:\loose\a.ipt"))));
    }

    [Fact]
    public void A_workspace_nested_inside_another_is_refused()
    {
        var fs = new FakeLockPathSystem().Workspace(@"D:\Outer").Workspace(@"D:\Outer\Inner").File(@"D:\Outer\Inner\a.ipt");

        Assert.Equal(WorkspaceLockErrorCodes.NestedWorkspace,
            RefusalCode(new WorkspaceLockPlanner(fs).Plan(WorkspaceLockRequest.ForDocument("Checkout", @"D:\Outer\Inner\a.ipt"))));
    }

    [Fact]
    public void A_link_that_leads_into_a_different_workspace_than_the_path_as_given_is_an_ambiguous_root()
    {
        // D:\WS1\link is a junction to D:\WS2\sub: the path as given is in WS1,
        // the file really is in WS2.
        var fs = new FakeLockPathSystem().Workspace(@"D:\WS1").Workspace(@"D:\WS2").File(@"D:\WS2\sub\a.ipt");
        fs.Aliases[@"D:\WS1\link"] = @"D:\WS2\sub";

        Assert.Equal(WorkspaceLockErrorCodes.AmbiguousRoot,
            RefusalCode(new WorkspaceLockPlanner(fs).Plan(WorkspaceLockRequest.ForDocument("Checkout", @"D:\WS1\link\a.ipt"))));
    }

    [Fact]
    public void An_alias_that_agrees_with_the_real_path_is_locked_under_the_real_root()
    {
        // L:\ is a subst / junction of D:\Real - the same workspace either way.
        var fs = new FakeLockPathSystem().Workspace(@"D:\Real\WS").File(@"D:\Real\WS\a.ipt");
        fs.Aliases[@"L:\"] = @"D:\Real\";

        var result = new WorkspaceLockPlanner(fs).Plan(WorkspaceLockRequest.ForDocument("Checkout", @"L:\WS\a.ipt"));

        Assert.Equal(new[] { (LockScope.Workspace, LockMode.Exclusive, @"D:\Real\WS") }, Shape(result));
    }

    // ---- Copy Design ------------------------------------------------------------

    [Fact]
    public void Copy_Design_takes_the_operation_then_destinations_then_workspaces_each_sorted()
    {
        var fs = new FakeLockPathSystem()
            .Workspace(@"D:\SrcB").Workspace(@"D:\SrcA").Workspace(@"D:\DestWS")
            .File(@"D:\SrcB\b.ipt", @"D:\SrcA\a.iam").Dir(@"D:\Out\Z", @"D:\Out\A");

        var result = new WorkspaceLockPlanner(fs).Plan(WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", Origin, "Key-AbC",
            new[] { @"D:\SrcB\b.ipt", @"D:\SrcA\a.iam" },
            new[] { @"D:\Out\Z\b2.ipt", @"D:\Out\A\a2.iam", @"D:\DestWS\c2.ipt" }));

        Assert.Equal(new[]
        {
            (LockScope.Operation, LockMode.Exclusive, "http://localhost:3100|Key-AbC"),
            (LockScope.Destination, LockMode.Exclusive, @"D:\OUT\A"),
            (LockScope.Destination, LockMode.Exclusive, @"D:\OUT\Z"),
            (LockScope.Workspace, LockMode.Exclusive, @"D:\DestWS"),
            (LockScope.Workspace, LockMode.Shared, @"D:\SrcA"),
            (LockScope.Workspace, LockMode.Shared, @"D:\SrcB"),
        }, Shape(result));
    }

    [Fact]
    public void A_root_that_is_both_source_and_destination_is_locked_once_exclusively()
    {
        var fs = new FakeLockPathSystem().Workspace(@"D:\WS").File(@"D:\WS\a.ipt").Dir(@"D:\WS\copies");

        var result = new WorkspaceLockPlanner(fs).Plan(WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", Origin, "k",
            new[] { @"D:\WS\a.ipt" }, new[] { @"D:\WS\copies\a2.ipt" }));

        Assert.Equal(new[]
        {
            (LockScope.Operation, LockMode.Exclusive, "http://localhost:3100|k"),
            (LockScope.Workspace, LockMode.Exclusive, @"D:\WS"),
        }, Shape(result));
    }

    [Fact]
    public void Sources_outside_any_workspace_need_no_lock_even_on_a_network_library()
    {
        var fs = new FakeLockPathSystem().File(@"\\lib\share\std.ipt").Dir(@"D:\Out");
        fs.Localities[@"\\lib\"] = PathLocality.Network;

        var result = new WorkspaceLockPlanner(fs).Plan(WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", Origin, "k",
            new[] { @"\\lib\share\std.ipt" }, new[] { @"D:\Out\a.ipt" }));

        Assert.Equal(new[] { LockScope.Operation, LockScope.Destination }, result.Plan!.Targets.Select(t => t.Scope));
    }

    [Fact]
    public void Several_destinations_in_one_folder_take_one_destination_lock()
    {
        var fs = new FakeLockPathSystem().File(@"D:\src\a.ipt", @"D:\src\b.ipt").Dir(@"D:\Out");

        var result = new WorkspaceLockPlanner(fs).Plan(WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", Origin, "k",
            new[] { @"D:\src\a.ipt", @"D:\src\b.ipt" }, new[] { @"D:\Out\a2.ipt", @"D:\OUT\b2.ipt" }));

        Assert.Single(result.Plan!.Targets, t => t.Scope == LockScope.Destination);
    }

    [Fact]
    public void A_destination_folder_that_does_not_exist_yet_creates_nothing_and_is_keyed_under_its_real_parent()
    {
        var fs = new FakeLockPathSystem().File(@"D:\src\a.ipt").Dir(@"D:\Real");
        fs.Aliases[@"J:\"] = @"D:\Real\";

        var viaAlias = new WorkspaceLockPlanner(fs).Plan(WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", Origin, "k",
            new[] { @"D:\src\a.ipt" }, new[] { @"J:\New\a2.ipt" }));
        var direct = new WorkspaceLockPlanner(fs).Plan(WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", Origin, "k",
            new[] { @"D:\src\a.ipt" }, new[] { @"d:\real\new\a2.ipt" }));

        Assert.Equal(@"D:\REAL\NEW", viaAlias.Plan!.Targets.Single(t => t.Scope == LockScope.Destination).Key);
        Assert.Equal(viaAlias.Plan.Targets.Single(t => t.Scope == LockScope.Destination).Key,
            direct.Plan!.Targets.Single(t => t.Scope == LockScope.Destination).Key);
    }

    [Theory]
    [InlineData(@"D:\Out\a2.ipt", @"D:\Out\A2.IPT", WorkspaceLockErrorCodes.DestinationOverlap)]
    [InlineData(@"D:\Out\a2.ipt", @"J:\a2.ipt", WorkspaceLockErrorCodes.DestinationOverlap)] // the same file through an alias
    [InlineData(@"D:\src\a.ipt", @"D:\Out\b2.ipt", WorkspaceLockErrorCodes.DestinationOverlapsSource)]
    [InlineData(@"D:\Out\folder", @"D:\Out\b2.ipt", WorkspaceLockErrorCodes.DestinationOverlap)] // a folder, not a file
    [InlineData(@"D:\Out\.arch\a2.ipt", @"D:\Out\b2.ipt", WorkspaceLockErrorCodes.DestinationReservedPath)]
    public void Unsafe_overlapping_destinations_are_refused(string first, string second, string expected)
    {
        var fs = new FakeLockPathSystem().File(@"D:\src\a.ipt", @"D:\src\b.ipt").Dir(@"D:\Out\folder");
        fs.Aliases[@"J:\"] = @"D:\Out\";

        var result = new WorkspaceLockPlanner(fs).Plan(WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", Origin, "k",
            new[] { @"D:\src\a.ipt", @"D:\src\b.ipt" }, new[] { first, second }));

        Assert.Equal(expected, RefusalCode(result));
    }

    [Fact]
    public void An_unmanaged_destination_this_machine_publishes_as_a_share_fails_closed()
    {
        var fs = new FakeLockPathSystem().File(@"D:\src\a.ipt").Dir(@"D:\Shared\Out");
        fs.SharedRoots.Add(@"D:\Shared");

        Assert.Equal(WorkspaceLockErrorCodes.PathSharedUnsupported, RefusalCode(new WorkspaceLockPlanner(fs).Plan(
            WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", Origin, "k", new[] { @"D:\src\a.ipt" }, new[] { @"D:\Shared\Out\a2.ipt" }))));
    }

    [Fact]
    public void An_unreadable_share_list_fails_closed_for_unmanaged_destinations_only()
    {
        var fs = new FakeLockPathSystem().File(@"D:\src\a.ipt").Dir(@"D:\Out").Workspace(@"D:\WS");
        fs.ShareListUnreadable = true;
        var planner = new WorkspaceLockPlanner(fs);

        Assert.Equal(WorkspaceLockErrorCodes.ShareStatusUnknown, RefusalCode(planner.Plan(
            WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", Origin, "k", new[] { @"D:\src\a.ipt" }, new[] { @"D:\Out\a2.ipt" }))));
        // a destination INSIDE a workspace is locked in place - visible to every writer
        Assert.Null(planner.Plan(
            WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", Origin, "k", new[] { @"D:\src\a.ipt" }, new[] { @"D:\WS\a2.ipt" })).Refusal);
    }

    [Fact]
    public void A_destination_inside_a_nested_workspace_is_refused()
    {
        var fs = new FakeLockPathSystem().File(@"D:\src\a.ipt").Workspace(@"D:\Outer").Workspace(@"D:\Outer\Inner");

        Assert.Equal(WorkspaceLockErrorCodes.NestedWorkspace, RefusalCode(new WorkspaceLockPlanner(fs).Plan(
            WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", Origin, "k", new[] { @"D:\src\a.ipt" }, new[] { @"D:\Outer\Inner\a2.ipt" }))));
    }

    [Theory]
    [InlineData("", "k")]
    [InlineData(Origin, "")]
    [InlineData(" ", " ")]
    public void Copy_Design_without_an_operation_identity_is_refused(string origin, string key)
    {
        var fs = new FakeLockPathSystem().File(@"D:\src\a.ipt").Dir(@"D:\Out");

        Assert.Equal(WorkspaceLockErrorCodes.OperationKeyMissing, RefusalCode(new WorkspaceLockPlanner(fs).Plan(
            WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", origin, key, new[] { @"D:\src\a.ipt" }, new[] { @"D:\Out\a2.ipt" }))));
    }

    [Fact]
    public void The_operation_key_ignores_origin_case_and_a_trailing_slash_but_never_the_key_case()
    {
        Assert.Equal(WorkspaceLockPlanner.OperationKey("HTTP://LocalHost:3100/", "AbC"), WorkspaceLockPlanner.OperationKey("http://localhost:3100", "AbC"));
        Assert.NotEqual(WorkspaceLockPlanner.OperationKey(Origin, "AbC"), WorkspaceLockPlanner.OperationKey(Origin, "abc"));
        Assert.NotEqual(WorkspaceLockPlanner.OperationKey("http://localhost:3000", "AbC"), WorkspaceLockPlanner.OperationKey(Origin, "AbC"));
    }

    [Fact]
    public void A_missing_source_is_refused()
    {
        var fs = new FakeLockPathSystem().Dir(@"D:\Out");
        fs.Localities[@"X:\"] = PathLocality.Unresolvable;

        Assert.Equal(WorkspaceLockErrorCodes.PathUnresolvable, RefusalCode(new WorkspaceLockPlanner(fs).Plan(
            WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", Origin, "k", new[] { @"X:\gone.ipt" }, new[] { @"D:\Out\a2.ipt" }))));
    }

    // ---- revalidation ------------------------------------------------------------

    [Fact]
    public void Revalidation_passes_when_nothing_changed()
    {
        var fs = new FakeLockPathSystem().Workspace(@"D:\WS").File(@"D:\WS\a.ipt");
        var planner = new WorkspaceLockPlanner(fs);
        var plan = planner.Plan(WorkspaceLockRequest.ForDocument("Checkout", @"D:\WS\a.ipt")).Plan!;

        Assert.Null(planner.Revalidate(plan));
    }

    [Fact]
    public void Revalidation_refuses_a_workspace_replaced_by_another_folder()
    {
        var fs = new FakeLockPathSystem().Workspace(@"D:\WS").File(@"D:\WS\a.ipt");
        var planner = new WorkspaceLockPlanner(fs);
        var plan = planner.Plan(WorkspaceLockRequest.ForDocument("Checkout", @"D:\WS\a.ipt")).Plan!;

        fs.Replace(@"D:\WS");

        Assert.Equal(WorkspaceLockErrorCodes.PathChanged, planner.Revalidate(plan)!.ErrorCode);
    }

    [Fact]
    public void Revalidation_refuses_a_workspace_re_bound_to_another_server()
    {
        var fs = new FakeLockPathSystem().Workspace(@"D:\WS").File(@"D:\WS\a.ipt");
        var planner = new WorkspaceLockPlanner(fs);
        var plan = planner.Plan(WorkspaceLockRequest.ForDocument("Checkout", @"D:\WS\a.ipt")).Plan!;

        fs.Workspace(@"D:\WS", "http://localhost:3000");

        Assert.Equal(WorkspaceLockErrorCodes.WorkspaceChanged, planner.Revalidate(plan)!.ErrorCode);
    }

    [Fact]
    public void Revalidation_refuses_a_new_Get_Latest_folder_bound_by_someone_else_meanwhile()
    {
        var fs = new FakeLockPathSystem().Dir(@"D:\Projects");
        var planner = new WorkspaceLockPlanner(fs);
        var plan = planner.Plan(WorkspaceLockRequest.ForGetLatest("Get Latest", @"D:\Projects\New")).Plan!;

        fs.Workspace(@"D:\Projects\New", "http://localhost:3000");

        Assert.Equal(WorkspaceLockErrorCodes.WorkspaceChanged, planner.Revalidate(plan)!.ErrorCode);
    }

    [Fact]
    public void Revalidation_accepts_a_new_Get_Latest_folder_created_by_its_own_lock()
    {
        var fs = new FakeLockPathSystem().Dir(@"D:\Projects");
        var planner = new WorkspaceLockPlanner(fs);
        var plan = planner.Plan(WorkspaceLockRequest.ForGetLatest("Get Latest", @"D:\Projects\New")).Plan!;

        fs.Dir(@"D:\Projects\New\.arch\locks"); // what taking the W lock creates

        Assert.Null(planner.Revalidate(plan));
    }

    [Fact]
    public void Revalidation_refuses_when_the_parent_of_a_new_folder_was_replaced()
    {
        var fs = new FakeLockPathSystem().Dir(@"D:\Projects");
        var planner = new WorkspaceLockPlanner(fs);
        var plan = planner.Plan(WorkspaceLockRequest.ForGetLatest("Get Latest", @"D:\Projects\New")).Plan!;

        fs.Replace(@"D:\Projects");

        Assert.Equal(WorkspaceLockErrorCodes.PathChanged, planner.Revalidate(plan)!.ErrorCode);
    }

    [Fact]
    public void Revalidation_refuses_a_workspace_that_became_nested()
    {
        var fs = new FakeLockPathSystem().Workspace(@"D:\Jobs\WS").File(@"D:\Jobs\WS\a.ipt");
        var planner = new WorkspaceLockPlanner(fs);
        var plan = planner.Plan(WorkspaceLockRequest.ForDocument("Checkout", @"D:\Jobs\WS\a.ipt")).Plan!;

        fs.Workspace(@"D:\Jobs");

        Assert.Equal(WorkspaceLockErrorCodes.NestedWorkspace, planner.Revalidate(plan)!.ErrorCode);
    }
}
