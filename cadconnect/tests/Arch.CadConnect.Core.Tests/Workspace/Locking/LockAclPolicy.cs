using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;

namespace Arch.CadConnect.Core.Tests.Workspace.Locking;

/// <summary>
/// CI-A1: the judgement applied to the machine-wide lock's DACL, kept pure so it
/// can be exercised with fixture descriptors. The product creates the lock with
/// the creator token's DEFAULT security, and that default DACL varies by
/// environment (UAC-filtered admin, standard user, elevated CI runner), so the
/// policy is an allow-list of the creator's own principals rather than an exact
/// expected ACL:
/// <list type="bullet">
/// <item>the DACL must be present (a NULL DACL admits everyone);</item>
/// <item>every ACE must be a plain (non-callback) common ACE - conditional
/// allow AND deny ACEs are rejected; plain deny ACEs are ignored;</item>
/// <item>every ALLOW ACE must name this user, SYSTEM, BUILTIN\Administrators,
/// OWNER RIGHTS, or this token's logon-session SID - with any rights;</item>
/// <item>broad groups (Everyone, Authenticated Users, Users, Interactive,
/// Anonymous, Guests, Network) and any other principal are rejected.</item>
/// </list>
/// </summary>
[SupportedOSPlatform("windows")]
internal static class LockAclPolicy
{
    private static readonly HashSet<SecurityIdentifier> Broad = new[]
    {
        WellKnownSidType.WorldSid, WellKnownSidType.AuthenticatedUserSid, WellKnownSidType.BuiltinUsersSid,
        WellKnownSidType.InteractiveSid, WellKnownSidType.AnonymousSid, WellKnownSidType.BuiltinGuestsSid,
        WellKnownSidType.NetworkSid,
    }.Select(t => new SecurityIdentifier(t, null)).ToHashSet();

    private static readonly SecurityIdentifier System = new(WellKnownSidType.LocalSystemSid, null);
    private static readonly SecurityIdentifier Administrators = new(WellKnownSidType.BuiltinAdministratorsSid, null);
    private static readonly SecurityIdentifier OwnerRights = new("S-1-3-4");

    /// <summary>Null when the DACL is acceptable; otherwise why it is not.</summary>
    public static string? Violation(RawSecurityDescriptor descriptor, SecurityIdentifier user, SecurityIdentifier? logonSid)
    {
        if (descriptor.DiscretionaryAcl is null)
        {
            return "NULL DACL";
        }

        var allowed = new HashSet<SecurityIdentifier> { user, System, Administrators, OwnerRights };
        if (logonSid is not null)
        {
            allowed.Add(logonSid);
        }

        foreach (var ace in descriptor.DiscretionaryAcl)
        {
            if (ace is not CommonAce common)
            {
                return $"unexpected ACE type {ace.AceType}";
            }
            if (common.IsCallback)
            {
                // Conditional (callback) ACEs of ANY kind - allow or deny - are
                // rejected: their effect depends on runtime claims, not the SID.
                return $"conditional {common.AceQualifier} ACE for {common.SecurityIdentifier}";
            }
            if (common.AceQualifier != AceQualifier.AccessAllowed)
            {
                continue; // plain deny ACEs only narrow access
            }
            if (Broad.Contains(common.SecurityIdentifier))
            {
                return $"broad group {common.SecurityIdentifier} granted 0x{common.AccessMask:X}";
            }
            if (!allowed.Contains(common.SecurityIdentifier))
            {
                return $"unknown principal {common.SecurityIdentifier} granted 0x{common.AccessMask:X}";
            }
        }
        return null;
    }
}

[SupportedOSPlatform("windows")]
public sealed class LockAclPolicyTests
{
    private const string User = "S-1-5-21-1111111111-2222222222-3333333333-1001";
    private const string OtherUser = "S-1-5-21-1111111111-2222222222-3333333333-1002";
    private const string LogonSid = "S-1-5-5-0-1169907";
    private const string OtherLogonSid = "S-1-5-5-0-4242";

    private static string? Judge(string sddl) =>
        LockAclPolicy.Violation(new RawSecurityDescriptor(sddl), new SecurityIdentifier(User), new SecurityIdentifier(LogonSid));

    [Theory]
    // Observed on a non-elevated (UAC-filtered admin) dev box.
    [InlineData("O:" + User + "D:(A;;0x1f0003;;;" + User + ")(A;;0x1f0003;;;BA)(A;;0x1f0003;;;SY)")]
    // Codex-observed standard-token default: OWNER RIGHTS read-control + logon SID full.
    [InlineData("O:" + User + "D:(A;;0x1f0003;;;" + User + ")(A;;0x1f0003;;;SY)(A;;RC;;;OW)(A;;0x1f0003;;;" + LogonSid + ")")]
    // Typical elevated-runner default: owner BA.
    [InlineData("O:BAD:(A;;0x1f0003;;;BA)(A;;0x1f0003;;;SY)(A;;0x120001;;;" + LogonSid + ")")]
    // A deny ACE for a broad group only narrows access.
    [InlineData("O:" + User + "D:(D;;0x1f0003;;;WD)(A;;0x1f0003;;;" + User + ")")]
    // An empty (present) DACL admits nobody.
    [InlineData("O:" + User + "D:")]
    public void Creator_only_default_acls_are_accepted(string sddl)
    {
        Assert.Null(Judge(sddl));
    }

    [Theory]
    [InlineData("D:(A;;0x1f0003;;;" + User + ")(A;;0x120001;;;WD)", "broad group")] // Everyone
    [InlineData("D:(A;;0x1f0003;;;" + User + ")(A;;0x120001;;;BU)", "broad group")] // BUILTIN\Users
    [InlineData("D:(A;;0x1f0003;;;" + User + ")(A;;0x120001;;;AU)", "broad group")] // Authenticated Users
    [InlineData("D:(A;;0x1f0003;;;" + User + ")(A;;0x120001;;;IU)", "broad group")] // Interactive
    [InlineData("D:(A;;0x1f0003;;;" + User + ")(A;;0x120001;;;AN)", "broad group")] // Anonymous
    [InlineData("D:(A;;0x1f0003;;;" + User + ")(A;;0x120001;;;BG)", "broad group")] // Guests
    [InlineData("D:(A;;0x1f0003;;;" + User + ")(A;;0x120001;;;NU)", "broad group")] // Network
    [InlineData("D:(A;;0x1f0003;;;" + User + ")(A;;0x1f0003;;;" + OtherUser + ")", "unknown principal")]
    [InlineData("D:(A;;0x1f0003;;;" + User + ")(A;;0x1f0003;;;" + OtherLogonSid + ")", "unknown principal")]
    [InlineData("D:NO_ACCESS_CONTROL", "NULL DACL")]
    // Conditional (callback) ACEs are rejected whether they allow or deny.
    [InlineData("D:(A;;0x1f0003;;;" + User + ")(XD;;0x1f0003;;;WD;(Member_of {SID(BA)}))", "conditional AccessDenied")]
    [InlineData("D:(A;;0x1f0003;;;" + User + ")(XA;;0x1f0003;;;" + User + ";(Member_of {SID(BA)}))", "conditional AccessAllowed")]
    public void Broad_unknown_or_missing_acls_are_rejected(string dacl, string reason)
    {
        var violation = Judge("O:" + User + dacl);
        Assert.NotNull(violation);
        Assert.Contains(reason, violation, StringComparison.Ordinal);
    }

    [Fact]
    public void A_descriptor_without_any_dacl_is_rejected()
    {
        Assert.Equal("NULL DACL", Judge("O:" + User));
    }
}
