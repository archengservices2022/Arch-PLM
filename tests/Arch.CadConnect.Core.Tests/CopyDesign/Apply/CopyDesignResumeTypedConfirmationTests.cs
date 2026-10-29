using Arch.CadConnect.Core.CopyDesign.Apply;

namespace Arch.CadConnect.Core.Tests.CopyDesign.Apply;

/// <summary>
/// M4.1 T6 follow-up: the typed <c>RESUME &lt;key suffix&gt;</c> phrase that
/// unlocks Resume Copy Design - the last 6 characters of the idempotency key
/// in their original case, never a file count; a missing, malformed or
/// too-short key is never confirmable.
/// </summary>
public class CopyDesignResumeTypedConfirmationTests
{
    /// <summary>The key of the T6 incident operation.</summary>
    private const string RealKey = "cadconnect-p6c-6554cba9289e42768165fe56549f2152";

    private static CopyDesignResumeTypedConfirmation.Prepared Prepare(string? key) => CopyDesignResumeTypedConfirmation.Prepare(key);

    [Fact]
    public void The_phrase_is_RESUME_plus_the_last_six_characters_of_the_key()
    {
        var prepared = Prepare(RealKey);

        Assert.True(prepared.CanConfirm);
        Assert.Equal("RESUME 9f2152", prepared.Phrase);
    }

    [Fact]
    public void The_suffix_keeps_its_original_case()
    {
        var prepared = Prepare("external-key-0000AbC123");

        Assert.Equal("RESUME AbC123", prepared.Phrase);
        Assert.True(CopyDesignResumeTypedConfirmation.IsSatisfied(prepared, "RESUME AbC123"));
        Assert.False(CopyDesignResumeTypedConfirmation.IsSatisfied(prepared, "RESUME ABC123"));
        Assert.False(CopyDesignResumeTypedConfirmation.IsSatisfied(prepared, "RESUME abc123"));
    }

    [Theory]
    [InlineData("RESUME 9f2152")]
    [InlineData("  RESUME 9f2152 ")]
    [InlineData("\tRESUME 9f2152\r\n")]
    public void The_exact_phrase_is_accepted_ignoring_only_leading_and_trailing_whitespace(string typed)
    {
        Assert.True(CopyDesignResumeTypedConfirmation.IsSatisfied(Prepare(RealKey), typed));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("resume 9f2152")]
    [InlineData("Resume 9f2152")]
    [InlineData("RESUME 9F2152")]          // suffix case matters
    [InlineData("RESUME")]
    [InlineData("RESUME f2152")]           // too few characters
    [InlineData("RESUME 49f2152")]         // too many
    [InlineData("RESUME 9f215")]
    [InlineData("RESUME  9f2152")]
    [InlineData("RESUME9f2152")]
    [InlineData("RESUME " + RealKey)]      // the full key is not the phrase
    [InlineData("RESUME 4")]               // never a count
    [InlineData("APPLY 9f2152")]           // the other dialogs' verbs never unlock Resume
    [InlineData("RECOVER 9f2152")]
    [InlineData("RESUME ９f2152")]          // full-width look-alike digit
    public void Any_other_text_does_not_enable_Resume(string? typed)
    {
        Assert.False(CopyDesignResumeTypedConfirmation.IsSatisfied(Prepare(RealKey), typed));
    }

    [Fact]
    public void One_operations_phrase_does_not_unlock_another()
    {
        var other = Prepare("cadconnect-p6c-00000000000000000000000000aaaaaa");

        Assert.False(CopyDesignResumeTypedConfirmation.IsSatisfied(other, "RESUME 9f2152"));
        Assert.True(CopyDesignResumeTypedConfirmation.IsSatisfied(other, "RESUME aaaaaa"));
    }

    [Theory]
    [InlineData(null)]                                   // missing
    [InlineData("")]
    [InlineData("abc")]                                   // too short
    [InlineData("cadconnect-1234")]                       // 15 characters
    [InlineData("cadconnect-p6c 6554cba9289e42768165fe56549f2152")]  // whitespace
    [InlineData("cadconnect-p6c-6554cba9289e4276\t165fe56549f2152")]  // control character
    [InlineData("cadconnect-p6c-6554cba9289e42768165fé56549f2152")]   // non-ASCII
    [InlineData("cadconnect-p6c-6554cba9289e42768165fe5654-f2152")]   // suffix not letters/digits
    [InlineData("cadconnect-p6c-6554cba9289e42768165fe56549f215 ")]
    public void A_missing_invalid_or_too_short_key_is_never_confirmable(string? key)
    {
        var prepared = Prepare(key);

        Assert.False(prepared.CanConfirm);
        Assert.Null(prepared.Phrase);
        Assert.NotNull(prepared.Reason);
        Assert.False(CopyDesignResumeTypedConfirmation.IsSatisfied(prepared, "RESUME 9f2152"));
        Assert.False(CopyDesignResumeTypedConfirmation.IsSatisfied(prepared, "RESUME "));
    }

    [Fact]
    public void A_key_of_exactly_the_minimum_length_is_accepted()
    {
        var key = new string('k', CopyDesignResumeTypedConfirmation.MinimumKeyLength - 6) + "Ab1234";

        Assert.True(Prepare(key).CanConfirm);
        Assert.Equal("RESUME Ab1234", Prepare(key).Phrase);
    }

    [Fact]
    public void A_null_prepared_confirmation_is_rejected()
    {
        Assert.Throws<ArgumentNullException>(() => CopyDesignResumeTypedConfirmation.IsSatisfied(null!, "RESUME 9f2152"));
    }
}
