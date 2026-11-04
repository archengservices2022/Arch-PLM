using System.Linq;

using Arch.CadConnect.Api;
using Arch.CadConnect.Api.Dtos;
using Arch.CadConnect.Core.Connection;
using Arch.CadConnect.Core.References;
using Arch.CadConnect.Core.Session;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Api.Tests;

public partial class ArchConnectionManagerTests
{
    private sealed class FakeApi : IArchApi
    {
        public FakeApi(ArchServerUri server) => Server = server;
        public ArchServerUri Server { get; }

        public Func<IArchSession>? OnSignIn { get; set; }
        public Func<Task>? OnGetSession { get; set; }
        public Action? OnSignOut { get; set; }
        public int SignOutCalls { get; private set; }

        public Task<IArchSession> SignInAsync(string email, string password, string? label, CancellationToken ct = default)
            => OnSignIn is null
                ? throw new ArchApiException(ArchApiFailureKind.Unauthorized, "bad creds")
                : Task.FromResult(OnSignIn());

        public Task SignOutAsync(IArchSession session, CancellationToken ct = default)
        {
            SignOutCalls++;
            // `OnSignOut` lets a test force a failure here, verifying the
            // manager still clears local state even if the revoke call throws.
            OnSignOut?.Invoke();
            return Task.CompletedTask;
        }

        public Task<SessionResponseDto> GetSessionAsync(IArchSession session, CancellationToken ct = default)
        {
            OnGetSession?.Invoke().GetAwaiter().GetResult();
            var id = new IdentityDto("u1", "T", "t@o.com", "ENGINEER", new OrganizationDto("org1", "ORGA", "Org A"));
            return Task.FromResult(new SessionResponseDto("arch-plm.desktop-auth.v1", id,
                new SessionTimingDto(DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddHours(12), DateTimeOffset.UtcNow),
                new ServerDto("Arch PLM", DateTimeOffset.UtcNow)));
        }

        public Task<ResolvedCadDocument> ResolveCadDocumentAsync(IArchSession s, CadDocumentLookup lu, CancellationToken ct = default) => throw ArchApiException.NotImplemented("Resolve");
        public Task<MaterializationReport> GetLatestAsync(IArchSession s, GetLatestRequest r, CancellationToken ct = default) => throw ArchApiException.NotImplemented("Get Latest");
        /// <summary>P6 M4.1a: every Copy Design request that actually reached
        ///  an api is logged as "&lt;origin the api was created for&gt; | &lt;origin of the session it was addressed with&gt; | op".</summary>
        public Action<string>? RequestLog { get; set; }
        public Func<Task<Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignReservationResponse>>? OnApplyCopyDesign { get; set; }
        public Func<Task<Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignMaterializationResult>>? OnMaterialize { get; set; }
        public Func<Task<Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignOperationStatusResult>>? OnGetCopyDesignOperationStatusAsync { get; set; }

        private void LogRequest(IArchSession s, string op) => RequestLog?.Invoke($"{Server.OriginString} | {s.Server.OriginString} | {op}");

        public Task<Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignReservationResponse> ApplyCopyDesignAsync(
            IArchSession s, Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignApplyRequest request, CancellationToken ct = default)
        {
            LogRequest(s, "reserve");
            return OnApplyCopyDesign?.Invoke() ?? throw ArchApiException.NotImplemented("Copy Design apply");
        }

        public Task<Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignMaterializationResult> MaterializeFirstFileVersionAsync(
            IArchSession s, Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignMaterializeRequest request, CancellationToken ct = default)
        {
            LogRequest(s, "materialize");
            return OnMaterialize?.Invoke() ?? throw ArchApiException.NotImplemented("Copy Design materialization");
        }

        public Task<PlmDocumentStatusDto> GetDocumentStatusAsync(IArchSession s, string id, CancellationToken ct = default) => throw ArchApiException.NotImplemented("Status");
        public Task<Arch.CadConnect.Api.Workspace.CheckoutOperationResult> CheckoutAsync(IArchSession s, ManagedFileRef f, CancellationToken ct = default) => throw ArchApiException.NotImplemented("Checkout");
        public Task<Arch.CadConnect.Api.Workspace.CheckInOperationResult> CheckInAsync(IArchSession s, ManagedFileRef f, CancellationToken ct = default) => throw ArchApiException.NotImplemented("Check In");
        public Task<Arch.CadConnect.Api.Workspace.UndoOperationResult> UndoCheckoutAsync(IArchSession s, ManagedFileRef f, string? reason, CancellationToken ct = default) => throw ArchApiException.NotImplemented("Undo Checkout");
        public Task<ServerCheckoutStatus> GetCheckoutStatusAsync(IArchSession s, string cadDocumentId, CancellationToken ct = default) => throw ArchApiException.NotImplemented("Checkout Status");
        public IReadOnlyCollection<string>? LastLatestVersionIds { get; private set; }
        public Func<LatestVersionLookup>? OnGetLatestVersions { get; set; }
        public Task<LatestVersionLookup> GetLatestVersionsAsync(IArchSession s, IReadOnlyCollection<string> ids, CancellationToken ct = default)
        {
            LastLatestVersionIds = ids;
            return Task.FromResult(OnGetLatestVersions?.Invoke() ?? LatestVersionLookup.WholeFailure(LatestVersionOutcome.LookupUnavailable));
        }
        public IReadOnlyCollection<string>? LastDrawingAssociationIds { get; private set; }
        public WorkspaceManifest? LastDrawingAssociationManifest { get; private set; }
        public Func<IReadOnlyDictionary<string, Arch.CadConnect.Core.CopyDesign.DrawingAssociationResult>>? OnGetDrawingAssociations { get; set; }
        public Task<IReadOnlyDictionary<string, Arch.CadConnect.Core.CopyDesign.DrawingAssociationResult>> GetDrawingAssociationsAsync(
            IArchSession s, IReadOnlyCollection<string> modelCadDocumentIds, WorkspaceManifest? manifest, CancellationToken ct = default)
        {
            LastDrawingAssociationIds = modelCadDocumentIds;
            LastDrawingAssociationManifest = manifest;
            return Task.FromResult(OnGetDrawingAssociations?.Invoke()
                ?? modelCadDocumentIds.ToDictionary(id => id, _ => Arch.CadConnect.Core.CopyDesign.DrawingAssociationResult.NotAvailable));
        }
        public Task<WhereUsedDto> GetWhereUsedAsync(IArchSession s, string id, CancellationToken ct = default) => throw ArchApiException.NotImplemented("Where Used");
        public Task<ReleaseInfoDto> GetReleaseInfoAsync(IArchSession s, string r, CancellationToken ct = default) => throw ArchApiException.NotImplemented("Release information");

        public string? LastOperationStatusId { get; private set; }
        public Func<Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignOperationStatusResult>? OnGetCopyDesignOperationStatus { get; set; }
        public Task<Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignOperationStatusResult> GetCopyDesignOperationStatusAsync(
            IArchSession s, Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignOperationStatusExpectation expectation, CancellationToken ct = default)
        {
            LastOperationStatusId = expectation.OperationId;
            LogRequest(s, "status");
            if (OnGetCopyDesignOperationStatusAsync is not null)
            {
                return OnGetCopyDesignOperationStatusAsync();
            }
            return Task.FromResult(OnGetCopyDesignOperationStatus?.Invoke()
                ?? Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignOperationStatusResult.Failure(
                    Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignOperationStatusOutcome.NotFound));
        }

        public string? LastDurableOperationStatusId { get; private set; }
        public Func<Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignDurableResumeStatusResult>? OnGetDurableCopyDesignOperationStatus { get; set; }
        public Task<Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignDurableResumeStatusResult> GetDurableCopyDesignOperationStatusAsync(
            IArchSession s, string operationId, CancellationToken ct = default)
        {
            LastDurableOperationStatusId = operationId;
            return Task.FromResult(OnGetDurableCopyDesignOperationStatus?.Invoke()
                ?? new Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignDurableResumeStatusResult(
                    Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignDurableResumeStatusOutcome.NotFound));
        }

        public string? LastVerificationSupportOperationId { get; private set; }
        public Func<Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignVerificationSupportResult>? OnGetCopyDesignVerificationSupport { get; set; }
        public Task<Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignVerificationSupportResult> GetCopyDesignVerificationSupportAsync(
            IArchSession s, string operationId, CancellationToken ct = default)
        {
            LastVerificationSupportOperationId = operationId;
            return Task.FromResult(OnGetCopyDesignVerificationSupport?.Invoke()
                ?? new Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignVerificationSupportResult(
                    Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignVerificationSupportOutcome.NotFound));
        }
    }

    private static IArchSession Session(DateTimeOffset? expires = null) => new DesktopSession(
        ArchServerUri.Parse("https://plm.example.com"),
        new ArchIdentity("u1", "T", "t@o.com", "ENGINEER", "org1", "ORGA", "Org A"),
        "arch_dt_abc123def456",
        expires ?? DateTimeOffset.UtcNow.AddHours(12),
        DateTimeOffset.UtcNow);

    [Fact]
    public async Task SignIn_success_persists_the_session_and_moves_to_Connected()
    {
        var store = new InMemorySessionStore();
        FakeApi api = null!;
        var mgr = new ArchConnectionManager(server => api = new FakeApi(server) { OnSignIn = () => Session() }, store);

        var states = new List<ConnectionState>();
        mgr.StateChanged += c => states.Add(c.Current);

        await mgr.SignInAsync("https://plm.example.com", "t@o.com", "pw");

        Assert.Equal(ConnectionState.Connected, mgr.State);
        Assert.NotNull(mgr.CurrentSession);
        Assert.NotNull(store.TryLoad());
        Assert.Equal(new[] { ConnectionState.Connecting, ConnectionState.Connected }, states);
    }

    [Fact]
    public async Task SignIn_bad_credentials_moves_to_Unauthorized_and_stores_nothing()
    {
        var store = new InMemorySessionStore();
        var mgr = new ArchConnectionManager(server => new FakeApi(server) { OnSignIn = null }, store);

        var ex = await Assert.ThrowsAsync<ArchApiException>(
            () => mgr.SignInAsync("https://plm.example.com", "t@o.com", "wrong"));

        Assert.Equal(ArchApiFailureKind.Unauthorized, ex.Kind);
        Assert.Equal(ConnectionState.Unauthorized, mgr.State);
        Assert.Null(store.TryLoad());
        Assert.Null(mgr.CurrentSession);
    }

    [Theory]
    [InlineData("http://plm.example.com")]
    [InlineData("http://192.168.1.50:3000")]
    public async Task SignIn_rejects_an_insecure_server_address_before_any_request(string address)
    {
        var store = new InMemorySessionStore();
        var mgr = new ArchConnectionManager(server => new FakeApi(server), store);
        await Assert.ThrowsAsync<ArchServerUriException>(() => mgr.SignInAsync(address, "t@o.com", "pw"));
        Assert.Equal(ConnectionState.SignedOut, mgr.State);
        Assert.Null(store.TryLoad());
    }

    // ---- timeout / state handling ------------------------------------

    [Fact]
    public async Task SignIn_timeout_moves_to_ServerUnavailable_and_persists_nothing()
    {
        var store = new InMemorySessionStore();
        var mgr = new ArchConnectionManager(
            server => new FakeApi(server)
            {
                OnSignIn = () => throw new ArchApiException(ArchApiFailureKind.Timeout, "no response in time"),
            },
            store);

        var ex = await Assert.ThrowsAsync<ArchApiException>(
            () => mgr.SignInAsync("https://plm.example.com", "t@o.com", "pw"));

        Assert.Equal(ArchApiFailureKind.Timeout, ex.Kind);
        Assert.Equal(ConnectionState.ServerUnavailable, mgr.State); // NOT stuck in Connecting
        Assert.Null(store.TryLoad());
        Assert.Null(mgr.CurrentSession);
    }

    [Fact]
    public async Task SignIn_unexpected_exception_still_leaves_Connecting_state_and_rethrows()
    {
        var mgr = new ArchConnectionManager(
            server => new FakeApi(server) { OnSignIn = () => throw new InvalidOperationException("boom") },
            new InMemorySessionStore());

        // Not swallowed - the original exception propagates...
        await Assert.ThrowsAsync<InvalidOperationException>(
            () => mgr.SignInAsync("https://plm.example.com", "t@o.com", "pw"));
        // ...but the machine still leaves Connecting (never stuck).
        Assert.NotEqual(ConnectionState.Connecting, mgr.State);
        Assert.Equal(ConnectionState.ServerUnavailable, mgr.State);
    }

    [Fact]
    public async Task Status_refresh_timeout_keeps_the_session_and_reports_ServerUnavailable()
    {
        var store = new InMemorySessionStore();
        var api = new FakeApi(ArchServerUri.Parse("https://plm.example.com")) { OnSignIn = () => Session() };
        var mgr = new ArchConnectionManager(_ => api, store);
        await mgr.SignInAsync("https://plm.example.com", "t@o.com", "pw");
        Assert.Equal(ConnectionState.Connected, mgr.State);

        api.OnGetSession = () => throw new ArchApiException(ArchApiFailureKind.Timeout, "no response in time");
        await mgr.RefreshServerStatusAsync();

        Assert.Equal(ConnectionState.ServerUnavailable, mgr.State); // not falsely Connected
        Assert.NotNull(store.TryLoad());
        Assert.NotNull(mgr.CurrentSession);
    }

    [Fact]
    public async Task Restore_timeout_keeps_the_local_session_for_retry()
    {
        var store = new InMemorySessionStore();
        store.Save(((DesktopSession)Session()).ToPersisted());
        var mgr = new ArchConnectionManager(
            s => new FakeApi(s) { OnGetSession = () => throw new ArchApiException(ArchApiFailureKind.Timeout, "slow") },
            store);

        Assert.True(await mgr.TryRestoreAsync());
        Assert.Equal(ConnectionState.ServerUnavailable, mgr.State);
        Assert.NotNull(store.TryLoad());
        Assert.NotNull(mgr.CurrentSession);
    }

    [Fact]
    public async Task SignOut_clears_local_state_even_if_the_revoke_call_times_out_or_throws()
    {
        var store = new InMemorySessionStore();
        var api = new FakeApi(ArchServerUri.Parse("https://plm.example.com")) { OnSignIn = () => Session() };
        var mgr = new ArchConnectionManager(_ => api, store);
        await mgr.SignInAsync("https://plm.example.com", "t@o.com", "pw");

        api.OnSignOut = () => throw new ArchApiException(ArchApiFailureKind.Timeout, "revoke timed out");
        await mgr.SignOutAsync(); // must not throw

        Assert.Equal(ConnectionState.SignedOut, mgr.State);
        Assert.Null(store.TryLoad());
        Assert.Null(mgr.CurrentSession);
    }

    [Fact]
    public async Task SignOut_clears_local_state_even_if_the_revoke_call_is_cancelled()
    {
        var store = new InMemorySessionStore();
        var api = new FakeApi(ArchServerUri.Parse("https://plm.example.com")) { OnSignIn = () => Session() };
        var mgr = new ArchConnectionManager(_ => api, store);
        await mgr.SignInAsync("https://plm.example.com", "t@o.com", "pw");

        api.OnSignOut = () => throw new OperationCanceledException();
        await mgr.SignOutAsync();

        Assert.Equal(ConnectionState.SignedOut, mgr.State);
        Assert.Null(store.TryLoad());
    }

    [Fact]
    public async Task SignOut_revokes_server_side_and_clears_local_state()
    {
        var store = new InMemorySessionStore();
        FakeApi api = null!;
        var mgr = new ArchConnectionManager(server => api = new FakeApi(server) { OnSignIn = () => Session() }, store);
        await mgr.SignInAsync("https://plm.example.com", "t@o.com", "pw");

        await mgr.SignOutAsync();

        Assert.Equal(1, api.SignOutCalls);
        Assert.Equal(ConnectionState.SignedOut, mgr.State);
        Assert.Null(store.TryLoad());
        Assert.Null(mgr.CurrentSession);
    }

    [Fact]
    public async Task TryRestore_with_no_saved_session_returns_false()
    {
        var mgr = new ArchConnectionManager(s => new FakeApi(s), new InMemorySessionStore());
        Assert.False(await mgr.TryRestoreAsync());
        Assert.Equal(ConnectionState.SignedOut, mgr.State);
    }

    [Fact]
    public async Task TryRestore_discards_a_locally_expired_session()
    {
        var store = new InMemorySessionStore();
        store.Save(((DesktopSession)Session(DateTimeOffset.UtcNow.AddMinutes(-5))).ToPersisted());
        var mgr = new ArchConnectionManager(s => new FakeApi(s), store);

        Assert.False(await mgr.TryRestoreAsync());
        Assert.Null(store.TryLoad());
    }

    [Fact]
    public async Task TryRestore_validates_a_live_session_and_connects()
    {
        var store = new InMemorySessionStore();
        store.Save(((DesktopSession)Session()).ToPersisted());
        var mgr = new ArchConnectionManager(s => new FakeApi(s), store);

        Assert.True(await mgr.TryRestoreAsync());
        Assert.Equal(ConnectionState.Connected, mgr.State);
    }

    [Fact]
    public async Task TryRestore_keeps_the_session_when_the_server_is_only_temporarily_down()
    {
        var store = new InMemorySessionStore();
        store.Save(((DesktopSession)Session()).ToPersisted());
        var mgr = new ArchConnectionManager(
            s => new FakeApi(s) { OnGetSession = () => throw new ArchApiException(ArchApiFailureKind.Network, "down") },
            store);

        Assert.True(await mgr.TryRestoreAsync());
        Assert.Equal(ConnectionState.ServerUnavailable, mgr.State);
        Assert.NotNull(store.TryLoad());
        Assert.NotNull(mgr.CurrentSession);
    }

    [Fact]
    public async Task TryRestore_discards_the_session_when_the_server_rejects_it()
    {
        var store = new InMemorySessionStore();
        store.Save(((DesktopSession)Session()).ToPersisted());
        var mgr = new ArchConnectionManager(
            s => new FakeApi(s) { OnGetSession = () => throw new ArchApiException(ArchApiFailureKind.Unauthorized, "revoked") },
            store);

        Assert.False(await mgr.TryRestoreAsync());
        Assert.Equal(ConnectionState.Unauthorized, mgr.State);
        Assert.Null(store.TryLoad());
    }

    // ---- P5B-B: authoritative latest-version lookup -----------------

    [Fact]
    public async Task GetLatestVersions_without_a_session_fails_closed_to_AuthenticationFailed()
    {
        var mgr = new ArchConnectionManager(s => new FakeApi(s), new InMemorySessionStore());

        var lookup = await mgr.GetLatestVersionsAsync(new[] { "cad_a" });

        Assert.Equal(LatestVersionOutcome.AuthenticationFailed, lookup.Get("cad_a").Outcome);
    }

    [Fact]
    public async Task GetLatestVersions_with_a_session_delegates_to_the_api()
    {
        var store = new InMemorySessionStore();
        FakeApi api = null!;
        var mgr = new ArchConnectionManager(server => api = new FakeApi(server)
        {
            OnSignIn = () => Session(),
            OnGetLatestVersions = () => LatestVersionLookup.FromResults(new[] { LatestVersionResult.Found("cad_a", "fv_a2") }),
        }, store);
        await mgr.SignInAsync("https://plm.example.com", "t@o.com", "pw");

        var lookup = await mgr.GetLatestVersionsAsync(new[] { "cad_a" });

        Assert.Equal(new[] { "cad_a" }, api.LastLatestVersionIds);
        Assert.Equal(LatestVersionOutcome.Found, lookup.Get("cad_a").Outcome);
        Assert.Equal("fv_a2", lookup.Get("cad_a").Version!.LatestFileVersionId);
    }

    // ---- P6D drawing association authority -----------------------------

    [Fact]
    public async Task GetDrawingAssociations_without_a_session_fails_closed_to_NotAvailable_never_calls_the_api()
    {
        var mgr = new ArchConnectionManager(s => new FakeApi(s), new InMemorySessionStore());

        var result = await mgr.GetDrawingAssociationsAsync(new[] { "cad_root_iam" }, manifest: null);

        Assert.Equal(
            Arch.CadConnect.Core.CopyDesign.DrawingAssociationOutcome.NotAvailable,
            result["cad_root_iam"].Outcome);
    }

    [Fact]
    public async Task GetDrawingAssociations_with_a_session_delegates_the_EXACT_current_stable_ids_and_manifest_to_the_api()
    {
        var store = new InMemorySessionStore();
        FakeApi api = null!;
        var mgr = new ArchConnectionManager(server => api = new FakeApi(server)
        {
            OnSignIn = () => Session(),
            OnGetDrawingAssociations = () => new Dictionary<string, Arch.CadConnect.Core.CopyDesign.DrawingAssociationResult>
            {
                ["cad_root_iam"] = new(Arch.CadConnect.Core.CopyDesign.DrawingAssociationOutcome.Found,
                    new[]
                    {
                        new Arch.CadConnect.Core.CopyDesign.AssociatedDrawing(
                            "cad_root_idw", "fv_idw_1", null, Arch.CadConnect.Core.CadDocumentType.Idw, true, "test"),
                    }),
            },
        }, store);
        await mgr.SignInAsync("https://plm.example.com", "t@o.com", "pw");

        // P6D: the request must carry the CURRENT stable model id, not a
        // stale/pre-cleanup fixture id and not a documentNumber/filename.
        var requestedIds = new[] { "cad_root_iam" };
        var result = await mgr.GetDrawingAssociationsAsync(requestedIds, manifest: null);

        Assert.Equal(requestedIds, api.LastDrawingAssociationIds);
        Assert.Equal(
            Arch.CadConnect.Core.CopyDesign.DrawingAssociationOutcome.Found,
            result["cad_root_iam"].Outcome);
        Assert.Equal("cad_root_idw", result["cad_root_iam"].Drawings.Single().CadDocumentId);
    }

    // ---- P6E-C verification-support forwarding --------------------------

    [Fact]
    public async Task GetCopyDesignVerificationSupport_without_a_session_fails_closed_to_AuthenticationFailed_never_calls_the_api()
    {
        FakeApi? api = null;
        var mgr = new ArchConnectionManager(s => api = new FakeApi(s), new InMemorySessionStore());

        var result = await mgr.GetCopyDesignVerificationSupportAsync("op-1");

        Assert.Equal(
            Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignVerificationSupportOutcome.AuthenticationFailed,
            result.Outcome);
        Assert.Null(api);
    }

    [Fact]
    public async Task GetCopyDesignVerificationSupport_with_a_session_delegates_the_EXACT_operationId_to_the_api()
    {
        var store = new InMemorySessionStore();
        FakeApi api = null!;
        var mgr = new ArchConnectionManager(server => api = new FakeApi(server)
        {
            OnSignIn = () => Session(),
            OnGetCopyDesignVerificationSupport = () => new Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignVerificationSupportResult(
                Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignVerificationSupportOutcome.Found,
                "op-42", "key-1",
                Array.Empty<Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignDurableResumeEntry>(),
                Array.Empty<Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignSourceIntegrityEvidence>(),
                Array.Empty<Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignComponentEdge>()),
        }, store);
        await mgr.SignInAsync("https://plm.example.com", "t@o.com", "pw");

        var result = await mgr.GetCopyDesignVerificationSupportAsync("op-42");

        Assert.Equal("op-42", api.LastVerificationSupportOperationId);
        Assert.True(result.Success);
        Assert.Equal("op-42", result.OperationId);
    }

    [Fact]
    public async Task GetCopyDesignVerificationSupport_an_authoritative_auth_rejection_invalidates_the_session()
    {
        var store = new InMemorySessionStore();
        FakeApi api = null!;
        var mgr = new ArchConnectionManager(server => api = new FakeApi(server)
        {
            OnSignIn = () => Session(),
            OnGetCopyDesignVerificationSupport = () => new Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignVerificationSupportResult(
                Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignVerificationSupportOutcome.AuthenticationFailed),
        }, store);
        await mgr.SignInAsync("https://plm.example.com", "t@o.com", "pw");

        var result = await mgr.GetCopyDesignVerificationSupportAsync("op-1");

        Assert.Equal(
            Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignVerificationSupportOutcome.AuthenticationFailed,
            result.Outcome);
        Assert.Null(store.TryLoad());
    }

    private async Task<(ArchConnectionManager Mgr, InMemorySessionStore Store)> ConnectedManager(
        Func<LatestVersionLookup> onGetLatestVersions)
    {
        var store = new InMemorySessionStore();
        var mgr = new ArchConnectionManager(server => new FakeApi(server)
        {
            OnSignIn = () => Session(),
            OnGetLatestVersions = onGetLatestVersions,
        }, store);
        await mgr.SignInAsync("https://plm.example.com", "t@o.com", "pw");
        Assert.Equal(ConnectionState.Connected, mgr.State);
        Assert.NotNull(store.TryLoad());
        return (mgr, store);
    }

    [Fact]
    public async Task GetLatestVersions_on_an_authoritative_401_clears_the_session_and_moves_to_Unauthorized()
    {
        var (mgr, store) = await ConnectedManager(
            () => LatestVersionLookup.WholeFailure(LatestVersionOutcome.AuthenticationFailed));

        var lookup = await mgr.GetLatestVersionsAsync(new[] { "cad_a" });

        // session invalidated exactly like every other authenticated operation
        Assert.Equal(ConnectionState.Unauthorized, mgr.State);
        Assert.Null(mgr.CurrentSession);
        Assert.Null(store.TryLoad());
        // ...but the version result still fails closed rather than throwing
        Assert.Equal(LatestVersionOutcome.AuthenticationFailed, lookup.Get("cad_a").Outcome);
    }

    [Fact]
    public async Task GetLatestVersions_on_a_thrown_auth_failure_also_invalidates_and_fails_closed()
    {
        var store = new InMemorySessionStore();
        var mgr = new ArchConnectionManager(server => new FakeApi(server)
        {
            OnSignIn = () => Session(),
            OnGetLatestVersions = () => throw new ArchApiException(ArchApiFailureKind.Unauthorized, "rejected"),
        }, store);
        await mgr.SignInAsync("https://plm.example.com", "t@o.com", "pw");

        var lookup = await mgr.GetLatestVersionsAsync(new[] { "cad_a" });

        Assert.Equal(ConnectionState.Unauthorized, mgr.State);
        Assert.Null(store.TryLoad());
        Assert.Equal(LatestVersionOutcome.AuthenticationFailed, lookup.Get("cad_a").Outcome);
    }

    [Fact]
    public async Task GetLatestVersions_on_a_500_keeps_the_session_connected()
    {
        var (mgr, store) = await ConnectedManager(
            () => LatestVersionLookup.WholeFailure(LatestVersionOutcome.ServerUnavailable));

        var lookup = await mgr.GetLatestVersionsAsync(new[] { "cad_a" });

        Assert.Equal(ConnectionState.Connected, mgr.State);
        Assert.NotNull(mgr.CurrentSession);
        Assert.NotNull(store.TryLoad());
        Assert.Equal(LatestVersionOutcome.ServerUnavailable, lookup.Get("cad_a").Outcome);
    }

    [Fact]
    public async Task GetLatestVersions_on_a_404_lookup_unavailable_keeps_the_session_connected()
    {
        var (mgr, store) = await ConnectedManager(
            () => LatestVersionLookup.WholeFailure(LatestVersionOutcome.LookupUnavailable));

        await mgr.GetLatestVersionsAsync(new[] { "cad_a" });

        Assert.Equal(ConnectionState.Connected, mgr.State);
        Assert.NotNull(store.TryLoad());
    }

    [Fact]
    public async Task GetLatestVersions_on_Found_keeps_the_session_connected()
    {
        var (mgr, store) = await ConnectedManager(
            () => LatestVersionLookup.FromResults(new[] { LatestVersionResult.Found("cad_a", "fv_a") }));

        await mgr.GetLatestVersionsAsync(new[] { "cad_a" });

        Assert.Equal(ConnectionState.Connected, mgr.State);
        Assert.NotNull(mgr.CurrentSession);
        Assert.NotNull(store.TryLoad());
    }

    // ---- Round 3: auth rejection while in ServerUnavailable --------

    /// <summary>Connected, persisted, then a non-auth server failure drops the
    ///  connection to ServerUnavailable while KEEPING the (locally valid)
    ///  session and persisted token. Uses ONE shared FakeApi so per-call
    ///  behaviour can be reconfigured between operations.</summary>
    private async Task<(ArchConnectionManager Mgr, InMemorySessionStore Store, FakeApi Api)> ServerUnavailableManagerWithRetainedSession(
        Func<LatestVersionLookup> onGetLatestVersions)
    {
        var store = new InMemorySessionStore();
        var api = new FakeApi(ArchServerUri.Parse("https://plm.example.com"))
        {
            OnSignIn = () => Session(),
            OnGetLatestVersions = onGetLatestVersions,
        };
        var mgr = new ArchConnectionManager(_ => api, store);
        await mgr.SignInAsync("https://plm.example.com", "t@o.com", "pw");

        api.OnGetSession = () => throw new ArchApiException(ArchApiFailureKind.Server, "server down");
        await mgr.RefreshServerStatusAsync();

        Assert.Equal(ConnectionState.ServerUnavailable, mgr.State);
        Assert.NotNull(mgr.CurrentSession);   // session retained
        Assert.NotNull(store.TryLoad());      // persisted token retained
        return (mgr, store, api);
    }

    [Fact]
    public async Task ServerUnavailable_plus_retained_session_plus_auth_rejection_goes_Unauthorized_and_clears_the_session()
    {
        var (mgr, store, _) = await ServerUnavailableManagerWithRetainedSession(
            () => LatestVersionLookup.WholeFailure(LatestVersionOutcome.AuthenticationFailed));

        var lookup = await mgr.GetLatestVersionsAsync(new[] { "cad_a" });

        Assert.Equal(ConnectionState.Unauthorized, mgr.State);
        Assert.Null(mgr.CurrentSession);
        Assert.Null(store.TryLoad());
        Assert.Equal(LatestVersionOutcome.AuthenticationFailed, lookup.Get("cad_a").Outcome);
    }

    [Fact]
    public async Task ServerUnavailable_plus_ordinary_server_failure_stays_ServerUnavailable_and_keeps_the_session()
    {
        var (mgr, store, _) = await ServerUnavailableManagerWithRetainedSession(
            () => LatestVersionLookup.WholeFailure(LatestVersionOutcome.ServerUnavailable));

        var lookup = await mgr.GetLatestVersionsAsync(new[] { "cad_a" });

        Assert.Equal(ConnectionState.ServerUnavailable, mgr.State);   // NOT incorrectly Unauthorized
        Assert.NotNull(mgr.CurrentSession);                            // legitimate session kept
        Assert.NotNull(store.TryLoad());
        Assert.Equal(LatestVersionOutcome.ServerUnavailable, lookup.Get("cad_a").Outcome);
    }

    [Fact]
    public async Task Auth_failure_from_ServerUnavailable_via_ApplyFailure_also_lands_in_Unauthorized()
    {
        // The shared InvalidateRejectedSession path (ApplyFailure) is used by
        // RefreshServerStatus / GetLatest / Checkout / Check-In / Undo - prove
        // it reaches Unauthorized from ServerUnavailable there too.
        var store = new InMemorySessionStore();
        var api = new FakeApi(ArchServerUri.Parse("https://plm.example.com")) { OnSignIn = () => Session() };
        var mgr = new ArchConnectionManager(_ => api, store);
        await mgr.SignInAsync("https://plm.example.com", "t@o.com", "pw");

        api.OnGetSession = () => throw new ArchApiException(ArchApiFailureKind.Server, "down");
        await mgr.RefreshServerStatusAsync();
        Assert.Equal(ConnectionState.ServerUnavailable, mgr.State);
        Assert.NotNull(mgr.CurrentSession);

        api.OnGetSession = () => throw new ArchApiException(ArchApiFailureKind.Unauthorized, "rejected");
        await mgr.RefreshServerStatusAsync();

        Assert.Equal(ConnectionState.Unauthorized, mgr.State);
        Assert.Null(mgr.CurrentSession);
        Assert.Null(store.TryLoad());
    }

    // ---- P6 M4.1 server-origin guard -----------------------------------
    //
    // The live M3 defect: signed in to the scratch server, a Checkout and a
    // drawing-association lookup for a PRODUCTION-workspace document were sent
    // to the scratch server. Every workspace-carrying call must now refuse -
    // as BadRequest (no sign-out, no retry) and BEFORE the api is invoked -
    // unless the workspace records exactly the connected origin. The fake api
    // throws NotImplemented for these calls, so NotImplemented proves the
    // request was let through and BadRequest proves it was stopped first.

    private const string ProductionOrigin = "http://localhost:3000";
    private const string ScratchOrigin = "http://localhost:3100";

    private static IArchSession SessionFor(string origin) => new DesktopSession(
        ArchServerUri.Parse(origin),
        new ArchIdentity("u1", "T", "t@o.com", "ENGINEER", "org1", "ORGA", "Org A"),
        "arch_dt_abc123def456",
        DateTimeOffset.UtcNow.AddHours(12),
        DateTimeOffset.UtcNow);

    private sealed class TempWorkspaces : IDisposable
    {
        public string Root { get; } = Path.Combine(Path.GetTempPath(), "arch-m41-api-" + Guid.NewGuid().ToString("N"));

        public string Create(string name, string? serverOrigin)
        {
            var root = Path.Combine(Root, name);
            Directory.CreateDirectory(root);
            if (serverOrigin is not null)
            {
                var path = Path.Combine(root, WorkspaceManifest.RelativeManifestPath);
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllText(path,
                    $$"""{"schema":"{{WorkspaceManifest.SchemaId}}","serverOrigin":"{{serverOrigin}}","entries":[]}""");
            }
            return root;
        }

        public void Dispose()
        {
            try { Directory.Delete(Root, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    private static async Task<(ArchConnectionManager Manager, InMemorySessionStore Store, Func<FakeApi?> Api)> SignedInTo(string origin)
    {
        var store = new InMemorySessionStore();
        FakeApi? api = null;
        var mgr = new ArchConnectionManager(server => api = new FakeApi(server) { OnSignIn = () => SessionFor(origin) }, store);
        await mgr.SignInAsync(origin, "t@o.com", "pw");
        return (mgr, store, () => api);
    }

    public static TheoryData<string> DocumentCommands => new() { "Checkout", "CheckIn", "UndoCheckout" };

    private static Task InvokeDocumentCommand(ArchConnectionManager mgr, string command, ManagedFileRef file) => command switch
    {
        "Checkout" => mgr.CheckoutAsync(file),
        "CheckIn" => mgr.CheckInAsync(file),
        "UndoCheckout" => mgr.UndoCheckoutAsync(file, reason: null),
        _ => throw new ArgumentOutOfRangeException(nameof(command)),
    };

    [Theory]
    [MemberData(nameof(DocumentCommands))]
    public async Task Document_command_on_a_production_workspace_while_signed_in_to_scratch_is_refused_before_the_api(string command)
    {
        using var ws = new TempWorkspaces();
        var production = ws.Create("prod", ProductionOrigin);
        var (mgr, store, _) = await SignedInTo(ScratchOrigin);

        var ex = await Assert.ThrowsAsync<ArchApiException>(() =>
            InvokeDocumentCommand(mgr, command, ManagedFileRef.Create(production, Path.Combine(production, "A.ipt"))));

        Assert.Equal(ArchApiFailureKind.BadRequest, ex.Kind);
        Assert.Contains("Nothing was sent to the server", ex.Message);
        // A refusal is not an auth failure: the session survives.
        Assert.Equal(ConnectionState.Connected, mgr.State);
        Assert.NotNull(store.TryLoad());
    }

    [Theory]
    [MemberData(nameof(DocumentCommands))]
    public async Task Document_command_on_a_scratch_workspace_while_signed_in_to_production_is_refused_before_the_api(string command)
    {
        using var ws = new TempWorkspaces();
        var scratch = ws.Create("scratch", ScratchOrigin);
        var (mgr, _, _) = await SignedInTo(ProductionOrigin);

        var ex = await Assert.ThrowsAsync<ArchApiException>(() =>
            InvokeDocumentCommand(mgr, command, ManagedFileRef.Create(scratch, Path.Combine(scratch, "A.ipt"))));

        Assert.Equal(ArchApiFailureKind.BadRequest, ex.Kind);
    }

    [Theory]
    [MemberData(nameof(DocumentCommands))]
    public async Task Document_command_on_a_workspace_of_the_connected_server_reaches_the_api(string command)
    {
        using var ws = new TempWorkspaces();
        var scratch = ws.Create("scratch", ScratchOrigin);
        var (mgr, _, _) = await SignedInTo(ScratchOrigin);

        var ex = await Assert.ThrowsAsync<ArchApiException>(() =>
            InvokeDocumentCommand(mgr, command, ManagedFileRef.Create(scratch, Path.Combine(scratch, "A.ipt"))));

        Assert.Equal(ArchApiFailureKind.NotImplemented, ex.Kind);  // the fake api was reached
    }

    [Theory]
    [MemberData(nameof(DocumentCommands))]
    public async Task Document_command_outside_a_workspace_or_with_a_corrupt_manifest_fails_closed(string command)
    {
        using var ws = new TempWorkspaces();
        var plain = ws.Create("plain", serverOrigin: null);
        var corrupt = ws.Create("corrupt", serverOrigin: null);
        var manifestPath = Path.Combine(corrupt, WorkspaceManifest.RelativeManifestPath);
        Directory.CreateDirectory(Path.GetDirectoryName(manifestPath)!);
        File.WriteAllText(manifestPath, "{ not json");
        var (mgr, _, _) = await SignedInTo(ScratchOrigin);

        foreach (var root in new[] { plain, corrupt })
        {
            var ex = await Assert.ThrowsAsync<ArchApiException>(() =>
                InvokeDocumentCommand(mgr, command, ManagedFileRef.Create(root, Path.Combine(root, "A.ipt"))));
            Assert.Equal(ArchApiFailureKind.BadRequest, ex.Kind);
        }
    }

    [Fact]
    public async Task GetLatest_into_a_workspace_of_another_server_is_refused_before_the_api()
    {
        using var ws = new TempWorkspaces();
        var production = ws.Create("prod", ProductionOrigin);
        var (mgr, store, _) = await SignedInTo(ScratchOrigin);

        var ex = await Assert.ThrowsAsync<ArchApiException>(() => mgr.GetLatestAsync(new GetLatestRequest
        {
            Root = CadDocumentLookup.ByNumber(documentNumber: "ARCH-TEST-001", documentType: "IPT"),
            WorkspaceRoot = production,
        }));

        Assert.Equal(ArchApiFailureKind.BadRequest, ex.Kind);
        Assert.NotNull(store.TryLoad());
    }

    [Fact]
    public async Task GetLatest_into_a_new_folder_or_a_same_server_workspace_reaches_the_api()
    {
        using var ws = new TempWorkspaces();
        var (mgr, _, _) = await SignedInTo(ScratchOrigin);

        foreach (var root in new[] { ws.Create("new", serverOrigin: null), ws.Create("same", ScratchOrigin) })
        {
            var ex = await Assert.ThrowsAsync<ArchApiException>(() => mgr.GetLatestAsync(new GetLatestRequest
            {
                Root = CadDocumentLookup.ByNumber(documentNumber: "M3-ROOT", documentType: "IAM"),
                WorkspaceRoot = root,
            }));
            Assert.Equal(ArchApiFailureKind.NotImplemented, ex.Kind);
        }
    }

    [Fact]
    public async Task GetDrawingAssociations_for_a_manifest_of_another_server_is_NotAvailable_and_never_calls_the_api()
    {
        using var ws = new TempWorkspaces();
        var production = ws.Create("prod", ProductionOrigin);
        var (mgr, _, api) = await SignedInTo(ScratchOrigin);

        var result = await mgr.GetDrawingAssociationsAsync(new[] { "cad_root_iam" }, WorkspaceManifest.LoadOrEmpty(production));

        Assert.Equal(Arch.CadConnect.Core.CopyDesign.DrawingAssociationOutcome.NotAvailable, result["cad_root_iam"].Outcome);
        Assert.Null(api()!.LastDrawingAssociationIds);
    }

    [Fact]
    public async Task GetDrawingAssociations_for_a_manifest_of_the_connected_server_reaches_the_api()
    {
        using var ws = new TempWorkspaces();
        var scratch = ws.Create("scratch", ScratchOrigin);
        var (mgr, _, api) = await SignedInTo(ScratchOrigin);

        await mgr.GetDrawingAssociationsAsync(new[] { "cad_root_iam" }, WorkspaceManifest.LoadOrEmpty(scratch));

        Assert.Equal(new[] { "cad_root_iam" }, api()!.LastDrawingAssociationIds);
    }
    // ---- P6 M4.1a session binding for Copy Design --------------------
    //
    // A Copy Design attempt is bound to the session it started with. Every
    // reservation / materialization / status request is addressed with THAT
    // session and is refused - nothing sent to any server - once it is no
    // longer the current session. A switch can never land between the check
    // and the dispatch: it waits for an in-flight bound request instead.
    // FakeApi.RequestLog records "<api origin> | <session origin> | op" for
    // every request that actually reached an api.

    private sealed class SwitchHarness
    {
        public System.Collections.Concurrent.ConcurrentQueue<string> Requests { get; } = new();
        public Func<Task<Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignReservationResponse>>? OnApply { get; set; }
        public Func<Task<Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignMaterializationResult>>? OnMaterialize { get; set; }
        public Func<Task<Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignOperationStatusResult>>? OnStatus { get; set; }
        public InMemorySessionStore Store { get; } = new();
        public ArchConnectionManager Manager { get; }

        public SwitchHarness()
        {
            Manager = new ArchConnectionManager(server => new FakeApi(server)
            {
                OnSignIn = () => SessionFor(server.OriginString),
                RequestLog = Requests.Enqueue,
                OnApplyCopyDesign = () => (OnApply ?? throw ArchApiException.NotImplemented("apply"))(),
                OnMaterialize = () => (OnMaterialize ?? throw ArchApiException.NotImplemented("materialize"))(),
                OnGetCopyDesignOperationStatusAsync = () => (OnStatus ?? (() => Task.FromResult(
                    Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignOperationStatusResult.Failure(
                        Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignOperationStatusOutcome.NotFound))))(),
            }, Store);
        }

        public Task SignInAsync(string origin) => Manager.SignInAsync(origin, "t@o.com", "pw");

        public async Task SwitchToAsync(string origin)
        {
            await Manager.SignOutAsync();
            await Manager.SignInAsync(origin, "t@o.com", "pw");
        }

        public string[] RequestsTo(string origin) =>
            Requests.Where(r => r.Split(" | ").Take(2).Any(part => part == origin)).ToArray();
    }

    private static Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignApplyRequest ApplyRequest() =>
        new("key-m41a", null, Array.Empty<Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignApplyMappedEntry>());

    private static Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignMaterializeRequest MaterializeRequest() =>
        new("op-m41a", "cad-new", "cad-src", Arch.CadConnect.Core.CadDocumentType.Ipt, @"C:\dst\a.ipt", "a.ipt", "sha", 10);

    private static Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignOperationStatusExpectation StatusExpectation() =>
        new("op-m41a", "key-m41a", Array.Empty<Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignOperationStatusExpectedEntry>());

    private static Task<Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignReservationResponse> Reserved() =>
        Task.FromResult(new Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignReservationResponse(
            "contract", "op-m41a", "now", Array.Empty<Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignReservationResponseEntry>()));

    private static Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignMaterializationResult Materialized() =>
        new("cad-new", Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignMaterializationOutcome.Materialized, "fv-1", 1, "sha", 10, "ok");

    private static async Task<T> Within<T>(Task<T> task) =>
        await task.WaitAsync(TimeSpan.FromSeconds(10));

    private static async Task Within(Task task) =>
        await task.WaitAsync(TimeSpan.FromSeconds(10));

    [Fact]
    public async Task Bound_session_switch_BEFORE_reservation_refuses_without_retry_or_sign_out_and_sends_nothing()
    {
        var h = new SwitchHarness { OnApply = Reserved };
        await h.SignInAsync(ScratchOrigin);
        var bound = h.Manager.CurrentSession!;

        await h.SwitchToAsync(ProductionOrigin);
        var ex = await Assert.ThrowsAsync<ArchApiException>(() => h.Manager.ApplyCopyDesignAsync(ApplyRequest(), bound));

        Assert.Equal(ArchApiFailureKind.Conflict, ex.Kind);
        Assert.False(ex.IsServerUnavailable);  // the controller's retry classifier: never retried
        Assert.False(ex.IsAuthFailure);        // never signs the NEW session out
        Assert.Equal(ArchConnectionManager.SessionChangedMessage, ex.Message);
        Assert.Empty(h.Requests);
        Assert.Equal(ConnectionState.Connected, h.Manager.State);
        Assert.Equal(ProductionOrigin, h.Manager.CurrentSession!.Server.OriginString);
        Assert.NotNull(h.Store.TryLoad());
    }

    [Fact]
    public async Task Bound_session_switch_AFTER_reservation_refuses_every_later_upload_and_status_request()
    {
        var h = new SwitchHarness { OnApply = Reserved, OnMaterialize = () => Task.FromResult(Materialized()) };
        await h.SignInAsync(ScratchOrigin);
        var bound = h.Manager.CurrentSession!;

        var reservation = await h.Manager.ApplyCopyDesignAsync(ApplyRequest(), bound);
        Assert.Equal("op-m41a", reservation.CopyDesignOperationId);

        await h.SwitchToAsync(ProductionOrigin);
        var upload = await h.Manager.MaterializeFirstFileVersionAsync(MaterializeRequest(), bound);
        var status = await h.Manager.GetCopyDesignOperationStatusAsync(StatusExpectation(), bound);

        Assert.Equal(Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignMaterializationOutcome.Failed, upload.Outcome);
        Assert.Equal(ArchConnectionManager.SessionChangedMessage, upload.Detail);
        Assert.Equal(Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignOperationStatusOutcome.AuthenticationFailed, status.Outcome);
        Assert.Equal(new[] { $"{ScratchOrigin} | {ScratchOrigin} | reserve" }, h.Requests);
        Assert.Empty(h.RequestsTo(ProductionOrigin));
        // The refusal never touched the new session.
        Assert.Equal(ConnectionState.Connected, h.Manager.State);
        Assert.Equal(ProductionOrigin, h.Manager.CurrentSession!.Server.OriginString);
    }

    [Fact]
    public async Task A_switch_DURING_an_upload_waits_for_it_and_every_later_upload_is_refused()
    {
        var uploadInFlight = new TaskCompletionSource<Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignMaterializationResult>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var h = new SwitchHarness { OnMaterialize = () => uploadInFlight.Task };
        await h.SignInAsync(ScratchOrigin);
        var bound = h.Manager.CurrentSession!;

        var upload = h.Manager.MaterializeFirstFileVersionAsync(MaterializeRequest(), bound);
        var switching = Task.Run(() => h.SwitchToAsync(ProductionOrigin));
        await Task.Delay(300);

        // The switch cannot take effect while the bound request is in flight.
        Assert.False(switching.IsCompleted);
        Assert.Same(bound, h.Manager.CurrentSession);

        uploadInFlight.SetResult(Materialized());
        Assert.Equal(Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignMaterializationOutcome.Materialized, (await Within(upload)).Outcome);
        await Within(switching);
        Assert.Equal(ProductionOrigin, h.Manager.CurrentSession!.Server.OriginString);

        var next = await h.Manager.MaterializeFirstFileVersionAsync(MaterializeRequest(), bound);
        Assert.Equal(Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignMaterializationOutcome.Failed, next.Outcome);
        Assert.Equal(new[] { $"{ScratchOrigin} | {ScratchOrigin} | materialize" }, h.Requests);
        Assert.Empty(h.RequestsTo(ProductionOrigin));
    }

    [Fact]
    public async Task A_switch_DURING_a_status_check_waits_for_it_and_every_later_status_check_is_refused()
    {
        var statusInFlight = new TaskCompletionSource<Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignOperationStatusResult>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var h = new SwitchHarness { OnStatus = () => statusInFlight.Task };
        await h.SignInAsync(ScratchOrigin);
        var bound = h.Manager.CurrentSession!;

        var status = h.Manager.GetCopyDesignOperationStatusAsync(StatusExpectation(), bound);
        var switching = Task.Run(() => h.SwitchToAsync(ProductionOrigin));
        await Task.Delay(300);

        Assert.False(switching.IsCompleted);
        Assert.Same(bound, h.Manager.CurrentSession);

        statusInFlight.SetResult(Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignOperationStatusResult.Failure(
            Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignOperationStatusOutcome.NotFound));
        Assert.Equal(Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignOperationStatusOutcome.NotFound, (await Within(status)).Outcome);
        await Within(switching);

        var next = await h.Manager.GetCopyDesignOperationStatusAsync(StatusExpectation(), bound);
        Assert.Equal(Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignOperationStatusOutcome.AuthenticationFailed, next.Outcome);
        Assert.Equal(new[] { $"{ScratchOrigin} | {ScratchOrigin} | status" }, h.Requests);
        Assert.Equal(ConnectionState.Connected, h.Manager.State);  // the refusal did not reject the new session
    }

    [Fact]
    public async Task Concurrent_bound_requests_racing_a_switch_never_reach_the_other_server()
    {
        // Check-then-dispatch must be atomic with respect to a switch: under
        // any interleaving, every request that is dispatched is addressed
        // with the bound session to the bound server, and once the switch has
        // completed nothing more is dispatched at all.
        for (var round = 0; round < 25; round++)
        {
            var h = new SwitchHarness
            {
                OnMaterialize = async () => { await Task.Yield(); return Materialized(); },
                OnApply = async () => { await Task.Yield(); return await Reserved(); },
            };
            await h.SignInAsync(ScratchOrigin);
            var bound = h.Manager.CurrentSession!;

            var calls = Enumerable.Range(0, 40).Select(i => Task.Run(async () =>
            {
                try
                {
                    if (i % 2 == 0)
                    {
                        await h.Manager.MaterializeFirstFileVersionAsync(MaterializeRequest(), bound);
                    }
                    else
                    {
                        await h.Manager.ApplyCopyDesignAsync(ApplyRequest(), bound);
                    }
                }
                catch (ArchApiException ex) when (ex.Kind == ArchApiFailureKind.Conflict)
                {
                    // refused after the switch - expected for some
                }
            })).ToList();
            var switching = Task.Run(() => h.SwitchToAsync(ProductionOrigin));
            await Within(Task.WhenAll(calls.Append(switching)));

            Assert.All(h.Requests, r => Assert.StartsWith($"{ScratchOrigin} | {ScratchOrigin} |", r));
            Assert.Empty(h.RequestsTo(ProductionOrigin));

            var sentBefore = h.Requests.Count;
            await h.Manager.MaterializeFirstFileVersionAsync(MaterializeRequest(), bound);
            await Assert.ThrowsAsync<ArchApiException>(() => h.Manager.ApplyCopyDesignAsync(ApplyRequest(), bound));
            Assert.Equal(sentBefore, h.Requests.Count);
        }
    }

    [Fact]
    public async Task Signing_in_again_to_the_SAME_server_still_refuses_the_old_binding()
    {
        var h = new SwitchHarness { OnApply = Reserved };
        await h.SignInAsync(ScratchOrigin);
        var bound = h.Manager.CurrentSession!;

        await h.SwitchToAsync(ScratchOrigin);  // a NEW session (possibly another user) on the same server

        await Assert.ThrowsAsync<ArchApiException>(() => h.Manager.ApplyCopyDesignAsync(ApplyRequest(), bound));
        Assert.Empty(h.Requests);
    }

    [Fact]
    public async Task An_auth_rejection_of_the_bound_session_signs_it_out_without_deadlock_and_later_requests_are_refused()
    {
        var h = new SwitchHarness
        {
            OnApply = () => throw new ArchApiException(ArchApiFailureKind.Unauthorized, "rejected"),
            OnMaterialize = () => Task.FromResult(Materialized()),
        };
        await h.SignInAsync(ScratchOrigin);
        var bound = h.Manager.CurrentSession!;

        var ex = await Assert.ThrowsAsync<ArchApiException>(() => Within(h.Manager.ApplyCopyDesignAsync(ApplyRequest(), bound)));

        Assert.True(ex.IsAuthFailure);
        Assert.Null(h.Manager.CurrentSession);
        Assert.Equal(ConnectionState.Unauthorized, h.Manager.State);
        Assert.Null(h.Store.TryLoad());
        var next = await Within(h.Manager.MaterializeFirstFileVersionAsync(MaterializeRequest(), bound));
        Assert.Equal(Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignMaterializationOutcome.Failed, next.Outcome);
        Assert.Single(h.Requests);  // only the rejected reservation
    }

    [Fact]
    public async Task Bound_requests_require_a_bound_session()
    {
        var h = new SwitchHarness { OnApply = Reserved };
        await h.SignInAsync(ScratchOrigin);

        await Assert.ThrowsAsync<ArgumentNullException>(() => h.Manager.ApplyCopyDesignAsync(ApplyRequest(), boundSession: null!));
        Assert.Empty(h.Requests);
    }

    // ---- P6 M4.2: the manager logs its own refusals ---------------------
    //
    // The connection manager's workspace-origin re-check and its
    // session-binding refusal each write one Refused event to
    // ArchConnectionManager.Diagnostics - and a failing log never changes
    // the refusal itself.

    private sealed class RecordingDiagnosticsSink : Arch.CadConnect.Core.Diagnostics.IDiagnosticsSink
    {
        public List<Arch.CadConnect.Core.Diagnostics.DiagnosticEvent> Events { get; } = new();

        public void Write(Arch.CadConnect.Core.Diagnostics.DiagnosticEvent diagnosticEvent) => Events.Add(diagnosticEvent);

        public object? Field(Arch.CadConnect.Core.Diagnostics.DiagnosticEvent e, string name) =>
            e.Fields.FirstOrDefault(f => f.Name == name).Value;
    }

    private sealed class ThrowingDiagnosticsSink : Arch.CadConnect.Core.Diagnostics.IDiagnosticsSink
    {
        public void Write(Arch.CadConnect.Core.Diagnostics.DiagnosticEvent diagnosticEvent) => throw new IOException("disk full");
    }

    [Theory]
    [InlineData("Checkout", "CheckoutAsync")]
    [InlineData("CheckIn", "CheckInAsync")]
    [InlineData("UndoCheckout", "UndoCheckoutAsync")]
    public async Task A_workspace_origin_refusal_in_the_manager_is_logged_with_the_command(string command, string loggedCommand)
    {
        using var ws = new TempWorkspaces();
        var production = ws.Create("prod", ProductionOrigin);
        var (mgr, _, _) = await SignedInTo(ScratchOrigin);
        var sink = new RecordingDiagnosticsSink();
        mgr.Diagnostics = sink;

        await Assert.ThrowsAsync<ArchApiException>(() =>
            InvokeDocumentCommand(mgr, command, ManagedFileRef.Create(production, Path.Combine(production, "A.ipt"))));

        var e = Assert.Single(sink.Events);
        Assert.Equal(Arch.CadConnect.Core.Diagnostics.RefusalDiagnostics.WorkspaceOriginOperation, e.Operation);
        Assert.Equal(Arch.CadConnect.Core.Diagnostics.DiagnosticOutcome.Refused, e.Outcome);
        Assert.Equal(loggedCommand, sink.Field(e, "command"));
        Assert.Equal("DifferentServer", sink.Field(e, "verdict"));
        Assert.Equal(ProductionOrigin, sink.Field(e, "workspaceServerOrigin"));
        Assert.Equal(ScratchOrigin, sink.Field(e, "connectedServerOrigin"));
        Assert.Equal("connection-manager", sink.Field(e, "source"));
    }

    [Fact]
    public async Task A_refused_Get_Latest_target_is_logged_and_an_allowed_one_is_not()
    {
        using var ws = new TempWorkspaces();
        var production = ws.Create("prod", ProductionOrigin);
        var (mgr, _, _) = await SignedInTo(ScratchOrigin);
        var sink = new RecordingDiagnosticsSink();
        mgr.Diagnostics = sink;

        await Assert.ThrowsAsync<ArchApiException>(() => mgr.GetLatestAsync(new GetLatestRequest
        {
            Root = CadDocumentLookup.ByNumber(documentNumber: "ARCH-TEST-001", documentType: "IPT"),
            WorkspaceRoot = production,
        }));
        await Assert.ThrowsAsync<ArchApiException>(() => mgr.GetLatestAsync(new GetLatestRequest
        {
            Root = CadDocumentLookup.ByNumber(documentNumber: "M3-ROOT", documentType: "IAM"),
            WorkspaceRoot = ws.Create("new", serverOrigin: null),   // allowed: reaches the fake api (NotImplemented)
        }));

        var e = Assert.Single(sink.Events);
        Assert.Equal("GetLatestAsync", sink.Field(e, "command"));
        Assert.Equal(production, sink.Field(e, "workspaceRoot"));
    }

    [Fact]
    public async Task A_session_binding_refusal_is_logged_for_reservation_upload_and_status()
    {
        var h = new SwitchHarness { OnApply = Reserved, OnMaterialize = () => Task.FromResult(Materialized()) };
        await h.SignInAsync(ScratchOrigin);
        var bound = h.Manager.CurrentSession!;
        await h.SwitchToAsync(ProductionOrigin);
        var sink = new RecordingDiagnosticsSink();
        h.Manager.Diagnostics = sink;

        await Assert.ThrowsAsync<ArchApiException>(() => h.Manager.ApplyCopyDesignAsync(ApplyRequest(), bound));
        await h.Manager.MaterializeFirstFileVersionAsync(MaterializeRequest(), bound);
        await h.Manager.GetCopyDesignOperationStatusAsync(StatusExpectation(), bound);

        Assert.Equal(new[] { "ApplyCopyDesignAsync", "MaterializeFirstFileVersionAsync", "GetCopyDesignOperationStatusAsync" },
            sink.Events.Select(e => (string?)sink.Field(e, "command")));
        Assert.All(sink.Events, e =>
        {
            Assert.Equal(Arch.CadConnect.Core.Diagnostics.RefusalDiagnostics.SessionBindingOperation, e.Operation);
            Assert.Equal(ScratchOrigin, sink.Field(e, "boundServerOrigin"));
            Assert.Equal(ProductionOrigin, sink.Field(e, "currentServerOrigin"));
        });
        Assert.Empty(h.Requests);
    }

    [Fact]
    public async Task A_bound_request_that_is_not_refused_logs_nothing()
    {
        var h = new SwitchHarness { OnApply = Reserved };
        await h.SignInAsync(ScratchOrigin);
        var sink = new RecordingDiagnosticsSink();
        h.Manager.Diagnostics = sink;

        await h.Manager.ApplyCopyDesignAsync(ApplyRequest(), h.Manager.CurrentSession!);

        Assert.Empty(sink.Events);
    }

    [Fact]
    public async Task A_failing_log_never_changes_a_refusal()
    {
        using var ws = new TempWorkspaces();
        var production = ws.Create("prod", ProductionOrigin);
        var (mgr, store, _) = await SignedInTo(ScratchOrigin);
        mgr.Diagnostics = new ThrowingDiagnosticsSink();

        var ex = await Assert.ThrowsAsync<ArchApiException>(() => mgr.CheckoutAsync(ManagedFileRef.Create(production, Path.Combine(production, "A.ipt"))));
        Assert.Equal(ArchApiFailureKind.BadRequest, ex.Kind);

        var h = new SwitchHarness { OnApply = Reserved };
        await h.SignInAsync(ScratchOrigin);
        var bound = h.Manager.CurrentSession!;
        await h.SwitchToAsync(ProductionOrigin);
        h.Manager.Diagnostics = new ThrowingDiagnosticsSink();
        var refused = await Assert.ThrowsAsync<ArchApiException>(() => h.Manager.ApplyCopyDesignAsync(ApplyRequest(), bound));
        Assert.Equal(ArchConnectionManager.SessionChangedMessage, refused.Message);
        Assert.Equal(ConnectionState.Connected, mgr.State);
        Assert.NotNull(store.TryLoad());
    }

    [Fact]
    public void The_manager_logs_nothing_by_default()
    {
        var mgr = new ArchConnectionManager(server => new FakeApi(server), new InMemorySessionStore());

        Assert.Same(Arch.CadConnect.Core.Diagnostics.NullDiagnosticsSink.Instance, mgr.Diagnostics);
    }
}
