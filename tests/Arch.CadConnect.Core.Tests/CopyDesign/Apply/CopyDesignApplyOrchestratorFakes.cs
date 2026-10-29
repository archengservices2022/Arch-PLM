using Arch.CadConnect.Core.CopyDesign;
using Arch.CadConnect.Core.CopyDesign.Apply;
using Arch.CadConnect.Core.References;

namespace Arch.CadConnect.Core.Tests.CopyDesign.Apply;

internal sealed class FakeReservationClient : ICopyDesignReservationClient
{
    public List<CopyDesignApplyRequest> Calls { get; } = new();
    public Func<CopyDesignApplyRequest, CopyDesignReservationResponse>? Responder { get; set; }

    /// <summary>Always throws this on EVERY call, unconditionally - used by
    ///  existing tests that need a single guaranteed failure.</summary>
    public Exception? ThrowOnCall { get; set; }

    /// <summary>HIGH 2 fix support: throw <see cref="TransientException"/>
    ///  for the FIRST N calls, then succeed - simulates a transient/
    ///  uncertain reservation failure that a SAME-key, SAME-request retry
    ///  resolves. Independent of <see cref="ThrowOnCall"/> (which always
    ///  wins if set, for existing tests' unconditional-failure scenarios).</summary>
    public int ThrowForFirstNCalls { get; set; }
    public Exception TransientException { get; set; } = new IOException("simulated transient network failure");

    /// <summary>P6 M4.1a support: the exception (or null to proceed) for the
    ///  Nth call, 1-based - lets a test vary the failure between attempts
    ///  (e.g. a transient first attempt, then a session-change refusal).</summary>
    public Func<int, Exception?>? ThrowForCall { get; set; }
    private int _callCount;

    /// <summary>P6D ROUND 3 support: invoked with the EXACT (request,
    ///  response) pair whenever a call succeeds - used by
    ///  <see cref="OrchestratorHarness"/> to auto-populate
    ///  <see cref="FakeOperationStatusClient"/> with one PENDING/REUSED entry
    ///  per reservation entry (mirroring how the real server would create
    ///  matching CopyDesignOperationEntry rows in the SAME transaction as the
    ///  reservation itself), so a test needs only override the specific
    ///  entries it cares about.</summary>
    public Action<CopyDesignApplyRequest, CopyDesignReservationResponse>? OnResponded { get; set; }

    public Task<CopyDesignReservationResponse> ApplyAsync(CopyDesignApplyRequest request, CancellationToken ct)
    {
        Calls.Add(request);
        _callCount++;
        if (ThrowOnCall is not null)
        {
            throw ThrowOnCall;
        }
        if (_callCount <= ThrowForFirstNCalls)
        {
            throw TransientException;
        }
        if (ThrowForCall?.Invoke(_callCount) is { } forCall)
        {
            throw forCall;
        }
        var response = (Responder ?? HappyResponse)(request);
        OnResponded?.Invoke(request, response);
        return Task.FromResult(response);
    }

    public static CopyDesignReservationResponse HappyResponse(CopyDesignApplyRequest request)
    {
        var entries = request.WireEntries.Select(e => e.Action == CopyDesignApplyEntryAction.Copy
            ? new CopyDesignReservationResponseEntry(
                CopyDesignApplyEntryAction.Copy, e.Copy!.SourceCadDocumentId, e.Copy.SourceFileVersionId,
                e.Copy.SourceCadDocumentId + "-new", e.Copy.NewDocumentNumber, e.Copy.NewFileName,
                DocumentTypeWireName(e.Copy.DocumentType))
            : new CopyDesignReservationResponseEntry(
                CopyDesignApplyEntryAction.Reuse, null, null, e.Reuse!.CadDocumentId, "10073-STD", "std.ipt", "IPT"))
            .ToArray();
        return new CopyDesignReservationResponse("contract", "op-1", "now", entries);
    }

    private static string DocumentTypeWireName(CadDocumentType type) => type switch
    {
        CadDocumentType.Iam => "IAM",
        CadDocumentType.Idw => "IDW",
        CadDocumentType.Dwg => "DWG",
        _ => "IPT",
    };
}

internal sealed class FakePhysicalCopier : ICopyDesignPhysicalCopier
{
    public List<string> Calls { get; } = new();
    public HashSet<string> FailFor { get; } = new();

    /// <summary>P6D ROUND 5, item C support: CopyAsync THROWS for this
    ///  cadDocumentId instead of returning a fail-shaped result - simulates
    ///  a SaveAs call that genuinely threw (COM exception, I/O error, etc.)
    ///  rather than one that completed and reported failure normally.
    ///  Distinct from <see cref="FailFor"/> so a test can exercise the
    ///  orchestrator's own try/catch around the physical copier call.</summary>
    public HashSet<string> ThrowFor { get; } = new();
    public Exception ExceptionToThrow { get; set; } = new InvalidOperationException("simulated physical-copy exception");

    /// <summary>CODEX ROUND 3, MEDIUM fix support: report this as
    ///  <see cref="CopyDesignPhysicalCopyResult.UnremovedTempPath"/> for a
    ///  failing cadDocumentId - simulates a failed physical copy that ALSO
    ///  left an operation-owned temp artifact behind.</summary>
    public Dictionary<string, string> UnremovedTempPathFor { get; } = new();

    /// <summary>P6D LIVE BLOCKER fix support: the EXACT
    ///  <c>sourceSha256BeforeOperation</c> passed for each call, keyed by
    ///  cadDocumentId - so a test can prove the orchestrator threads its
    ///  own step-4 pre-mutation baseline through to the physical copier,
    ///  the SAME baseline already threaded into the verifier.</summary>
    public Dictionary<string, string> CapturedSourceSha256BeforeOperation { get; } = new(StringComparer.Ordinal);

    /// <summary>P6 METADATA FIX support: shared, ordered log of adapter calls
    ///  ("copy:id", "normalize:id", "rewire:id", "verify:id", ...) - set by
    ///  <see cref="OrchestratorHarness"/> so a test can assert phase order.</summary>
    public List<string>? EventLog { get; set; }

    /// <summary>P6 METADATA FIX support: the temp file NAME a successful copy
    ///  reports as <see cref="CopyDesignPhysicalCopyResult.PromotedFromTempFileName"/> -
    ///  mirrors the real copier's ".p6c-tmp-&lt;guid&gt;-&lt;final name&gt;" shape.</summary>
    /// <summary>P6 Milestone 3 support: invoked when a copy succeeds (e.g. to
    ///  create the destination in a <see cref="FakeBackupFileSystem"/>).</summary>
    public Action<CopyDesignNode>? OnCopied { get; set; }

    public static string TempFileNameFor(CopyDesignNode node) =>
        $"{CopyDesignAtomicPromotion.TempFileNamePrefix}0123456789abcdef0123456789abcdef-{Path.GetFileName(node.ProposedDestinationAbsolutePath)}";

    public Task<CopyDesignPhysicalCopyResult> CopyAsync(CopyDesignNode node, string sourceSha256BeforeOperation, CancellationToken ct)
    {
        Calls.Add(node.CadDocumentId!);
        EventLog?.Add("copy:" + node.CadDocumentId);
        CapturedSourceSha256BeforeOperation[node.CadDocumentId!] = sourceSha256BeforeOperation;
        if (ThrowFor.Contains(node.CadDocumentId!))
        {
            throw ExceptionToThrow;
        }
        if (!FailFor.Contains(node.CadDocumentId!))
        {
            OnCopied?.Invoke(node);
            return Task.FromResult(new CopyDesignPhysicalCopyResult(true, null, PromotedFromTempFileName: TempFileNameFor(node)));
        }
        UnremovedTempPathFor.TryGetValue(node.CadDocumentId!, out var unremovedTempPath);
        return Task.FromResult(new CopyDesignPhysicalCopyResult(false, "simulated copy failure", unremovedTempPath));
    }
}

internal sealed class FakeRewirer : ICopyDesignReferenceRewirer
{
    public List<string> Calls { get; } = new();
    public HashSet<string> FailFor { get; } = new();

    /// <summary>P6D ROUND 3 support: the EXACT targets list passed on each
    ///  call, keyed by cadDocumentId - so a test can prove PHASE 5 rewires
    ///  using the SAME pre-resolved/pre-validated targets the source-
    ///  protection check already validated, never re-resolving independently.</summary>
    public Dictionary<string, IReadOnlyList<CopyDesignReferenceTarget>> CapturedTargets { get; } = new(StringComparer.Ordinal);

    /// <summary>See <see cref="FakePhysicalCopier.EventLog"/>.</summary>
    public List<string>? EventLog { get; set; }

    /// <summary>P6 Milestone 3 support: invoked as the rewirer's "save" (e.g.
    ///  to simulate Inventor's OldVersions backup in a <see cref="FakeBackupFileSystem"/>).
    ///  May throw to simulate a save that fails after the backup appeared.</summary>
    public Action<CopyDesignNode>? OnSave { get; set; }

    public Task<CopyDesignRewireResult> RewireAsync(CopyDesignNode copiedIamNode, IReadOnlyList<CopyDesignReferenceTarget> targets, CancellationToken ct)
    {
        Calls.Add(copiedIamNode.CadDocumentId!);
        EventLog?.Add("rewire:" + copiedIamNode.CadDocumentId);
        OnSave?.Invoke(copiedIamNode);
        CapturedTargets[copiedIamNode.CadDocumentId!] = targets;
        return Task.FromResult(FailFor.Contains(copiedIamNode.CadDocumentId!)
            ? new CopyDesignRewireResult(false, "simulated rewire failure")
            : new CopyDesignRewireResult(true, null));
    }
}

internal sealed class FakeVerifier : ICopyDesignVerifier
{
    public List<string> Calls { get; } = new();
    public HashSet<string> FailFor { get; } = new();

    /// <summary>Set to make GatherFactsAsync THROW for a given cadDocumentId,
    ///  instead of returning a fail-shaped facts result - used to prove the
    ///  orchestrator's HIGH 5 fix (verification exception -&gt; cleanup, never
    ///  an uncontrolled failure).</summary>
    public HashSet<string> ThrowFor { get; } = new();
    public Exception ExceptionToThrow { get; set; } = new InvalidOperationException("simulated verification exception");

    /// <summary>CODEX ROUND 3, HIGH fix support: report
    ///  <c>OccurrenceEnumerationSucceeded: false</c> for a given
    ///  cadDocumentId - simulates an IAM whose occurrence enumeration itself
    ///  failed (as opposed to <see cref="FailFor"/>, which simulates other
    ///  verification failures).</summary>
    public HashSet<string> EnumerationFailureFor { get; } = new();

    /// <summary>See <see cref="FakePhysicalCopier.EventLog"/>.</summary>
    public List<string>? EventLog { get; set; }

    /// <summary>P6 METADATA FIX support: the string iProperties reported for
    ///  a given cadDocumentId (default: none).</summary>
    public Dictionary<string, IReadOnlyList<CopyDesignStringPropertyFact>> StringPropertiesFor { get; } = new(StringComparer.Ordinal);

    /// <summary>P6 METADATA FIX support: report
    ///  <c>PropertyEnumerationSucceeded: false</c> for a given cadDocumentId.</summary>
    public HashSet<string> PropertyEnumerationFailureFor { get; } = new();

    /// <summary>P6 METADATA FIX support: when set, supplies the destination's
    ///  ResultingSha256 at the moment verification reads it (default
    ///  "result-hash") - lets a test prove the hash that is materialized is
    ///  the one captured AFTER normalization.</summary>
    public Func<CopyDesignNode, string>? ResultingSha256Provider { get; set; }

    public Task<CopyDesignNodeVerificationFacts> GatherFactsAsync(
        CopyDesignNode node, IReadOnlyList<CopyDesignReferenceTarget> referenceTargets, string sourceSha256BeforeOperation, CancellationToken ct)
    {
        Calls.Add(node.CadDocumentId!);
        EventLog?.Add("verify:" + node.CadDocumentId);
        if (ThrowFor.Contains(node.CadDocumentId!))
        {
            throw ExceptionToThrow;
        }

        var refs = referenceTargets.Select(t => new CopyDesignReferenceResolutionFact(
            t.ChildCadDocumentId, t.ExpectedTargetAbsolutePath, t.OriginalChildAbsolutePath, t.ExpectedTargetAbsolutePath, t.ChildIsCopy)).ToArray();
        var actual = referenceTargets.Select(t => new CopyDesignActualComponentOccurrence(t.ExpectedTargetAbsolutePath)).ToArray();

        var fail = FailFor.Contains(node.CadDocumentId!);
        var enumerationSucceeded = !EnumerationFailureFor.Contains(node.CadDocumentId!);
        return Task.FromResult(new CopyDesignNodeVerificationFacts(
            node.CadDocumentId!, node.SourceAbsolutePath, node.ProposedDestinationAbsolutePath ?? "",
            DestinationExists: !fail, DocumentTypeMatches: true, OpenableThroughInventor: true,
            ResultingSha256: fail ? null : ResultingSha256Provider?.Invoke(node) ?? "result-hash", ResultingFileSize: fail ? null : 100L,
            SourceSha256BeforeOperation: sourceSha256BeforeOperation,
            SourceSha256AfterOperation: sourceSha256BeforeOperation, ReferenceResolutions: refs,
            ActualComponentOccurrences: actual, OccurrenceEnumerationSucceeded: enumerationSucceeded,
            StringProperties: StringPropertiesFor.TryGetValue(node.CadDocumentId!, out var properties) ? properties : null,
            PropertyEnumerationSucceeded: !PropertyEnumerationFailureFor.Contains(node.CadDocumentId!)));
    }
}

/// <summary>P6 METADATA FIX support: a fake <see cref="ICopyDesignMetadataNormalizer"/>.
///  Succeeds by default and records every call (with the temp file name it
///  was handed) plus which destinations it "normalized".</summary>
internal sealed class FakeMetadataNormalizer : ICopyDesignMetadataNormalizer
{
    public List<string> Calls { get; } = new();
    public Dictionary<string, string?> CapturedTempFileName { get; } = new(StringComparer.Ordinal);
    public HashSet<string> NormalizedDestinations { get; } = new(StringComparer.OrdinalIgnoreCase);
    public HashSet<string> FailFor { get; } = new();
    public HashSet<string> ThrowFor { get; } = new();
    public Exception ExceptionToThrow { get; set; } = new InvalidOperationException("simulated normalization exception");

    /// <summary>See <see cref="FakePhysicalCopier.EventLog"/>.</summary>
    public List<string>? EventLog { get; set; }

    /// <summary>P6 Milestone 3 support: invoked as the normalizer's "save" -
    ///  see <see cref="FakeRewirer.OnSave"/>.</summary>
    public Action<CopyDesignNode>? OnSave { get; set; }

    public Task<CopyDesignMetadataNormalizationResult> NormalizeAsync(
        CopyDesignNode node, string? promotedFromTempFileName, CancellationToken ct)
    {
        Calls.Add(node.CadDocumentId!);
        EventLog?.Add("normalize:" + node.CadDocumentId);
        CapturedTempFileName[node.CadDocumentId!] = promotedFromTempFileName;
        OnSave?.Invoke(node);
        if (ThrowFor.Contains(node.CadDocumentId!))
        {
            throw ExceptionToThrow;
        }
        if (FailFor.Contains(node.CadDocumentId!))
        {
            return Task.FromResult(new CopyDesignMetadataNormalizationResult(false, "simulated normalization failure"));
        }
        NormalizedDestinations.Add(node.ProposedDestinationAbsolutePath!);
        return Task.FromResult(new CopyDesignMetadataNormalizationResult(true, null));
    }
}

internal sealed class FakeMaterializer : ICopyDesignMaterializer
{
    public List<string> Calls { get; } = new();
    public List<CopyDesignMaterializeRequest> Requests { get; } = new();
    public Func<string, CopyDesignMaterializationResult>? Responder { get; set; }

    public Task<CopyDesignMaterializationResult> MaterializeFirstFileVersionAsync(
        CopyDesignMaterializeRequest request, CancellationToken ct)
    {
        Calls.Add(request.ResultingCadDocumentId);
        Requests.Add(request);
        var result = Responder?.Invoke(request.ResultingCadDocumentId)
            ?? new CopyDesignMaterializationResult(request.ResultingCadDocumentId, CopyDesignMaterializationOutcome.Materialized, "fv-1", 1, request.ExpectedSha256, request.ExpectedFileSize, "ok");
        return Task.FromResult(result);
    }
}

/// <summary>P6D ROUND 3 support: a fake
///  <see cref="ICopyDesignOperationStatusClient"/> - REPLACES round 2's
///  <c>FakeMaterializationStatusProbe</c>. Auto-populated (via
///  <see cref="OrchestratorHarness"/> wiring <see cref="FakeReservationClient.OnResponded"/>)
///  with one PENDING (COPY) / REUSED (REUSE) entry per reservation response
///  entry - mirroring how the real server's status endpoint reads directly
///  off the SAME <c>CopyDesignOperationEntry</c> rows the reservation itself
///  created. A test then calls <see cref="MarkMaterialized"/> /
///  <see cref="MarkInvalid"/> for the specific resultingCadDocumentId(s) it
///  wants to simulate as already done.</summary>
internal sealed class FakeOperationStatusClient : ICopyDesignOperationStatusClient
{
    public List<string> Calls { get; } = new();
    public List<CopyDesignOperationStatusEntry> Entries { get; } = new();
    public string? OperationId { get; set; }
    public string? IdempotencyKey { get; set; }

    /// <summary>When set, GetStatusAsync throws this instead of returning -
    ///  simulates a transport/auth failure. P6D ROUND 3: UNLIKE round 2's
    ///  probe, this is now FATAL to the whole apply (fail closed) - see the
    ///  orchestrator's own step 6b comment for why.</summary>
    public Exception? ThrowOnCall { get; set; }

    /// <summary>When set, overrides the auto-populated <see cref="Entries"/>
    ///  entirely - used by adversarial tests that need a specific malformed/
    ///  inconsistent response shape (wrong operationId, duplicate entry,
    ///  missing entry, wrong source identity, etc.).</summary>
    public Func<CopyDesignOperationStatusResult>? ForcedResult { get; set; }

    public void AddPendingIfAbsent(bool isCopy, string? sourceCadDocumentId, string resultingCadDocumentId,
        string documentNumber, string fileName, string documentType)
    {
        if (Entries.Any(e => e.ResultingCadDocumentId == resultingCadDocumentId))
        {
            return; // already known (e.g. a bounded reservation retry re-invoking OnResponded)
        }
        Entries.Add(new CopyDesignOperationStatusEntry(
            Entries.Count, isCopy,
            isCopy ? CopyDesignOperationEntryState.Pending : CopyDesignOperationEntryState.Reused,
            isCopy ? sourceCadDocumentId : null, resultingCadDocumentId, documentNumber, fileName, documentType));
    }

    public void MarkMaterialized(string resultingCadDocumentId, int versionNumber, string sha256, long fileSize, string fileVersionId)
    {
        var idx = Entries.FindIndex(e => e.ResultingCadDocumentId == resultingCadDocumentId);
        Entries[idx] = Entries[idx] with
        {
            State = CopyDesignOperationEntryState.Materialized,
            VersionNumber = versionNumber,
            Sha256 = sha256,
            FileSize = fileSize,
            FileVersionId = fileVersionId,
        };
    }

    public void MarkInvalid(string resultingCadDocumentId)
    {
        var idx = Entries.FindIndex(e => e.ResultingCadDocumentId == resultingCadDocumentId);
        Entries[idx] = Entries[idx] with { State = CopyDesignOperationEntryState.Invalid };
    }

    /// <summary>The LAST expectation this fake was called with - a test can
    ///  inspect it to prove the orchestrator built the expectation
    ///  correctly, without re-implementing the (separately, exhaustively
    ///  tested in HttpCopyDesignOperationStatusProbeTests) cross-validation
    ///  logic here. This fake deliberately does NOT itself validate
    ///  `Entries`/`ForcedResult` against the expectation - it exists to test
    ///  the ORCHESTRATOR's consumption of a Success/Failure result, not to
    ///  re-test the probe's own validation.</summary>
    public CopyDesignOperationStatusExpectation? LastExpectation { get; private set; }

    public Task<CopyDesignOperationStatusResult> GetStatusAsync(CopyDesignOperationStatusExpectation expectation, CancellationToken ct)
    {
        LastExpectation = expectation;
        Calls.Add(expectation.OperationId);
        if (ThrowOnCall is not null)
        {
            throw ThrowOnCall;
        }
        if (ForcedResult is not null)
        {
            return Task.FromResult(ForcedResult());
        }
        return Task.FromResult(new CopyDesignOperationStatusResult(
            CopyDesignOperationStatusOutcome.Found, OperationId ?? expectation.OperationId, IdempotencyKey ?? "unused", Entries));
    }
}

internal sealed class FakeHasher : ICopyDesignFileHasher
{
    /// <summary>P6D ROUND 2 support: for a path present here, each call
    ///  DEQUEUES the next hash (so a test can simulate "this path's content
    ///  changed between the before-baseline and the after-recheck" by
    ///  queuing two different values) - falls back to the deterministic
    ///  path-based default once the queue is empty or the path was never
    ///  configured.</summary>
    public Dictionary<string, Queue<string>> SequencedHashesFor { get; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>P6D ROUND 2 support: for a path present here, ComputeSha256
    ///  throws instead of returning - simulates a referenced model file that
    ///  is unreadable/missing on EVERY call, from the very first read.</summary>
    public HashSet<string> ThrowForPath { get; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>P6D ROUND 3 support: for a path present here, ComputeSha256
    ///  SUCCEEDS for the first (value - 1) calls and THROWS from the Nth
    ///  call onward - simulates a file that was readable when first hashed
    ///  (e.g. the pre-copy step-4 baseline, or the integrity baseline
    ///  capture) but became unreadable/missing partway through the
    ///  operation (e.g. immediately after a drawing physical copy).</summary>
    public Dictionary<string, int> ThrowStartingFromCall { get; } = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, int> _callCounts = new(StringComparer.OrdinalIgnoreCase);

    public string ComputeSha256(string absolutePath)
    {
        _callCounts.TryGetValue(absolutePath, out var count);
        count++;
        _callCounts[absolutePath] = count;

        if (ThrowForPath.Contains(absolutePath)
            || (ThrowStartingFromCall.TryGetValue(absolutePath, out var throwFromCall) && count >= throwFromCall))
        {
            throw new IOException("simulated unreadable/missing referenced model file");
        }
        if (SequencedHashesFor.TryGetValue(absolutePath, out var queue) && queue.Count > 0)
        {
            return queue.Dequeue();
        }
        return "hash:" + absolutePath.ToLowerInvariant();
    }
}

/// <summary>A tiny orchestrator test harness with sensible defaults and
///  override hooks, so each test configures only what it cares about.</summary>
internal sealed class OrchestratorHarness
{
    public FakeReservationClient Reservation { get; } = new();
    public FakePhysicalCopier Copier { get; } = new();
    public FakeRewirer Rewirer { get; } = new();
    public FakeVerifier Verifier { get; } = new();
    /// <summary>P6D: the SEPARATE drawing reference-rewiring adapter -
    ///  reuses the SAME <see cref="FakeRewirer"/> shape (the interface is
    ///  identical) since the orchestrator now injects two independent
    ///  instances (model vs. drawing). Defaults to always-succeed so every
    ///  existing model-only test keeps passing unmodified even though
    ///  <see cref="CopyDesignApplyOrchestrator.Build"/>... (see
    ///  <see cref="Build"/> below) now always supplies it.</summary>
    public FakeRewirer DrawingRewirer { get; } = new();
    /// <summary>P6D: the SEPARATE drawing verification adapter - see
    ///  <see cref="DrawingRewirer"/>'s own doc comment for why a second
    ///  instance of the same fake shape is used.</summary>
    public FakeVerifier DrawingVerifier { get; } = new();
    public FakeMaterializer Materializer { get; } = new();
    public FakeHasher Hasher { get; } = new();
    public CopyDesignApplyOperationGuard Guard { get; } = new();
    public HashSet<string> ExistingSources { get; } = new(StringComparer.OrdinalIgnoreCase);
    public HashSet<string> ExistingDestinations { get; } = new(StringComparer.OrdinalIgnoreCase);
    public List<string> Deleted { get; } = new();
    public Func<string, bool>? SourceExistsOverride { get; set; }
    public Func<string, bool>? DestinationExistsOverride { get; set; }

    /// <summary>HIGH 2 fix support: defaults to <c>null</c> (no classifier),
    ///  which means the retry loop NEVER activates - identical to
    ///  pre-Round-CODEX behavior - unless a test explicitly opts in.</summary>
    public Func<Exception, bool>? IsTransientReservationFailure { get; set; }
    public int MaxReservationAttempts { get; set; } = 3;

    /// <summary>Set to <c>false</c> only for a test that deliberately proves
    ///  the orchestrator's drawing-adapter config guard (a plan with a
    ///  drawing COPY node but no drawing adapters configured) - every other
    ///  test gets working drawing adapters by default, exactly like every
    ///  other fake in this harness.</summary>
    public bool IncludeDrawingAdapters { get; set; } = true;

    /// <summary>P6D ROUND 3 (RESUME): the OPTIONAL authoritative operation-
    ///  status client. <c>null</c> by default (matches the orchestrator's own
    ///  default - RESUME is fully opt-in); a test sets
    ///  <see cref="IncludeOperationStatusClient"/> to exercise it. When
    ///  included, <see cref="Build"/> wires <see cref="FakeReservationClient.OnResponded"/>
    ///  to auto-populate <see cref="OperationStatusClient"/>'s entries from
    ///  whatever the reservation call actually returned - see
    ///  <see cref="FakeOperationStatusClient"/>'s own doc comment.</summary>
    public FakeOperationStatusClient OperationStatusClient { get; } = new();
    public bool IncludeOperationStatusClient { get; set; } = false;

    /// <summary>P6D ROUND 2 (RESUME) support: fake local file sizes, keyed by
    ///  absolute path - avoids the RESUME integrity check needing a REAL
    ///  file on disk. A path not present here defaults to <c>0</c>.</summary>
    public Dictionary<string, long> FileSizeFor { get; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>P6 METADATA FIX: wired by default (always succeeds), so EVERY
    ///  existing orchestrator test also exercises the normalization step's
    ///  success path; set <see cref="IncludeMetadataNormalizer"/> to
    ///  <c>false</c> to prove the unconfigured (null) path.</summary>
    public FakeMetadataNormalizer MetadataNormalizer { get; } = new();
    public bool IncludeMetadataNormalizer { get; set; } = true;

    /// <summary>P6 METADATA FIX: shared, ordered adapter-call log (see
    ///  <see cref="FakePhysicalCopier.EventLog"/>).</summary>
    public List<string> Events { get; } = new();

    /// <summary>P6 Milestone 3: <c>null</c> by default (backup tracking off -
    ///  every existing test unchanged); set to enable tracking.</summary>
    public FakeBackupFileSystem? BackupFileSystem { get; set; }

    /// <summary>P6 M4.2: <c>null</c> by default (no observer - every existing
    ///  test unchanged).</summary>
    public ICopyDesignApplyProgress? Progress { get; set; }

    public CopyDesignApplyOrchestrator Build()
    {
        Copier.EventLog = Events;
        MetadataNormalizer.EventLog = Events;
        Rewirer.EventLog = Events;
        Verifier.EventLog = Events;
        DrawingRewirer.EventLog = Events;
        DrawingVerifier.EventLog = Events;

        if (IncludeOperationStatusClient && Reservation.OnResponded is null)
        {
            // A test may have already set Reservation.OnResponded directly
            // (e.g. to force a specific/adversarial status response) - never
            // clobber that. This default only auto-populates PENDING/REUSED
            // entries when the test hasn't configured anything itself.
            Reservation.OnResponded = (request, response) =>
            {
                OperationStatusClient.OperationId = response.CopyDesignOperationId;
                OperationStatusClient.IdempotencyKey = request.IdempotencyKey;
                foreach (var entry in response.Entries)
                {
                    OperationStatusClient.AddPendingIfAbsent(
                        entry.Action == CopyDesignApplyEntryAction.Copy, entry.SourceCadDocumentId,
                        entry.ResultingCadDocumentId, entry.DocumentNumber, entry.FileName, entry.DocumentType);
                }
            };
        }

        return new(
            Guard, Reservation, Copier, Rewirer, Verifier, Materializer, Hasher,
            SourceExistsOverride ?? (path => ExistingSources.Contains(path)),
            DestinationExistsOverride ?? (path => ExistingDestinations.Contains(path)),
            Deleted.Add,
            IsTransientReservationFailure,
            MaxReservationAttempts,
            IncludeDrawingAdapters ? DrawingRewirer : null,
            IncludeDrawingAdapters ? DrawingVerifier : null,
            IncludeOperationStatusClient ? OperationStatusClient : null,
            path => FileSizeFor.TryGetValue(path, out var size) ? size : 0L,
            IncludeMetadataNormalizer ? MetadataNormalizer : null,
            BackupFileSystem,
            Progress);
    }
}


/// <summary>P6 Milestone 3 support: an in-memory file system that models
///  Inventor 2027's MEASURED OldVersions behavior (see CopyDesignBackupTracking.cs):
///  a save MOVES the previous bytes to <c>&lt;dir&gt;\OldVersions\&lt;stem&gt;.NNNN&lt;ext&gt;</c>
///  (NNNN from the document's own save count) and rotation keeps only the
///  newest <see cref="KeepVersions"/> backups PER NAME. "Contents" are opaque
///  strings standing in for SHA-256 values.</summary>
internal sealed class FakeBackupFileSystem : ICopyDesignBackupFileSystem
{
    public Dictionary<string, string> Files { get; } = new(StringComparer.OrdinalIgnoreCase);
    public HashSet<string> ThrowOnListFor { get; } = new(StringComparer.OrdinalIgnoreCase);
    public HashSet<string> ThrowOnDeleteFor { get; } = new(StringComparer.OrdinalIgnoreCase);
    public List<string> Deleted { get; } = new();
    public int KeepVersions { get; set; } = 1;
    /// <summary>The next backup number per destination (the document's own
    ///  save count) - defaults to 2, as measured for a once-saved source.</summary>
    public Dictionary<string, int> NextBackupNumber { get; } = new(StringComparer.OrdinalIgnoreCase);
    private int _contentSeq;

    public string NewContent(string label) => $"{label}#{++_contentSeq}";

    public static string BackupPath(string destination, int number) =>
        Path.Combine(CopyDesignBackupNaming.OldVersionsFolderOf(destination),
            $"{Path.GetFileNameWithoutExtension(destination)}.{number:0000}{Path.GetExtension(destination)}");

    /// <summary>Exactly what Inventor does on Save2 of an existing file.</summary>
    public string SimulateInventorSave(string destination)
    {
        var number = NextBackupNumber.TryGetValue(destination, out var n) ? n : 2;
        NextBackupNumber[destination] = number + 1;
        var backup = BackupPath(destination, number);
        Files[backup] = Files[destination];
        Files[destination] = NewContent("saved:" + Path.GetFileName(destination));
        var sameName = ListBackupsOf(destination).OrderBy(b => b.FileName, StringComparer.OrdinalIgnoreCase).ToList();
        foreach (var old in sameName.Take(Math.Max(0, sameName.Count - KeepVersions)))
        {
            Files.Remove(old.AbsolutePath);
        }
        return backup;
    }

    public IReadOnlyList<CopyDesignBackupFile> ListBackupsOf(string destinationAbsolutePath)
    {
        if (ThrowOnListFor.Contains(destinationAbsolutePath))
        {
            throw new IOException("simulated OldVersions read failure");
        }
        var folder = CopyDesignBackupNaming.OldVersionsFolderOf(destinationAbsolutePath);
        var name = Path.GetFileName(destinationAbsolutePath);
        return Files
            .Where(f => string.Equals(Path.GetDirectoryName(f.Key), folder, StringComparison.OrdinalIgnoreCase)
                && CopyDesignBackupNaming.IsBackupOf(Path.GetFileName(f.Key), name))
            .OrderBy(f => f.Key, StringComparer.OrdinalIgnoreCase)
            .Select(f => new CopyDesignBackupFile(f.Key, Path.GetFileName(f.Key), f.Value.Length, f.Value))
            .ToArray();
    }

    public string ComputeSha256(string absolutePath) =>
        Files.TryGetValue(absolutePath, out var content) ? content : throw new FileNotFoundException(absolutePath);

    public bool FileExists(string absolutePath) => Files.ContainsKey(absolutePath);

    public void DeleteFile(string absolutePath)
    {
        if (ThrowOnDeleteFor.Contains(absolutePath))
        {
            throw new IOException("simulated delete failure (file locked)");
        }
        Files.Remove(absolutePath);
        Deleted.Add(absolutePath);
    }
}