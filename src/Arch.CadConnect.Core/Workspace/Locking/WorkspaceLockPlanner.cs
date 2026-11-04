namespace Arch.CadConnect.Core.Workspace.Locking;

public enum WorkspaceLockCommandKind
{
    /// <summary>Get Latest into a target folder (an existing workspace or a
    ///  new one).</summary>
    GetLatest,

    /// <summary>Checkout, Check In, Undo Checkout - one file of an existing
    ///  workspace.</summary>
    DocumentCommand,

    /// <summary>Copy Design Apply, Resume, Recover.</summary>
    CopyDesign,
}

/// <summary>What a command is about to touch - the planner's only input.</summary>
public sealed record WorkspaceLockRequest(
    string Command,
    WorkspaceLockCommandKind Kind,
    string? TargetPath = null,
    string? ServerOrigin = null,
    string? IdempotencyKey = null,
    IReadOnlyList<string>? SourcePaths = null,
    IReadOnlyList<string>? DestinationFilePaths = null)
{
    public static WorkspaceLockRequest ForGetLatest(string command, string targetRoot) =>
        new(command, WorkspaceLockCommandKind.GetLatest, TargetPath: targetRoot);

    public static WorkspaceLockRequest ForDocument(string command, string absoluteFilePath) =>
        new(command, WorkspaceLockCommandKind.DocumentCommand, TargetPath: absoluteFilePath);

    public static WorkspaceLockRequest ForCopyDesign(
        string command, string serverOrigin, string idempotencyKey,
        IReadOnlyList<string> sourcePaths, IReadOnlyList<string> destinationFilePaths) =>
        new(command, WorkspaceLockCommandKind.CopyDesign, ServerOrigin: serverOrigin, IdempotencyKey: idempotencyKey,
            SourcePaths: sourcePaths, DestinationFilePaths: destinationFilePaths);
}

/// <summary>The ordered locks one request needs (operation, then
///  destinations, then workspaces - each group sorted).</summary>
public sealed record WorkspaceLockPlan(WorkspaceLockRequest Request, IReadOnlyList<LockTarget> Targets);

public sealed record WorkspaceLockPlanResult(WorkspaceLockPlan? Plan, WorkspaceLockRefusal? Refusal)
{
    public static WorkspaceLockPlanResult Planned(WorkspaceLockPlan plan) => new(plan, null);

    public static WorkspaceLockPlanResult Refused(WorkspaceLockRefusal refusal) => new(null, refusal);
}

/// <summary>
/// P6 M4.4: decides WHICH locks a command needs - PURE apart from read-only
/// queries through <see cref="ILockPathSystem"/>, so planning (and every
/// refusal it makes) never creates a lock artifact.
/// <list type="bullet">
/// <item>Every path is resolved to its real location first; only LOCAL
///  volumes are lockable. Network, cloud-sync, unsupported and unresolvable
///  paths FAIL CLOSED.</item>
/// <item>A workspace root is the nearest ancestor with a manifest, found on
///  the resolved path AND on the path as given; if they disagree (a link
///  leading into a different workspace) the root is AMBIGUOUS - refused.
///  A root inside another workspace is NESTED - refused.</item>
/// <item>Get Latest and the document commands: W exclusive on the root.</item>
/// <item>Copy Design: O exclusive; every destination inside a workspace
///  makes that root W exclusive; every unmanaged destination folder gets D
///  exclusive (refused when this machine publishes it as a share, or the
///  share list is unreadable); every source workspace root gets W shared
///  (exclusive if it is also a destination root). Two destinations that are
///  the same file, a destination that is a source, a destination that is a
///  folder, and any destination inside an <c>.arch</c> folder are refused.</item>
/// </list>
/// </summary>
public sealed class WorkspaceLockPlanner(ILockPathSystem paths)
{
    private const int MaxAncestorHops = 128;

    public WorkspaceLockPlanResult Plan(WorkspaceLockRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        try
        {
            return request.Kind switch
            {
                WorkspaceLockCommandKind.GetLatest => PlanGetLatest(request),
                WorkspaceLockCommandKind.DocumentCommand => PlanDocument(request),
                _ => PlanCopyDesign(request),
            };
        }
        catch (RefusedException refused)
        {
            return WorkspaceLockPlanResult.Refused(refused.Refusal);
        }
    }

    /// <summary>
    /// After the locks are held: plan the same request again and require the
    /// same locks over the same, unchanged paths and workspace bindings.
    /// Returns null when nothing changed.
    /// </summary>
    public WorkspaceLockRefusal? Revalidate(WorkspaceLockPlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        var again = Plan(plan.Request);
        if (again.Refusal is { } refusal) return refusal;
        var now = again.Plan!.Targets;
        if (now.Count != plan.Targets.Count)
        {
            return new WorkspaceLockRefusal(WorkspaceLockErrorCodes.PathChanged);
        }
        for (var i = 0; i < now.Count; i++)
        {
            var before = plan.Targets[i];
            var after = now[i];
            if (before.Scope != after.Scope || before.Mode != after.Mode || !string.Equals(before.Key, after.Key, StringComparison.Ordinal))
            {
                return new WorkspaceLockRefusal(WorkspaceLockErrorCodes.PathChanged, before.Scope, before.Mode, before.DisplayPath);
            }
            if (before.Identity is { } was && after.Identity is { } @is && !StillSame(was, @is))
            {
                var code = was.Binding != @is.Binding ? WorkspaceLockErrorCodes.WorkspaceChanged : WorkspaceLockErrorCodes.PathChanged;
                return new WorkspaceLockRefusal(code, before.Scope, before.Mode, before.DisplayPath);
            }
        }
        return null;
    }

    /// <summary>An existing folder must be the very same folder with the same
    ///  binding. A folder that did not exist yet (a new Get Latest root) may
    ///  have been created since - by taking its own lock - but its nearest
    ///  existing ancestor must still be the same folder.</summary>
    private bool StillSame(LockIdentity before, LockIdentity after)
    {
        if (before.Binding != after.Binding || !LockPaths.AreSame(before.CanonicalPath, after.CanonicalPath))
        {
            return false;
        }
        if (before.Exists)
        {
            return after.Exists && before.Id == after.Id;
        }
        var ancestor = paths.Resolve(before.ExistingAncestor);
        return ancestor.IsResolved && ancestor.Exists && ancestor.Id == before.AncestorId
            && LockPaths.AreSame(ancestor.Canonical, before.ExistingAncestor);
    }

    // ------------------------------------------------------------------

    private WorkspaceLockPlanResult PlanGetLatest(WorkspaceLockRequest request)
    {
        var target = ResolveLocal(request.TargetPath);
        if (target.Exists && !target.IsDirectory)
        {
            throw Refuse(WorkspaceLockErrorCodes.PathUnresolvable, target);
        }
        var root = RootOf(target, isDirectory: true);
        if (root is not null && !LockPaths.AreSame(root, target.Canonical))
        {
            // The target folder lies inside another workspace.
            throw Refuse(WorkspaceLockErrorCodes.NestedWorkspace, target);
        }
        return Planned(request, new[] { WorkspaceTarget(target.Canonical, LockMode.Exclusive) });
    }

    private WorkspaceLockPlanResult PlanDocument(WorkspaceLockRequest request)
    {
        var file = ResolveLocal(request.TargetPath);
        var root = RootOf(file, isDirectory: false)
            ?? throw Refuse(WorkspaceLockErrorCodes.NotInWorkspace, file);
        return Planned(request, new[] { WorkspaceTarget(root, LockMode.Exclusive) });
    }

    private WorkspaceLockPlanResult PlanCopyDesign(WorkspaceLockRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.ServerOrigin) || string.IsNullOrWhiteSpace(request.IdempotencyKey))
        {
            throw new RefusedException(new WorkspaceLockRefusal(WorkspaceLockErrorCodes.OperationKeyMissing, LockScope.Operation, LockMode.Exclusive));
        }

        // Sources: every one must resolve; a source inside a workspace makes
        // that root W shared (and the root must be lockable - local).
        var sourceKeys = new HashSet<string>(StringComparer.Ordinal);
        var rootModes = new Dictionary<string, (string Root, LockMode Mode)>(StringComparer.Ordinal);
        foreach (var source in request.SourcePaths ?? Array.Empty<string>())
        {
            var resolved = paths.Resolve(source);
            if (!resolved.IsResolved)
            {
                throw Refuse(WorkspaceLockErrorCodes.PathUnresolvable, resolved);
            }
            sourceKeys.Add(LockPaths.Key(resolved.Canonical));
            if (RootOf(resolved, isDirectory: false) is { } sourceRoot)
            {
                RequireLocal(paths.Resolve(sourceRoot));
                rootModes.TryAdd(LockPaths.Key(sourceRoot), (sourceRoot, LockMode.Shared));
            }
        }

        // Destinations.
        var destinationKeys = new HashSet<string>(StringComparer.Ordinal);
        var folders = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (var destination in request.DestinationFilePaths ?? Array.Empty<string>())
        {
            var resolved = ResolveLocal(destination);
            if (resolved.Exists && resolved.IsDirectory)
            {
                throw Refuse(WorkspaceLockErrorCodes.DestinationOverlap, resolved);
            }
            if (IsInsideArchFolder(resolved.Canonical))
            {
                throw Refuse(WorkspaceLockErrorCodes.DestinationReservedPath, resolved);
            }
            var key = LockPaths.Key(resolved.Canonical);
            if (!destinationKeys.Add(key))
            {
                throw Refuse(WorkspaceLockErrorCodes.DestinationOverlap, resolved);
            }
            if (sourceKeys.Contains(key))
            {
                throw Refuse(WorkspaceLockErrorCodes.DestinationOverlapsSource, resolved);
            }

            if (RootOf(resolved, isDirectory: false) is { } destinationRoot)
            {
                rootModes[LockPaths.Key(destinationRoot)] = (destinationRoot, LockMode.Exclusive);
                continue;
            }
            switch (resolved.Sharing)
            {
                case ShareExposure.Shared: throw Refuse(WorkspaceLockErrorCodes.PathSharedUnsupported, resolved);
                case ShareExposure.Unknown: throw Refuse(WorkspaceLockErrorCodes.ShareStatusUnknown, resolved);
            }
            var folder = Path.GetDirectoryName(resolved.Canonical)
                ?? throw Refuse(WorkspaceLockErrorCodes.PathUnresolvable, resolved);
            folders.TryAdd(LockPaths.Key(folder), folder);
        }

        var targets = new List<LockTarget>
        {
            new(LockScope.Operation, LockMode.Exclusive, OperationKey(request.ServerOrigin, request.IdempotencyKey), null, null),
        };
        foreach (var (key, folder) in folders)
        {
            var resolved = paths.Resolve(folder);
            targets.Add(new LockTarget(LockScope.Destination, LockMode.Exclusive, key, resolved.Canonical, IdentityOf(resolved, binding: null)));
        }
        foreach (var (_, (root, mode)) in rootModes.OrderBy(kv => kv.Key, StringComparer.Ordinal))
        {
            targets.Add(WorkspaceTarget(root, mode));
        }
        return Planned(request, targets);
    }

    /// <summary>The machine-wide operation key: the server origin (case-
    ///  insensitive) and the idempotency key (exact).</summary>
    public static string OperationKey(string serverOrigin, string idempotencyKey) =>
        serverOrigin.Trim().TrimEnd('/').ToLowerInvariant() + "|" + idempotencyKey;

    // ------------------------------------------------------------------

    private LockTarget WorkspaceTarget(string root, LockMode mode)
    {
        var resolved = RequireLocal(paths.Resolve(root));
        var binding = paths.ReadBinding(resolved.Canonical);
        if (binding.IsRecoveryRequired)
        {
            // Here, the one place every workspace target passes through: planning
            // takes no lock, and revalidation plans again under the locks.
            throw Refuse(WorkspaceLockErrorCodes.WorkspaceRecoveryRequired, resolved);
        }
        return new LockTarget(LockScope.Workspace, mode, resolved.Canonical, resolved.Canonical, IdentityOf(resolved, binding));
    }

    private static LockIdentity IdentityOf(ResolvedPath resolved, WorkspaceBindingSnapshot? binding) =>
        new(resolved.Canonical, resolved.Exists, resolved.Id, resolved.ExistingAncestor, resolved.AncestorId, binding);

    private ResolvedPath ResolveLocal(string? path) => RequireLocal(paths.Resolve(path ?? ""));

    private static ResolvedPath RequireLocal(ResolvedPath resolved) =>
        WorkspaceLockErrorCodes.ForLocality(resolved.Locality) is { } code ? throw Refuse(code, resolved) : resolved;

    /// <summary>The workspace containing <paramref name="resolved"/> - the
    ///  same on the resolved and the as-given path, and not nested.</summary>
    private string? RootOf(ResolvedPath resolved, bool isDirectory)
    {
        var canonicalRoot = FindRoot(isDirectory ? resolved.Canonical : Path.GetDirectoryName(resolved.Canonical));
        var lexicalRoot = FindRoot(isDirectory ? resolved.Requested : Path.GetDirectoryName(resolved.Requested));

        string? lexicalCanonical = null;
        if (lexicalRoot is not null)
        {
            var lexical = paths.Resolve(lexicalRoot);
            lexicalCanonical = lexical.IsResolved ? lexical.Canonical : lexicalRoot + "\\[unresolvable]";
        }
        var agree = canonicalRoot is null
            ? lexicalCanonical is null
            : lexicalCanonical is not null && LockPaths.AreSame(canonicalRoot, lexicalCanonical);
        if (!agree)
        {
            throw Refuse(WorkspaceLockErrorCodes.AmbiguousRoot, resolved);
        }
        if (canonicalRoot is not null && FindRoot(Path.GetDirectoryName(canonicalRoot)) is not null)
        {
            throw Refuse(WorkspaceLockErrorCodes.NestedWorkspace, resolved);
        }
        return canonicalRoot;
    }

    private string? FindRoot(string? start)
    {
        var current = start;
        for (var hop = 0; hop < MaxAncestorHops && !string.IsNullOrEmpty(current); hop++)
        {
            if (paths.HasManifest(current)) return current;
            var parent = Path.GetDirectoryName(current);
            if (parent is null || string.Equals(parent, current, StringComparison.Ordinal)) break;
            current = parent;
        }
        return null;
    }

    private static bool IsInsideArchFolder(string path) =>
        path.Split('\\', '/').Any(segment => string.Equals(segment, ".arch", StringComparison.OrdinalIgnoreCase));

    private static WorkspaceLockPlanResult Planned(WorkspaceLockRequest request, IReadOnlyList<LockTarget> targets) =>
        WorkspaceLockPlanResult.Planned(new WorkspaceLockPlan(request, targets));

    private static RefusedException Refuse(string code, ResolvedPath at) =>
        new(new WorkspaceLockRefusal(code, Path: at.Canonical, Locality: at.Locality));

    private sealed class RefusedException(WorkspaceLockRefusal refusal) : Exception
    {
        public WorkspaceLockRefusal Refusal { get; } = refusal;
    }
}
