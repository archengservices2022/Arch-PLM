using Arch.CadConnect.Core.Diagnostics;

namespace Arch.CadConnect.Core.Tests.Diagnostics;

/// <summary>M4.2: every field kind fails closed, and text/paths are scrubbed
///  of credential- and email-shaped content.</summary>
public class DiagnosticValueSanitizerTests
{
    [Theory]
    [InlineData("cmvsengbv001vn45gkrmh5z8r")]
    [InlineData("cadconnect-p6c-6554cba9289e42768165fe56549f2152")]
    [InlineData("op:1.2_3")]
    public void Ids_that_look_like_ids_are_kept(string id)
    {
        Assert.Equal(id, DiagnosticValueSanitizer.SanitizeId(id));
    }

    [Theory]
    [InlineData("has space")]
    [InlineData("a@b.com")]
    [InlineData("Bearer x")]
    [InlineData("")]
    [InlineData("id\nwith-newline")]
    public void Anything_else_in_an_id_field_is_replaced(string id)
    {
        Assert.Equal(DiagnosticValueSanitizer.Invalid, DiagnosticValueSanitizer.SanitizeId(id));
    }

    [Theory]
    [InlineData("http://localhost:3100", "http://localhost:3100")]
    [InlineData("http://LOCALHOST:3100/api/x?token=abc", "http://localhost:3100")]
    [InlineData("https://user:password@plm.example.com/path", "https://plm.example.com")]
    [InlineData("https://plm.example.com:443", "https://plm.example.com")]
    public void Origins_are_reduced_to_scheme_host_and_port(string input, string expected)
    {
        Assert.Equal(expected, DiagnosticValueSanitizer.SanitizeOrigin(input));
    }

    [Theory]
    [InlineData("ftp://localhost:3100")]
    [InlineData("not a url")]
    [InlineData("file:///C:/x")]
    public void Non_http_origins_are_replaced(string input)
    {
        Assert.Equal(DiagnosticValueSanitizer.Invalid, DiagnosticValueSanitizer.SanitizeOrigin(input));
    }

    [Fact]
    public void Paths_mask_the_user_profile()
    {
        Assert.Equal(@"%USERPROFILE%\Documents\a.ipt",
            DiagnosticValueSanitizer.SanitizePath(@"C:\Users\Someone\Documents\a.ipt", userProfile: @"C:\Users\Someone"));
        Assert.Equal(@"%USERPROFILE%\AppData\x.iam",
            DiagnosticValueSanitizer.SanitizePath(@"D:\Users\other.user\AppData\x.iam"));
        Assert.Equal(@"D:\Projects\Workspace\ROOT.iam",
            DiagnosticValueSanitizer.SanitizePath(@"D:\Projects\Workspace\ROOT.iam"));
    }

    [Fact]
    public void Paths_never_carry_an_email()
    {
        var path = DiagnosticValueSanitizer.SanitizePath(@"D:\Shared\engineer.private@example.com\a.ipt");

        Assert.DoesNotContain("engineer.private@example.com", path);
        Assert.Contains("[email]", path);
    }

    [Theory]
    [InlineData("Authorization: Bearer arch_dt_SECRET123", "arch_dt_SECRET123")]
    [InlineData("bearer abc.def.ghi", "abc.def.ghi")]
    [InlineData("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl here", "eyJhbGciOiJIUzI1NiJ9")]
    [InlineData("password=hunter2", "hunter2")]
    [InlineData("PWD: hunter2", "hunter2")]
    [InlineData("api_key=AKIA123456", "AKIA123456")]
    [InlineData("session-token: s3cr3t", "s3cr3t")]
    [InlineData("secret=xyz", "xyz")]
    [InlineData("Cookie: sid=abc123", "abc123")]
    [InlineData("Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz")]   // the scheme word does not shield the credential
    [InlineData("authorization=Digest abc123def", "abc123def")]
    [InlineData("stray arch_dt_SESSIONVALUE99 in a message", "arch_dt_SESSIONVALUE99")]
    [InlineData("contact engineer.private@example.com now", "engineer.private@example.com")]
    public void Text_is_scrubbed_of_credentials_and_emails(string input, string secret)
    {
        var text = DiagnosticValueSanitizer.SanitizeText(input);

        Assert.DoesNotContain(secret, text);
    }

    [Theory]
    [InlineData("ARCH-TEST-001.ipt")]
    [InlineData("M3S-P6D-REAL-ROOT")]
    [InlineData("T6X-REAL-PART-A")]
    public void Document_numbers_are_kept(string documentNumber)
    {
        Assert.Equal(documentNumber, DiagnosticValueSanitizer.SanitizeText(documentNumber));
    }

    [Theory]
    [InlineData("Succeeded")]
    [InlineData("models.verify")]
    [InlineData("Resume Copy Design")]
    [InlineData("ArchApiException")]
    [InlineData("copy-design-already-running")]
    public void Codes_that_look_like_codes_are_kept(string code)
    {
        Assert.Equal(code, DiagnosticValueSanitizer.SanitizeCode(code));
    }

    [Theory]
    [InlineData("The reservation request failed: connection reset by peer, retry later")]   // a sentence (too long)
    [InlineData("failed: x")]                                                              // punctuation
    [InlineData("engineer@example.com")]
    [InlineData("C:\\Users\\Someone\\a.ipt")]
    [InlineData("line\nbreak")]
    [InlineData("Bearer=abc")]
    [InlineData("")]
    public void Anything_but_a_short_token_in_a_code_field_is_replaced(string value)
    {
        Assert.Equal(DiagnosticValueSanitizer.Invalid, DiagnosticValueSanitizer.SanitizeCode(value));
    }

    [Fact]
    public void Document_numbers_are_bounded_short()
    {
        Assert.Equal(128, DiagnosticValueSanitizer.MaxTextLength);
        Assert.True(DiagnosticValueSanitizer.SanitizeText(new string('N', 1000))!.Length <= 129);
    }

    [Fact]
    public void Text_is_one_line_and_capped()
    {
        var text = DiagnosticValueSanitizer.SanitizeText("a\r\nb\tc" + new string('x', 2000))!;

        Assert.DoesNotContain('\n', text);
        Assert.DoesNotContain('\r', text);
        Assert.True(text.Length <= DiagnosticValueSanitizer.MaxTextLength + 1);
    }

    [Fact]
    public void Numbers_and_flags_accept_only_their_own_type()
    {
        Assert.Equal(5L, DiagnosticValueSanitizer.Sanitize(DiagnosticField.Number("copyCount", 5)));
        Assert.Equal(true, DiagnosticValueSanitizer.Sanitize(DiagnosticField.Flag("verified", true)));
        Assert.Null(DiagnosticValueSanitizer.Sanitize(new DiagnosticField("copyCount", DiagnosticFieldKind.Number, "5")));
        Assert.Null(DiagnosticValueSanitizer.Sanitize(new DiagnosticField("verified", DiagnosticFieldKind.Flag, "true")));
    }
}
