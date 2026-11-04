using Arch.CadConnect.Core;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Core.Tests.Workspace;

public class UndoTargetMemoryTests
{
    private const string Root = @"C:\ws\proj";
    private static readonly string PartPath = System.IO.Path.Combine(Root, "part.ipt");

    private static WorkspaceCheckoutBinding Binding(string checkoutId = "co_1", string baseFv = "fv_1") => new()
    {
        CheckoutId = checkoutId,
        BaseFileVersionId = baseFv,
        BaseVersionNumber = 3,
        BaseChecksum = "abc",
        BaseFileSize = 100,
    };

    private static CadDocumentContext CheckedOutDoc(
        string cadId = "cad_1", string docNumber = "PRT-1",
        string checkoutId = "co_1", string baseFv = "fv_1", string path = null!) =>
        CadDocumentContext.Create(path ?? PartPath, displayNameFallback: null, isDirty: false) with
        {
            PlmIdentity = new PlmIdentity(cadId, docNumber, baseFv, 3),
            CheckoutBinding = Binding(checkoutId, baseFv),
            CheckoutState = LocalCheckoutState.CheckedOutByMe,
            WorkspaceRoot = Root,
        };

    private static WorkspaceManifestEntry Entry(
        string cadId = "cad_1", string checkoutId = "co_1", string baseFv = "fv_1", bool checkedOut = true) => new()
    {
        RelativePath = "part.ipt",
        CadDocumentId = cadId,
        DocumentNumber = "PRT-1",
        FileName = "part.ipt",
        FileVersionId = baseFv,
        VersionNumber = 3,
        Checksum = "abc",
        FileSize = 100,
        State = WorkspaceManifestEntryState.Verified,
        Checkout = checkedOut ? Binding(checkoutId, baseFv) : null,
    };

    // ---- capture -----------------------------------------------------

    [Fact]
    public void Observe_captures_a_checked_out_managed_document()
    {
        var m = new UndoTargetMemory();
        m.Observe(CheckedOutDoc());
        Assert.NotNull(m.Current);
        Assert.Equal("cad_1", m.Current!.CadDocumentId);
        Assert.Equal("co_1", m.Current.CheckoutId);
        Assert.Equal("fv_1", m.Current.BaseFileVersionId);
        Assert.Equal("PRT-1", m.Current.DocumentNumber);
        Assert.Equal(PartPath, m.Current.File.AbsoluteFilePath);
    }

    [Fact]
    public void Observe_of_an_unmanaged_or_not_mine_document_never_creates_a_target()
    {
        var m = new UndoTargetMemory();
        m.Observe(CadDocumentContext.None);
        Assert.Null(m.Current);

        m.Observe(CadDocumentContext.Create(PartPath, null, false) with { CheckoutState = LocalCheckoutState.Controlled });
        Assert.Null(m.Current);
    }

    [Fact]
    public void Observe_keeps_the_existing_target_when_a_non_checked_out_doc_becomes_active_or_closes()
    {
        var m = new UndoTargetMemory();
        m.Observe(CheckedOutDoc());
        var captured = m.Current;

        m.Observe(CadDocumentContext.None);                       // document closed
        Assert.Same(captured, m.Current);

        m.Observe(CadDocumentContext.Create(@"C:\other\x.ipt", null, false)); // unrelated doc
        Assert.Same(captured, m.Current);
    }

    [Fact]
    public void Observe_replaces_with_the_most_recently_active_checkout_target()
    {
        var m = new UndoTargetMemory();
        m.Observe(CheckedOutDoc(cadId: "cad_A", docNumber: "A", checkoutId: "co_A", path: System.IO.Path.Combine(Root, "a.ipt")));
        m.Observe(CheckedOutDoc(cadId: "cad_B", docNumber: "B", checkoutId: "co_B", path: System.IO.Path.Combine(Root, "b.ipt")));
        Assert.Equal("cad_B", m.Current!.CadDocumentId);
        Assert.Equal("B", m.Current.DocumentNumber);
    }

    // ---- revalidation ----------------------------------------------

    private static void Revalidate(UndoTargetMemory m, WorkspaceManifestEntry? entry, string? root = Root, bool fileExists = true)
        => m.Revalidate(_ => entry, _ => fileExists, root);

    [Fact]
    public void Revalidate_keeps_a_still_checked_out_exact_binding()
    {
        var m = new UndoTargetMemory();
        m.Observe(CheckedOutDoc());
        Revalidate(m, Entry());
        Assert.NotNull(m.Current);
    }

    [Fact]
    public void Revalidate_drops_the_target_when_the_manifest_entry_is_gone()
    {
        var m = new UndoTargetMemory();
        m.Observe(CheckedOutDoc());
        Revalidate(m, null);
        Assert.Null(m.Current);
    }

    [Fact]
    public void Revalidate_drops_the_target_when_the_checkout_marker_was_cleared_by_a_check_in()
    {
        var m = new UndoTargetMemory();
        m.Observe(CheckedOutDoc());
        Revalidate(m, Entry(checkedOut: false));
        Assert.Null(m.Current);
    }

    [Fact]
    public void Revalidate_drops_the_target_on_a_checkoutId_or_base_identity_mismatch()
    {
        var m1 = new UndoTargetMemory(); m1.Observe(CheckedOutDoc());
        Revalidate(m1, Entry(checkoutId: "co_DIFFERENT"));
        Assert.Null(m1.Current);

        var m2 = new UndoTargetMemory(); m2.Observe(CheckedOutDoc());
        Revalidate(m2, Entry(baseFv: "fv_DIFFERENT"));
        Assert.Null(m2.Current);

        var m3 = new UndoTargetMemory(); m3.Observe(CheckedOutDoc());
        Revalidate(m3, Entry(cadId: "cad_DIFFERENT"));
        Assert.Null(m3.Current);
    }

    [Fact]
    public void Revalidate_drops_the_target_when_the_workspace_root_changed()
    {
        var m = new UndoTargetMemory();
        m.Observe(CheckedOutDoc());
        Revalidate(m, Entry(), root: @"C:\ws\other-project");
        Assert.Null(m.Current);
    }

    [Fact]
    public void Revalidate_drops_the_target_when_the_local_file_is_missing()
    {
        var m = new UndoTargetMemory();
        m.Observe(CheckedOutDoc());
        Revalidate(m, Entry(), fileExists: false);
        Assert.Null(m.Current);
    }

    [Fact]
    public void Clear_forgets_the_target_unconditionally()
    {
        var m = new UndoTargetMemory();
        m.Observe(CheckedOutDoc());
        m.Clear();
        Assert.Null(m.Current);
    }

    [Fact]
    public void RootsEqual_tolerates_a_trailing_separator_but_not_a_different_folder()
    {
        var t = new RememberedCheckoutTarget(
            ManagedFileRef.Create(Root, PartPath), "cad_1", "co_1", "fv_1", "PRT-1");
        Assert.True(t.IsStillUndoable(Entry(), Root + System.IO.Path.DirectorySeparatorChar));
        Assert.False(t.IsStillUndoable(Entry(), @"C:\ws\proj-2"));
        Assert.False(t.IsStillUndoable(Entry(), null));
    }

    // ---- R10 MA-7: drop reasons (diagnostics only) ---------------------

    [Fact]
    public void Revalidate_reports_no_reason_when_the_target_is_kept_or_absent()
    {
        var m = new UndoTargetMemory();
        Assert.Null(m.Revalidate(_ => Entry(), _ => true, Root)); // nothing remembered
        m.Observe(CheckedOutDoc());
        Assert.Null(m.Revalidate(_ => Entry(), _ => true, Root));
        Assert.NotNull(m.Current);
    }

    [Fact]
    public void Revalidate_reports_why_the_target_was_dropped()
    {
        string? Drop(WorkspaceManifestEntry? entry, string? root = Root, bool fileExists = true)
        {
            var m = new UndoTargetMemory();
            m.Observe(CheckedOutDoc());
            var reason = m.Revalidate(_ => entry, _ => fileExists, root);
            Assert.Null(m.Current); // every reported reason really dropped it
            return reason;
        }

        Assert.Equal(UndoTargetDropReason.EntryMissing, Drop(null));
        Assert.Equal(UndoTargetDropReason.MarkerCleared, Drop(Entry(checkedOut: false)));
        Assert.Equal(UndoTargetDropReason.WorkspaceChanged, Drop(Entry(), root: @"C:\ws\other"));
        Assert.Equal(UndoTargetDropReason.WorkspaceChanged, Drop(Entry(), root: null));
        Assert.Equal(UndoTargetDropReason.IdentityChanged, Drop(Entry(checkoutId: "co_2")));
        Assert.Equal(UndoTargetDropReason.IdentityChanged, Drop(Entry(baseFv: "fv_2")));
        Assert.Equal(UndoTargetDropReason.IdentityChanged, Drop(Entry(cadId: "cad_2")));
        Assert.Equal(UndoTargetDropReason.FileMissing, Drop(Entry(), fileExists: false));
    }

    // ---- R10 MA-7: single-checkout fallback -----------------------------

    private const string Sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    private static WorkspaceCheckoutBinding CompleteBinding(string checkoutId = "co_1", string baseFv = "fv_1") => new()
    {
        CheckoutId = checkoutId,
        BaseFileVersionId = baseFv,
        BaseVersionNumber = 3,
        BaseChecksum = Sha,
        BaseFileSize = 100,
        CheckedOutAtUtc = new DateTimeOffset(2026, 11, 3, 12, 0, 0, TimeSpan.Zero),
    };

    private static WorkspaceManifestEntry ManifestEntry(
        string relativePath = "part.ipt", string cadId = "cad_1", string docNumber = "PRT-1",
        WorkspaceCheckoutBinding? checkout = null, bool checkedOut = true) => new()
    {
        RelativePath = relativePath,
        CadDocumentId = cadId,
        DocumentNumber = docNumber,
        FileName = relativePath,
        FileVersionId = "fv_1",
        VersionNumber = 3,
        Checksum = Sha,
        FileSize = 100,
        State = WorkspaceManifestEntryState.Verified,
        Checkout = checkedOut ? checkout ?? CompleteBinding() : null,
    };

    private static UndoTargetRecovery Resolve(
        IEnumerable<WorkspaceManifestEntry>? entries, string? root = Root, Func<string, bool>? fileExists = null) =>
        UndoTargetMemory.ResolveFromWorkspace(entries, root, fileExists ?? (_ => true));

    [Fact]
    public void ResolveFromWorkspace_recovers_the_single_complete_checkout_in_the_selected_workspace()
    {
        var plain = ManifestEntry(relativePath: "other.ipt", cadId: "cad_9", checkedOut: false);
        var result = Resolve([plain, ManifestEntry()]);

        Assert.Equal(UndoTargetRecovery.Recovered, result.Outcome);
        Assert.Equal(1, result.CheckoutCount);
        var t = Assert.IsType<RememberedCheckoutTarget>(result.Target);
        Assert.Equal(PartPath, t.File.AbsoluteFilePath, ignoreCase: true);
        Assert.Equal(Root, t.File.WorkspaceRoot);
        Assert.Equal("cad_1", t.CadDocumentId);
        Assert.Equal("co_1", t.CheckoutId);
        Assert.Equal("fv_1", t.BaseFileVersionId);
        Assert.Equal("PRT-1", t.DocumentNumber);

        // The recovered target passes the same exact-binding revalidation an
        // observed one does.
        Assert.True(t.IsStillUndoable(ManifestEntry(), Root));
    }

    [Fact]
    public void ResolveFromWorkspace_labels_with_the_cad_document_id_when_there_is_no_number()
    {
        var t = Resolve([ManifestEntry(docNumber: "")]).Target;
        Assert.Equal("cad_1", t!.DocumentNumber);
    }

    [Fact]
    public void ResolveFromWorkspace_only_checks_the_file_the_marker_names()
    {
        var asked = new List<string>();
        Resolve([ManifestEntry()], fileExists: p => { asked.Add(p); return true; });
        Assert.Equal(new[] { PartPath }, asked, StringComparer.OrdinalIgnoreCase);
    }

    [Fact]
    public void ResolveFromWorkspace_recovers_nothing_when_no_workspace_is_selected()
    {
        foreach (var root in new[] { null, "", "   " })
        {
            var result = Resolve([ManifestEntry()], root);
            Assert.Null(result.Target);
            Assert.Equal(UndoTargetRecovery.NoWorkspace, result.Outcome);
        }
    }

    [Fact]
    public void ResolveFromWorkspace_recovers_nothing_when_no_entry_is_checked_out()
    {
        Assert.Equal(UndoTargetRecovery.NoCheckout, Resolve(null).Outcome);
        Assert.Equal(UndoTargetRecovery.NoCheckout, Resolve([]).Outcome);
        var result = Resolve([ManifestEntry(checkedOut: false)]);
        Assert.Null(result.Target);
        Assert.Equal(UndoTargetRecovery.NoCheckout, result.Outcome);
        Assert.Equal(0, result.CheckoutCount);
    }

    [Fact]
    public void ResolveFromWorkspace_never_guesses_between_two_checkouts()
    {
        var second = ManifestEntry(relativePath: "other.ipt", cadId: "cad_2", checkout: CompleteBinding("co_2", "fv_2"));
        var result = Resolve([ManifestEntry(), second]);
        Assert.Null(result.Target);
        Assert.Equal(UndoTargetRecovery.Ambiguous, result.Outcome);
        Assert.Equal(2, result.CheckoutCount);
    }

    [Fact]
    public void ResolveFromWorkspace_counts_an_incomplete_marker_as_a_second_checkout()
    {
        // One complete record plus one broken one is still ambiguous: the
        // broken one may be the file the user meant.
        var broken = ManifestEntry(relativePath: "other.ipt", cadId: "cad_2", checkout: Binding("co_2", "fv_2"));
        var result = Resolve([ManifestEntry(), broken]);
        Assert.Null(result.Target);
        Assert.Equal(UndoTargetRecovery.Ambiguous, result.Outcome);
    }

    public static TheoryData<string> IncompleteRecords => new()
    {
        "blank-checkout-id", "padded-checkout-id", "blank-base", "zero-version", "noncanonical-checksum",
        "uppercase-checksum", "zero-size", "no-timestamp", "blank-cad-id",
    };

    [Theory]
    [MemberData(nameof(IncompleteRecords))]
    public void ResolveFromWorkspace_refuses_an_incomplete_checkout_record(string defect)
    {
        var b = CompleteBinding();
        var entry = defect switch
        {
            "blank-checkout-id" => ManifestEntry(checkout: b with { CheckoutId = "" }),
            "padded-checkout-id" => ManifestEntry(checkout: b with { CheckoutId = " co_1" }),
            "blank-base" => ManifestEntry(checkout: b with { BaseFileVersionId = " " }),
            "zero-version" => ManifestEntry(checkout: b with { BaseVersionNumber = 0 }),
            "noncanonical-checksum" => ManifestEntry(checkout: b with { BaseChecksum = "abc" }),
            "uppercase-checksum" => ManifestEntry(checkout: b with { BaseChecksum = Sha.ToUpperInvariant() }),
            "zero-size" => ManifestEntry(checkout: b with { BaseFileSize = 0 }),
            "no-timestamp" => ManifestEntry(checkout: b with { CheckedOutAtUtc = default }),
            "blank-cad-id" => ManifestEntry(cadId: ""),
            _ => throw new ArgumentOutOfRangeException(nameof(defect)),
        };

        var result = Resolve([entry]);
        Assert.Null(result.Target);
        Assert.Equal(UndoTargetRecovery.Incomplete, result.Outcome);
        if (defect != "blank-cad-id")
        {
            Assert.False(UndoTargetMemory.IsCompleteCheckoutRecord(entry.Checkout));
        }
    }

    [Fact]
    public void IsCompleteCheckoutRecord_accepts_a_complete_record_and_rejects_null()
    {
        Assert.True(UndoTargetMemory.IsCompleteCheckoutRecord(CompleteBinding()));
        Assert.False(UndoTargetMemory.IsCompleteCheckoutRecord(null));
    }

    [Theory]
    [InlineData(@"..\part.ipt")]
    [InlineData("../part.ipt")]
    [InlineData("sub/part.ipt")]
    [InlineData(@"C:\elsewhere\part.ipt")]
    [InlineData("")]
    public void ResolveFromWorkspace_refuses_a_path_outside_or_nested_in_the_workspace(string relativePath)
    {
        var asked = false;
        var result = Resolve([ManifestEntry(relativePath: relativePath)], fileExists: _ => asked = true);
        Assert.Null(result.Target);
        Assert.Equal(UndoTargetRecovery.UnsafePath, result.Outcome);
        Assert.False(asked); // never probed a path outside the workspace
    }

    [Fact]
    public void ResolveFromWorkspace_refuses_when_the_checked_out_file_is_missing()
    {
        var result = Resolve([ManifestEntry()], fileExists: _ => false);
        Assert.Null(result.Target);
        Assert.Equal(UndoTargetRecovery.FileMissing, result.Outcome);
    }
}
