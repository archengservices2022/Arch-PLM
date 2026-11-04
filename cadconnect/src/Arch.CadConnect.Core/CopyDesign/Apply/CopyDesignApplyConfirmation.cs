using System.Security.Cryptography;
using System.Text;

namespace Arch.CadConnect.Core.CopyDesign.Apply;

/// <summary>ONE row of the Apply confirmation - built from the EXACT mapped
///  request entry the orchestrator will send, never reconstructed from file
///  names independently.</summary>
public sealed record CopyDesignApplyConfirmationRow(
    CopyDesignApplyEntryAction Action,
    CadDocumentType DocumentType,
    string SourceFileName,
    string? SourceDocumentNumber,
    /// <summary>COPY: the new file name. REUSE: <c>null</c> (unchanged).</summary>
    string? DestinationFileName,
    /// <summary>COPY: the proposed NEW document number. REUSE: <c>null</c>.</summary>
    string? DestinationDocumentNumber,
    /// <summary>COPY: the destination folder. REUSE: <c>null</c>.</summary>
    string? DestinationFolder);

/// <summary>
/// P6 Milestone 2: everything the MANDATORY Apply confirmation shows, plus
/// whether Apply may proceed at all. <see cref="Fingerprint"/> identifies the
/// exact mapping that was shown; the orchestrator recomputes it from the
/// mapping it is about to execute and refuses on any difference (see
/// <see cref="CopyDesignApplyOrchestrator.ExecuteAsync"/>), so what was
/// confirmed is provably what runs.
/// </summary>
public sealed record CopyDesignApplyConfirmation(
    IReadOnlyList<CopyDesignApplyConfirmationRow> Rows,
    IReadOnlyList<CopyDesignPlanIssue> Issues,
    IReadOnlyList<string> DestinationFolders,
    bool ModelFilesOnly,
    /// <summary><c>null</c> when the plan could not be mapped at all.</summary>
    string? Fingerprint,
    bool CanApply)
{
    public int CopyCount => Rows.Count(r => r.Action == CopyDesignApplyEntryAction.Copy);
    public int ReuseCount => Rows.Count(r => r.Action == CopyDesignApplyEntryAction.Reuse);
    public IEnumerable<CopyDesignPlanIssue> Blocking => Issues.Where(i => i.Severity == CopyDesignIssueSeverity.Blocking);
}

/// <summary>
/// P6 Milestone 2: builds the <see cref="CopyDesignApplyConfirmation"/> for a
/// plan. PURE apart from the injected <c>destinationExists</c> probe.
///
/// Apply is DISABLED (<see cref="CopyDesignApplyConfirmation.CanApply"/> =
/// false) when ANY of these hold:
///  - the plan is not executable (every classified reason is shown);
///  - an in-scope node is unresolved or still NeedsDecision (defensive - an
///    executable plan should never contain one);
///  - the plan cannot be mapped to a request (the SAME
///    <see cref="CopyDesignApplyRequestMapper"/> call the orchestrator makes);
///  - a COPY keeps its source file name, or proposes a document number that
///    canonically equals its own source's (case-insensitive, one trailing CAD
///    extension ignored - the server's Milestone 1 rule);
///  - two COPY entries of the same type propose canonically equal numbers;
///  - a COPY destination file already exists.
/// Uniqueness against OTHER existing Arch PLM documents can only be proven by
/// the server, which enforces it atomically at Apply time - stated as Info.
/// </summary>
public static class CopyDesignApplyConfirmationBuilder
{
    /// <summary>The confirmation's mapping uses a placeholder idempotency key;
    ///  the key is deliberately NOT part of <see cref="Fingerprint"/>, so the
    ///  real attempt's key (minted only after confirmation) maps identically.</summary>
    private const string ConfirmationMappingKey = "confirmation-preview";

    private static readonly string[] RecognizedCadExtensions = { ".ipt", ".iam", ".idw", ".dwg", ".ipn" };

    public static CopyDesignApplyConfirmation Build(CopyDesignPlan plan, Func<string, bool> destinationExists)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(destinationExists);

        var issues = CopyDesignPlanIssues.Collect(plan).ToList();
        var rows = new List<CopyDesignApplyConfirmationRow>();
        string? fingerprint = null;
        var includeDrawings = !plan.ModelFilesOnlyAcknowledged;

        // Defensive: never trust IsExecutable alone for the nodes Apply will
        // actually touch.
        foreach (var node in plan.Nodes.Where(n => IsInScope(n, includeDrawings)))
        {
            if (!node.IsResolved || node.ProposedAction == CopyDesignAction.NeedsDecision)
            {
                AddOnce(issues, CopyDesignIssueSeverity.Blocking, node.SourceFileName,
                    "This file is unresolved or still needs a decision - Apply is not possible.");
            }
        }

        if (plan.IsExecutable)
        {
            var mapping = CopyDesignApplyRequestMapper.Map(plan, ConfirmationMappingKey, label: null, includeDrawings);
            if (!mapping.Success)
            {
                issues.Add(new CopyDesignPlanIssue(CopyDesignIssueSeverity.Blocking, null,
                    "The plan could not be mapped to an Apply request: " + mapping.FailureReason));
            }
            else
            {
                fingerprint = ComputeFingerprint(mapping.Request!, plan.ModelFilesOnlyAcknowledged);
                foreach (var mapped in mapping.Request!.Entries)
                {
                    rows.Add(ToRow(mapped));
                }
                AddRowIssues(rows, mapping.Request.Entries, issues, destinationExists);
            }
        }

        issues.Add(new CopyDesignPlanIssue(CopyDesignIssueSeverity.Info, null,
            "Uniqueness against existing Arch PLM documents is enforced by the server when Apply runs."));

        var folders = rows.Where(r => r.DestinationFolder is not null).Select(r => r.DestinationFolder!)
            .Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(f => f, StringComparer.OrdinalIgnoreCase).ToArray();
        var canApply = plan.IsExecutable && fingerprint is not null && !issues.Any(i => i.Severity == CopyDesignIssueSeverity.Blocking);
        return new CopyDesignApplyConfirmation(rows, issues, folders, plan.ModelFilesOnlyAcknowledged, fingerprint, canApply);
    }

    /// <summary>A stable identity for EXACTLY what a mapped request would do:
    ///  every entry's action, type, source identity, new number, new file name
    ///  and destination path, in request order, plus the model-files-only
    ///  mode. The idempotency key and label are deliberately excluded.</summary>
    public static string ComputeFingerprint(CopyDesignApplyRequest request, bool modelFilesOnly)
    {
        ArgumentNullException.ThrowIfNull(request);
        var sb = new StringBuilder("arch-copy-design-confirmation.v1\n");
        sb.Append("modelFilesOnly=").Append(modelFilesOnly ? '1' : '0').Append('\n');
        foreach (var mapped in request.Entries)
        {
            var entry = mapped.Entry;
            if (entry.Action == CopyDesignApplyEntryAction.Copy)
            {
                var c = entry.Copy!;
                sb.Append("COPY\u001f").Append(c.DocumentType).Append('\u001f').Append(c.SourceCadDocumentId).Append('\u001f')
                    .Append(c.SourceFileVersionId).Append('\u001f').Append(c.NewDocumentNumber).Append('\u001f')
                    .Append(c.NewFileName).Append('\u001f').Append(mapped.Node.ProposedDestinationAbsolutePath).Append('\n');
            }
            else
            {
                sb.Append("REUSE\u001f").Append(mapped.Node.DocumentType).Append('\u001f').Append(entry.Reuse!.CadDocumentId).Append('\n');
            }
        }
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString()))).ToLowerInvariant();
    }

    /// <summary>The server's Milestone 1 canonical document-number key
    ///  (web/app/lib/document-number-canonical.ts): trim, strip ONE trailing
    ///  recognized CAD extension (case-insensitive), trim, ignore case.</summary>
    public static string CanonicalDocumentNumberKey(string documentNumber)
    {
        ArgumentNullException.ThrowIfNull(documentNumber);
        var value = documentNumber.Trim();
        foreach (var extension in RecognizedCadExtensions)
        {
            if (value.Length > extension.Length && value.EndsWith(extension, StringComparison.OrdinalIgnoreCase))
            {
                value = value[..^extension.Length];
                break;
            }
        }
        return value.Trim().ToLowerInvariant();
    }

    private static bool IsInScope(CopyDesignNode node, bool includeDrawings) =>
        node.DocumentType is CadDocumentType.Ipt or CadDocumentType.Iam
        || (includeDrawings && node.DocumentType is CadDocumentType.Idw or CadDocumentType.Dwg);

    private static CopyDesignApplyConfirmationRow ToRow(CopyDesignApplyMappedEntry mapped)
    {
        var node = mapped.Node;
        if (mapped.Entry.Action == CopyDesignApplyEntryAction.Copy)
        {
            var copy = mapped.Entry.Copy!;
            return new CopyDesignApplyConfirmationRow(
                CopyDesignApplyEntryAction.Copy, copy.DocumentType, node.SourceFileName, node.SourceDocumentNumber,
                copy.NewFileName, copy.NewDocumentNumber, Path.GetDirectoryName(node.ProposedDestinationAbsolutePath));
        }
        return new CopyDesignApplyConfirmationRow(
            CopyDesignApplyEntryAction.Reuse, node.DocumentType, node.SourceFileName, node.SourceDocumentNumber,
            DestinationFileName: null, DestinationDocumentNumber: null, DestinationFolder: null);
    }

    private static void AddRowIssues(
        IReadOnlyList<CopyDesignApplyConfirmationRow> rows,
        IReadOnlyList<CopyDesignApplyMappedEntry> mapped,
        List<CopyDesignPlanIssue> issues,
        Func<string, bool> destinationExists)
    {
        for (var i = 0; i < rows.Count; i++)
        {
            var row = rows[i];
            if (row.Action != CopyDesignApplyEntryAction.Copy)
            {
                continue;
            }
            if (string.Equals(row.DestinationFileName, row.SourceFileName, StringComparison.OrdinalIgnoreCase))
            {
                issues.Add(new CopyDesignPlanIssue(CopyDesignIssueSeverity.Blocking, row.SourceFileName,
                    $"The destination file name \"{row.DestinationFileName}\" is unchanged from the source - a COPY is a new identity and must be renamed."));
            }
            if (row.SourceDocumentNumber is null)
            {
                issues.Add(new CopyDesignPlanIssue(CopyDesignIssueSeverity.Warning, row.SourceFileName,
                    "The source document number is not known locally; the server will still reject any colliding number."));
            }
            else if (CanonicalDocumentNumberKey(row.SourceDocumentNumber) == CanonicalDocumentNumberKey(row.DestinationDocumentNumber!))
            {
                issues.Add(new CopyDesignPlanIssue(CopyDesignIssueSeverity.Blocking, row.SourceFileName,
                    $"The new document number \"{row.DestinationDocumentNumber}\" is the same as the source's \"{row.SourceDocumentNumber}\" "
                    + "(ignoring case and the file extension) - it would collide with the source document."));
            }
            var destinationPath = mapped[i].Node.ProposedDestinationAbsolutePath;
            if (!string.IsNullOrWhiteSpace(destinationPath) && destinationExists(destinationPath))
            {
                issues.Add(new CopyDesignPlanIssue(CopyDesignIssueSeverity.Blocking, row.SourceFileName,
                    $"The destination file \"{destinationPath}\" already exists - it will never be overwritten."));
            }
        }

        foreach (var group in rows.Where(r => r.Action == CopyDesignApplyEntryAction.Copy)
                     .GroupBy(r => (CanonicalDocumentNumberKey(r.DestinationDocumentNumber!), r.DocumentType))
                     .Where(g => g.Count() > 1))
        {
            issues.Add(new CopyDesignPlanIssue(CopyDesignIssueSeverity.Blocking, null,
                $"{group.Count()} files would receive the same {group.Key.DocumentType} document number "
                + $"({string.Join(", ", group.Select(r => $"\"{r.DestinationDocumentNumber}\""))}) - every COPY needs a distinct number."));
        }
    }

    private static void AddOnce(List<CopyDesignPlanIssue> issues, CopyDesignIssueSeverity severity, string? source, string message)
    {
        if (!issues.Any(i => i.Severity == severity && i.SourceFileName == source && i.Message == message))
        {
            issues.Add(new CopyDesignPlanIssue(severity, source, message));
        }
    }
}

/// <summary>P6 Milestone 2: the confirmation as deterministic text - shown in
///  the Apply confirmation dialog and copyable as acceptance evidence.</summary>
public static class CopyDesignApplyConfirmationTextReport
{
    private const string Rule = "============================================================";

    public static string Render(CopyDesignApplyConfirmation confirmation)
    {
        ArgumentNullException.ThrowIfNull(confirmation);
        var sb = new StringBuilder();
        sb.AppendLine(Rule);
        sb.AppendLine("APPLY COPY DESIGN - CONFIRM EXACT MAPPING");
        sb.AppendLine(Rule);
        sb.AppendLine("Status: " + (confirmation.CanApply ? "READY TO APPLY" : "BLOCKED - Apply is disabled"));
        if (confirmation.ModelFilesOnly)
        {
            sb.AppendLine("MODE: MODEL FILES ONLY - DRAWINGS: NOT INCLUDED");
        }
        sb.AppendLine($"Files: {confirmation.Rows.Count} ({confirmation.CopyCount} COPY, {confirmation.ReuseCount} REUSE)");
        sb.AppendLine("Destination folder(s):");
        if (confirmation.DestinationFolders.Count == 0)
        {
            sb.AppendLine("  (none)");
        }
        foreach (var folder in confirmation.DestinationFolders)
        {
            sb.AppendLine("  " + folder);
        }
        sb.AppendLine();
        sb.AppendLine("Mapping:");
        if (confirmation.Rows.Count == 0)
        {
            sb.AppendLine("  (no mapping - see the blocking errors below)");
        }
        for (var i = 0; i < confirmation.Rows.Count; i++)
        {
            var r = confirmation.Rows[i];
            var type = r.DocumentType.ToString().ToUpperInvariant();
            if (r.Action == CopyDesignApplyEntryAction.Copy)
            {
                sb.AppendLine($"  [{i + 1}] COPY  {type}  {r.SourceFileName} → {r.DestinationFileName}");
                sb.AppendLine($"        Source document number:  {r.SourceDocumentNumber ?? "(unknown)"}");
                sb.AppendLine($"        New document number:     {r.DestinationDocumentNumber}");
                sb.AppendLine($"        Destination folder:      {r.DestinationFolder}");
            }
            else
            {
                sb.AppendLine($"  [{i + 1}] REUSE {type}  {r.SourceFileName} (unchanged - existing document reused)");
                sb.AppendLine($"        Document number:         {r.SourceDocumentNumber ?? "(unknown)"}");
            }
        }
        foreach (var (severity, heading) in new[]
                 {
                     (CopyDesignIssueSeverity.Blocking, "Blocking errors"),
                     (CopyDesignIssueSeverity.Warning, "Warnings"),
                     (CopyDesignIssueSeverity.Info, "Information"),
                 })
        {
            var group = confirmation.Issues.Where(x => x.Severity == severity).ToArray();
            sb.AppendLine();
            sb.AppendLine($"{heading}: {(group.Length == 0 ? "(none)" : "")}".TrimEnd());
            foreach (var issue in group)
            {
                sb.AppendLine($"  - [{CopyDesignPlanIssues.Label(severity)}] {(issue.SourceFileName is null ? "" : issue.SourceFileName + ": ")}{issue.Message}");
            }
        }
        sb.AppendLine();
        sb.AppendLine("Confirmation id: " + (confirmation.Fingerprint is null ? "(none)" : confirmation.Fingerprint[..16]));
        sb.AppendLine("Source files are never modified. Nothing is committed or released automatically.");
        sb.Append(Rule);
        return sb.ToString();
    }
}
