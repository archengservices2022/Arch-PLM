using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using Arch.CadConnect.Core.Session;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Api.Workspace;

/// <summary>
/// The CAD Connect client's calls to the existing P3C checkout endpoints,
/// bearer-authenticated (P4C). Same hardening as
/// <see cref="WorkspacePlanClient"/> / <see cref="HttpContentDownloader"/>:
/// origin-bound bearer, ALL redirects refused, non-2xx rejected, one timeout
/// across headers + body. <c>cadDocumentId</c> is authoritative; the client
/// never sends a filename or document number as identity.
///
/// The server is the sole authority - these methods just relay its decision.
/// </summary>
public sealed class CheckoutHttpClient
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly ArchServerUri _server;
    private readonly IArchSession _session;
    private readonly HttpClient _http;
    private readonly TimeSpan _timeout;

    public CheckoutHttpClient(ArchServerUri server, IArchSession session, HttpClient http, TimeSpan? timeout = null)
    {
        _server = server ?? throw new ArgumentNullException(nameof(server));
        _session = session ?? throw new ArgumentNullException(nameof(session));
        _http = http ?? throw new ArgumentNullException(nameof(http));
        _timeout = timeout ?? TimeSpan.FromSeconds(30);
    }

    public static CheckoutHttpClient Create(ArchServerUri server, IArchSession session, TimeSpan? timeout = null)
        => new(server, session, HardenedHttp.NewClient(), timeout);

    /// <summary>
    /// <c>POST /api/cad-documents/:id/checkout</c> - request an exclusive
    /// server checkout. Idempotent as the same user (200 "already-mine").
    /// </summary>
    /// <exception cref="CheckoutConflictException">another user holds it (409).</exception>
    /// <exception cref="ArchApiException">403 role / 404 tenant / 422 / transport.</exception>
    public async Task<CheckoutResult> RequestCheckoutAsync(string cadDocumentId, CancellationToken ct = default)
    {
        var (status, text) = await SendAsync(HttpMethod.Post, Path(cadDocumentId, "checkout"), null, ct).ConfigureAwait(false);
        if (status is HttpStatusCode.OK or HttpStatusCode.Created)
        {
            var dto = Deserialize<CheckoutEnvelopeDto>(text);
            if (dto?.Checkout is null)
            {
                throw Server("checkout response failed shape check");
            }
            // P6 M4.4 Package C: exactly the two answers the server gives, each
            // with its own status code. An unknown value is not a new checkout.
            var kind = (status, dto.Status) switch
            {
                (HttpStatusCode.Created, "created") => CheckoutOutcome.Created,
                (HttpStatusCode.OK, "already-mine") => CheckoutOutcome.AlreadyMine,
                _ => throw Server("checkout response reported an unknown status"),
            };
            // ROUND 5 (Codex HIGH): this is always a "this checkout is now
            // (or already) mine, for the document I asked about" result -
            // require the server's own echoed cadDocumentId to exactly match
            // the one requested, fail closed otherwise.
            RequireMatchingCadDocumentId(cadDocumentId, dto.Checkout.CadDocumentId);
            var checkedOutAt = RequireMine(dto.Checkout);
            return new CheckoutResult(
                Kind: kind,
                CheckoutId: dto.Checkout.Id,
                BaseFileVersionId: dto.Checkout.BaseFileVersionId,
                BaseVersionNumber: dto.Checkout.BaseVersionNumber,
                CheckedOutAt: checkedOutAt);
        }
        if (status == HttpStatusCode.Conflict)
        {
            var dto = TryDeserialize<CheckoutEnvelopeDto>(text);
            throw new CheckoutConflictException(
                dto?.Checkout?.CheckedOutBy?.Name, dto?.Checkout?.CheckedOutBy?.Email);
        }
        throw MapFailure((int)status, text);
    }

    /// <summary><c>GET /api/cad-documents/:id/checkout</c> - read-only status.</summary>
    public Task<ServerCheckoutStatus> GetStatusAsync(string cadDocumentId, CancellationToken ct = default)
        => ReadStatusAsync(cadDocumentId, strict: false, ct);

    /// <summary>P6 M4.4 Package C: <see cref="GetStatusAsync"/> for a caller that
    ///  acts on "available" or "locked" as PROOF its local marker is stale - an
    ///  unknown state, or a "locked" for another document, throws instead of
    ///  reading as available.</summary>
    public Task<ServerCheckoutStatus> GetStatusStrictAsync(string cadDocumentId, CancellationToken ct = default)
        => ReadStatusAsync(cadDocumentId, strict: true, ct);

    private async Task<ServerCheckoutStatus> ReadStatusAsync(string cadDocumentId, bool strict, CancellationToken ct)
    {
        var (status, text) = await SendAsync(HttpMethod.Get, Path(cadDocumentId, "checkout"), null, ct).ConfigureAwait(false);
        if (status != HttpStatusCode.OK)
        {
            throw MapFailure((int)status, text);
        }
        var dto = Deserialize<CheckoutStatusDto>(text);
        if (strict && dto?.State is not ("available" or "mine" or "locked"))
        {
            throw Server("checkout status reported an unknown state");
        }
        if (strict)
        {
            RequireConsistentStatus(cadDocumentId, dto!);
        }
        var state = dto?.State switch
        {
            "mine" => ServerCheckoutState.Mine,
            "locked" => ServerCheckoutState.Locked,
            _ => ServerCheckoutState.Available,
        };

        // Fail closed at the boundary: an authoritative "mine" response is only
        // usable if it carries a COMPLETE checkout identity. A "mine" without a
        // non-blank checkout id and base fileVersionId is a malformed response -
        // never accept a partial "mine".
        if (state == ServerCheckoutState.Mine)
        {
            if (string.IsNullOrWhiteSpace(dto?.Checkout?.Id)
                || string.IsNullOrWhiteSpace(dto?.Checkout?.BaseFileVersionId))
            {
                throw Server("checkout status reported 'mine' without a complete checkout identity");
            }
            // ROUND 5 (Codex HIGH - checkout authority must bind to exact
            // parent cadDocumentId): the DTO carries the server's own echoed
            // cadDocumentId but it was previously discarded here. A malformed
            // / inconsistent response with valid-looking checkout/base ids for
            // the WRONG parent could otherwise be accepted as authority for
            // THIS document. Require exact ordinal equality; never normalize
            // or trim and accept.
            RequireMatchingCadDocumentId(cadDocumentId, dto?.Checkout?.CadDocumentId);
        }

        return new ServerCheckoutStatus(
            state,
            dto?.Checkout?.CheckedOutBy?.Name,
            dto?.Checkout?.CheckedOutBy?.Email,
            CheckoutId: dto?.Checkout?.Id,
            BaseFileVersionId: dto?.Checkout?.BaseFileVersionId,
            BaseVersionNumber: dto?.Checkout?.BaseVersionNumber ?? 0,
            CheckedOutById: dto?.Checkout?.CheckedOutById,
            CheckedOutAt: ParseInstant(dto?.Checkout?.CheckedOutAt));
    }

    /// <summary>P6 M4.4 Package C: a strict status is acted on as proof, so its
    ///  body must be what its state says: nothing checked out for "available",
    ///  the caller's own complete checkout for "mine", and someone else's for
    ///  "locked". Anything contradictory proves nothing.</summary>
    private void RequireConsistentStatus(string cadDocumentId, CheckoutStatusDto dto)
    {
        switch (dto.State)
        {
            case "available":
                if (dto.Checkout is not null)
                {
                    throw Server("checkout status reported 'available' with a checkout");
                }
                break;

            case "mine":
                RequireMatchingCadDocumentId(cadDocumentId, dto.Checkout?.CadDocumentId);
                RequireMine(dto.Checkout!);
                break;

            default:
                if (dto.Checkout is null)
                {
                    throw Server("checkout status reported 'locked' without a checkout");
                }
                RequireMatchingCadDocumentId(cadDocumentId, dto.Checkout.CadDocumentId);
                RequireOthers(dto.Checkout);
                break;
        }
    }

    /// <summary>R10 correction (MAJOR 3): a "locked" answer clears a local marker,
    ///  so it must be another user's COMPLETE checkout, exactly as "mine" must be
    ///  this user's. The holder's name and email are display only and not required.</summary>
    private void RequireOthers(CheckoutDto checkout)
    {
        if (!WorkspaceManifest.IsWellFormedId(checkout.Id)
            || !WorkspaceManifest.IsWellFormedId(checkout.BaseFileVersionId)
            || checkout.BaseVersionNumber <= 0
            || !WorkspaceManifest.IsWellFormedId(checkout.CheckedOutById)
            || string.Equals(checkout.CheckedOutById, _session.Identity.UserId, StringComparison.Ordinal)
            || ParseInstant(checkout.CheckedOutAt) is null)
        {
            throw Server("checkout status reported 'locked' without another user's complete checkout");
        }
    }

    /// <summary>A complete checkout identity, held by this session's user.</summary>
    /// <returns>When the server says it was taken.</returns>
    private DateTimeOffset RequireMine(CheckoutDto checkout)
    {
        if (!WorkspaceManifest.IsWellFormedId(checkout.Id)
            || !WorkspaceManifest.IsWellFormedId(checkout.BaseFileVersionId)
            || checkout.BaseVersionNumber <= 0
            || !string.Equals(checkout.CheckedOutById, _session.Identity.UserId, StringComparison.Ordinal))
        {
            throw Server("checkout response is not this user's complete checkout");
        }
        return ParseInstant(checkout.CheckedOutAt) ?? throw Server("checkout response has no valid timestamp");
    }

    /// <summary>An ISO 8601 instant that says which instant it is: a value with no
    ///  offset does not, and is not read as local time.</summary>
    private static DateTimeOffset? ParseInstant(string? value)
    {
        var zoned = value is { Length: >= 20 } && (value[^1] == 'Z' || value[^6] is '+' or '-');
        return zoned && DateTimeOffset.TryParseExact(value, "yyyy-MM-dd'T'HH:mm:ss.FFFFFFFK", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed)
            ? parsed.ToUniversalTime()
            : null;
    }

    /// <summary>
    /// <c>POST /api/cad-documents/:id/checkout/undo</c> - the OWNER releases
    /// their checkout. Returns the base FileVersion id to restore locally.
    /// </summary>
    public async Task<UndoResult> UndoAsync(string cadDocumentId, string? reason, CancellationToken ct = default)
    {
        var body = reason is null ? "{}" : JsonSerializer.Serialize(new { reason }, Json);
        var (status, text) = await SendAsync(HttpMethod.Post, Path(cadDocumentId, "checkout/undo"), body, ct).ConfigureAwait(false);
        if (status != HttpStatusCode.OK)
        {
            throw MapFailure((int)status, text);
        }
        var dto = Deserialize<UndoDto>(text);
        if (dto is null || string.IsNullOrEmpty(dto.BaseFileVersionId))
        {
            throw Server("undo response failed shape check");
        }
        return new UndoResult(dto.CheckoutId, dto.BaseFileVersionId);
    }

    // ---- transport (mirrors WorkspacePlanClient) ------------------------

    private Uri Path(string cadDocumentId, string suffix)
    {
        var url = _server.ResolvePath($"/api/cad-documents/{Uri.EscapeDataString(cadDocumentId)}/{suffix}");
        if (!_server.MatchesOrigin(url))
        {
            throw new ArchApiException(ArchApiFailureKind.BadRequest,
                "Refusing to send an authenticated request to a different server.");
        }
        return url;
    }

    private async Task<(HttpStatusCode Status, string Body)> SendAsync(
        HttpMethod method, Uri url, string? jsonBody, CancellationToken ct)
    {
        using var timeoutCts = new CancellationTokenSource(_timeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeoutCts.Token);
        try
        {
            using var request = new HttpRequestMessage(method, url);
            request.Headers.Authorization = AuthenticationHeaderValue.Parse(_session.AuthorizationHeaderValue());
            request.Headers.Accept.ParseAdd("application/json");
            if (jsonBody is not null)
            {
                request.Content = new StringContent(jsonBody, Encoding.UTF8, "application/json");
            }

            using var response = await _http
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, linked.Token)
                .ConfigureAwait(false);

            if ((int)response.StatusCode is >= 300 and < 400)
            {
                throw new ArchApiException(ArchApiFailureKind.Server,
                    "Arch PLM returned an unexpected response.", (int)response.StatusCode, "unexpected redirect");
            }

            var bytes = await ReadCappedAsync(response.Content, linked.Token).ConfigureAwait(false);
            return (response.StatusCode, Encoding.UTF8.GetString(bytes));
        }
        catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested && !ct.IsCancellationRequested)
        {
            throw new ArchApiException(ArchApiFailureKind.Timeout, "The Arch PLM server did not respond in time.");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw new ArchApiException(ArchApiFailureKind.Network, "The request was cancelled.");
        }
        catch (HttpRequestException ex)
        {
            throw new ArchApiException(ArchApiFailureKind.Network,
                "Could not reach the Arch PLM server. Check the address and your network.",
                diagnostic: ex.GetType().Name, inner: ex);
        }
        catch (IOException ex)
        {
            throw new ArchApiException(ArchApiFailureKind.Network,
                "The connection to the Arch PLM server was lost.", diagnostic: ex.GetType().Name, inner: ex);
        }
    }

    private static async Task<byte[]> ReadCappedAsync(HttpContent content, CancellationToken ct)
    {
        const int max = 256 * 1024;
        await using var stream = await content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var buffer = new MemoryStream();
        var chunk = new byte[16384];
        int read;
        while ((read = await stream.ReadAsync(chunk, ct).ConfigureAwait(false)) > 0)
        {
            if (buffer.Length + read > max) { buffer.Write(chunk, 0, max - (int)buffer.Length); break; }
            buffer.Write(chunk, 0, read);
        }
        return buffer.ToArray();
    }

    private static T? TryDeserialize<T>(string body)
    {
        try { return JsonSerializer.Deserialize<T>(body, Json); }
        catch (JsonException) { return default; }
    }

    private static T Deserialize<T>(string body)
    {
        var value = TryDeserialize<T>(body);
        if (value is null)
        {
            throw Server("invalid json body");
        }
        return value;
    }

    private static ArchApiException Server(string diagnostic) => new(
        ArchApiFailureKind.Server, "Arch PLM returned an unexpected response. Please try again.", diagnostic: diagnostic);

    /// <summary>
    /// ROUND 5 (Codex HIGH - checkout authority must bind to exact parent
    /// cadDocumentId): for a Mine / checked-out-by-me result, the server's own
    /// echoed <c>checkout.cadDocumentId</c> MUST be present, non-blank, carry
    /// no leading/trailing whitespace, and be ORDINALLY equal to
    /// <paramref name="requestedCadDocumentId"/> - the id THIS client asked
    /// about, never inferred any other way. Missing, padded, malformed, or
    /// mismatched all fail closed identically as malformed/inconsistent
    /// server authority. The value is never trimmed or normalized before
    /// comparing - a padded id is rejected, never silently accepted after
    /// trimming.
    /// </summary>
    private static void RequireMatchingCadDocumentId(string requestedCadDocumentId, string? echoedCadDocumentId)
    {
        if (string.IsNullOrWhiteSpace(echoedCadDocumentId)
            || echoedCadDocumentId != echoedCadDocumentId.Trim()
            || !string.Equals(echoedCadDocumentId, requestedCadDocumentId, StringComparison.Ordinal))
        {
            throw Server("checkout response's cadDocumentId is missing, malformed, or does not match the requested document");
        }
    }

    internal static ArchApiException MapFailure(int code, string body)
    {
        var serverError = ExtractError(body);
        return code switch
        {
            400 => new ArchApiException(ArchApiFailureKind.BadRequest, serverError ?? "The request was rejected.", code),
            401 => new ArchApiException(ArchApiFailureKind.Unauthorized, serverError ?? "Your session is not valid. Sign in again.", code),
            403 => new ArchApiException(ArchApiFailureKind.Unauthorized, serverError ?? "Your role does not permit that operation.", code),
            404 => new ArchApiException(ArchApiFailureKind.NotFound, serverError ?? "That CAD document was not found in your organization.", code),
            409 or 422 => new ArchApiException(ArchApiFailureKind.Conflict, serverError ?? "The operation could not be completed.", code),
            413 => new ArchApiException(ArchApiFailureKind.BadRequest, "The upload was too large.", code),
            _ => new ArchApiException(ArchApiFailureKind.Server, "Arch PLM returned an unexpected response. Please try again.", code, $"http {code}"),
        };
    }

    internal static string? ExtractError(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.String)
            {
                var t = e.GetString()?.Trim();
                return string.IsNullOrEmpty(t) ? null : (t.Length > 300 ? t[..300] : t);
            }
        }
        catch (JsonException) { /* ignore */ }
        return null;
    }

    // ---- wire DTOs (server response shapes) ---------------------------

    private sealed record CheckoutEnvelopeDto(
        [property: JsonPropertyName("status")] string? Status,
        [property: JsonPropertyName("error")] string? Error,
        [property: JsonPropertyName("checkout")] CheckoutDto? Checkout);

    private sealed record CheckoutStatusDto(
        [property: JsonPropertyName("state")] string? State,
        [property: JsonPropertyName("checkout")] CheckoutDto? Checkout);

    private sealed record CheckoutDto(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("cadDocumentId")] string CadDocumentId,
        [property: JsonPropertyName("baseFileVersionId")] string BaseFileVersionId,
        [property: JsonPropertyName("baseVersionNumber")] int BaseVersionNumber,
        [property: JsonPropertyName("checkedOutBy")] HolderDto? CheckedOutBy,
        [property: JsonPropertyName("checkedOutById")] string? CheckedOutById = null,
        [property: JsonPropertyName("checkedOutAt")] string? CheckedOutAt = null);

    private sealed record HolderDto(
        [property: JsonPropertyName("name")] string? Name,
        [property: JsonPropertyName("email")] string? Email);

    private sealed record UndoDto(
        [property: JsonPropertyName("checkoutId")] string CheckoutId,
        [property: JsonPropertyName("baseFileVersionId")] string BaseFileVersionId);
}

public enum CheckoutOutcome { Created, AlreadyMine }

public sealed record CheckoutResult(
    CheckoutOutcome Kind, string CheckoutId, string BaseFileVersionId, int BaseVersionNumber, DateTimeOffset CheckedOutAt);

public sealed record UndoResult(string CheckoutId, string BaseFileVersionId);

/// <summary>Another user holds the server checkout (409). Carries only the
///  tenant-safe holder display info the server allows.</summary>
public sealed class CheckoutConflictException(string? holderName, string? holderEmail)
    : Exception(BuildMessage(holderName, holderEmail))
{
    public string? HolderName { get; } = holderName;
    public string? HolderEmail { get; } = holderEmail;

    private static string BuildMessage(string? name, string? email)
    {
        var who = !string.IsNullOrWhiteSpace(name) ? name
            : !string.IsNullOrWhiteSpace(email) ? email
            : "another user";
        return $"This document is checked out by {who}.";
    }
}

internal static class HardenedHttp
{
    public static HttpClient NewClient() => new(
        new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
            AutomaticDecompression = DecompressionMethods.All,
            ConnectTimeout = TimeSpan.FromSeconds(10),
        },
        disposeHandler: true);
}
