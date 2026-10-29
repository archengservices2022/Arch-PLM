using Arch.CadConnect.Core.Diagnostics;
using Arch.CadConnect.Core.Session;

namespace Arch.CadConnect.Core.Tests.Diagnostics;

/// <summary>Collects events in memory.</summary>
internal sealed class RecordingSink : IDiagnosticsSink
{
    public List<DiagnosticEvent> Events { get; } = new();

    public void Write(DiagnosticEvent diagnosticEvent) => Events.Add(diagnosticEvent);

    public object? Field(DiagnosticEvent e, string name) => e.Fields.FirstOrDefault(f => f.Name == name).Value;
}

internal sealed class ThrowingSink : IDiagnosticsSink
{
    public int Calls { get; private set; }

    public void Write(DiagnosticEvent diagnosticEvent)
    {
        Calls++;
        throw new IOException("disk full");
    }
}

internal sealed class FixedTime(DateTimeOffset now) : TimeProvider
{
    public DateTimeOffset Now { get; set; } = now;

    public override DateTimeOffset GetUtcNow() => Now;
}

/// <summary>A session whose identity carries an email and whose bearer
///  value is a secret - neither may ever reach a log.</summary>
internal sealed class SecretBearingSession : IArchSession
{
    public const string Email = "engineer.private@example.com";
    public const string Bearer = "Bearer arch_dt_SUPERSECRETTOKEN0123456789";

    public ArchServerUri Server { get; } = ArchServerUri.Parse("http://localhost:3100");

    public ArchIdentity Identity { get; } = new("user-123", "Private Name", Email, "ADMIN", "org-9", "ARCH", "Arch Org");

    public DateTimeOffset ExpiresAtUtc => DateTimeOffset.MaxValue;

    public bool IsExpired(DateTimeOffset nowUtc) => false;

    public string AuthorizationHeaderValue() => Bearer;
}
