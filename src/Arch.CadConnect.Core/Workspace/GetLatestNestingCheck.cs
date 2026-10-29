namespace Arch.CadConnect.Core.Workspace;

/// <summary>
/// P6 M4.4: before Get Latest downloads ANY entry, every entry's local path
/// must belong to the Get Latest root itself - its nearest workspace (the
/// nearest ancestor with <c>.arch\workspace.json</c>) must be either none
/// (a new workspace) or exactly that root. An entry that would land inside
/// ANOTHER workspace - the root nested inside an outer one, or a workspace
/// nested below it - would be written under one workspace's lock while
/// belonging to another's manifest: the whole Get Latest is refused.
/// PURE apart from the injected root lookup.
/// </summary>
public static class GetLatestNestingCheck
{
    public const string ProblemKind = "nested-workspace";

    public static IReadOnlyList<WorkspacePlanProblem> FindNestedEntries(
        WorkspacePlan plan, string workspaceRoot, Func<string, string?> findRootForFile)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(findRootForFile);
        SafeWorkspacePath.RequireAbsoluteRoot(workspaceRoot);
        var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(workspaceRoot));

        var problems = new List<WorkspacePlanProblem>();
        foreach (var entry in plan.Entries)
        {
            string absolutePath;
            try
            {
                absolutePath = SafeWorkspacePath.ResolveWithinRoot(root, entry.Placement.GeneratedRelativePath);
            }
            catch (Exception ex) when (ex is UnsafeWorkspacePathException or WorkspaceRootException)
            {
                continue; // the materializer blocks an unusable path on its own
            }

            var owner = findRootForFile(absolutePath);
            if (owner is not null && !string.Equals(Path.TrimEndingDirectorySeparator(owner), root, StringComparison.OrdinalIgnoreCase))
            {
                problems.Add(new WorkspacePlanProblem
                {
                    Kind = ProblemKind,
                    Message = $"\"{entry.Placement.GeneratedRelativePath}\" would be written inside another Arch PLM workspace "
                        + $"(\"{owner}\"). Nested workspaces are not supported - choose a folder outside any other workspace.",
                    CadDocumentId = entry.CadDocumentId,
                    WorkspacePath = entry.Placement.GeneratedRelativePath,
                });
            }
        }
        return problems;
    }
}
