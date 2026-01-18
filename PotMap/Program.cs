using System.Text;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;
using MySqlConnector;
using PotMap.models;

const string ConnectionStringEnvVar = "POTMAP_CONNECTION_STRING";
const string AccessPasswordEnvVar = "POTMAP_ACCESS_PASSWORD";

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://0.0.0.0:8001");

var accessPassword = Environment.GetEnvironmentVariable(AccessPasswordEnvVar);

if (string.IsNullOrWhiteSpace(accessPassword))
{
    throw new InvalidOperationException($"Access password must be provided via environment variable '{AccessPasswordEnvVar}'.");
}

builder.Services.Configure<ApiSecurityOptions>(options =>
{
    options.AccessPassword = accessPassword;
});

var connectionString = Environment.GetEnvironmentVariable(ConnectionStringEnvVar);

if (string.IsNullOrWhiteSpace(connectionString))
{
    throw new InvalidOperationException($"Connection string must be provided via environment variable '{ConnectionStringEnvVar}'.");
}

var dataSource = new MySqlDataSourceBuilder(connectionString).Build();
builder.Services.AddSingleton(dataSource);

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
    options.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
});

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapPost("/api/data", async (
    ApiRequest request,
    MySqlDataSource dataSource,
    IOptions<ApiSecurityOptions> apiOptions,
    ILoggerFactory loggerFactory) =>
{
    var logger = loggerFactory.CreateLogger("PotMap.Api");
    return await ApiHandler.HandleAsync(request, dataSource, apiOptions.Value, logger);
});

app.MapFallbackToFile("/index.html");

app.Run();

static class ApiHandler
{
    private static readonly HashSet<string> MutatingActions = new(StringComparer.OrdinalIgnoreCase)
    {
        "create",
        "update",
        "delete",
    };

    public static async Task<IResult> HandleAsync(ApiRequest request, MySqlDataSource dataSource, ApiSecurityOptions securityOptions, ILogger logger)
    {
        var action = request.Action?.Trim();
        if (string.IsNullOrWhiteSpace(action))
        {
            return Results.Json(new ErrorEnvelope("Unsupported action"), statusCode: StatusCodes.Status400BadRequest);
        }

        action = action.ToLowerInvariant();
        var requiresMapId = !string.Equals(action, "types", StringComparison.OrdinalIgnoreCase);

        string? normalizedMapId = null;
        if (requiresMapId)
        {
            normalizedMapId = HexGuid.Normalize(request.MapId);
            if (normalizedMapId is null)
            {
                return Results.Json(new ErrorEnvelope("mapId is required"), statusCode: StatusCodes.Status400BadRequest);
            }
        }

        if (MutatingActions.Contains(action))
        {
            var submittedCode = request.Code?.Trim();
            if (string.IsNullOrEmpty(submittedCode) || !string.Equals(submittedCode, securityOptions.AccessPassword, StringComparison.Ordinal))
            {
                return Results.Json(new ErrorEnvelope("Access denied"), statusCode: StatusCodes.Status403Forbidden);
            }
        }

        try
        {
            return action switch
            {
                "list" => await HandleListAsync(dataSource, normalizedMapId!),
                "create" => await HandleCreateAsync(dataSource, normalizedMapId!, request.Poi),
                "update" => await HandleUpdateAsync(dataSource, normalizedMapId!, request.Poi),
                "delete" => await HandleDeleteAsync(dataSource, normalizedMapId!, request.PoiId),
                "types" => await HandleTypesAsync(dataSource),
                _ => Results.Json(new ErrorEnvelope("Unsupported action"), statusCode: StatusCodes.Status400BadRequest),
            };
        }
        catch (MySqlException ex)
        {
            logger.LogError(ex, "Database error while processing action {Action}", action);
            return Results.Json(new ErrorEnvelope(ex.Message), statusCode: StatusCodes.Status500InternalServerError);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Unhandled error while processing action {Action}", action);
            return Results.Json(new ErrorEnvelope("An unexpected error occurred"), statusCode: StatusCodes.Status500InternalServerError);
        }
    }

    private static async Task<IResult> HandleListAsync(MySqlDataSource dataSource, string mapId)
    {
        const string sql = @"SELECT LOWER(HEX(id)) AS id, LOWER(HEX(map_id)) AS map_id, type, x, y
                              FROM pois
                              WHERE map_id = UNHEX(@mapId)
                              ORDER BY id";

        await using var connection = await dataSource.OpenConnectionAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.Parameters.Add("@mapId", MySqlDbType.VarChar, 32).Value = mapId;

        var records = new List<PoiRecord>();
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            records.Add(new PoiRecord(
                reader.GetString("id"),
                reader.GetString("map_id"),
                reader.GetInt32("type"),
                reader.GetDouble("x"),
                reader.GetDouble("y")));
        }

        return Results.Json(new DataEnvelope<IEnumerable<PoiRecord>>(records));
    }

    private static async Task<IResult> HandleCreateAsync(MySqlDataSource dataSource, string mapId, PoiPayload? poi)
    {
        if (poi is null)
        {
            return Results.Json(new ErrorEnvelope("poi payload missing"), statusCode: StatusCodes.Status400BadRequest);
        }

        var poiId = HexGuid.Normalize(poi.Id);
        if (poiId is null)
        {
            return Results.Json(new ErrorEnvelope("poi.id is required"), statusCode: StatusCodes.Status400BadRequest);
        }
        if (poi.Type is null)
        {
            return Results.Json(new ErrorEnvelope("poi.type is required"), statusCode: StatusCodes.Status400BadRequest);
        }
        if (poi.X is null || poi.Y is null)
        {
            return Results.Json(new ErrorEnvelope("poi.x and poi.y are required"), statusCode: StatusCodes.Status400BadRequest);
        }

        const string sql = @"INSERT INTO pois (id, map_id, type, x, y)
                              VALUES (UNHEX(@id), UNHEX(@mapId), @type, @x, @y)";

        await using var connection = await dataSource.OpenConnectionAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.Parameters.Add("@id", MySqlDbType.VarChar, 32).Value = poiId;
        command.Parameters.Add("@mapId", MySqlDbType.VarChar, 32).Value = mapId;
        command.Parameters.Add("@type", MySqlDbType.Int32).Value = poi.Type.Value;
        command.Parameters.Add("@x", MySqlDbType.Double).Value = poi.X.Value;
        command.Parameters.Add("@y", MySqlDbType.Double).Value = poi.Y.Value;

        await command.ExecuteNonQueryAsync();

        var response = new PoiRecord(poiId, mapId, poi.Type.Value, poi.X.Value, poi.Y.Value);
        return Results.Json(new DataEnvelope<PoiRecord>(response), statusCode: StatusCodes.Status201Created);
    }

    private static async Task<IResult> HandleUpdateAsync(MySqlDataSource dataSource, string mapId, PoiPayload? poi)
    {
        if (poi is null)
        {
            return Results.Json(new ErrorEnvelope("poi payload missing"), statusCode: StatusCodes.Status400BadRequest);
        }

        var poiId = HexGuid.Normalize(poi.Id);
        if (poiId is null)
        {
            return Results.Json(new ErrorEnvelope("poi.id is required"), statusCode: StatusCodes.Status400BadRequest);
        }
        if (poi.X is null || poi.Y is null)
        {
            return Results.Json(new ErrorEnvelope("poi.x and poi.y are required"), statusCode: StatusCodes.Status400BadRequest);
        }

        const string sql = @"UPDATE pois
                              SET x = @x, y = @y
                              WHERE id = UNHEX(@id) AND map_id = UNHEX(@mapId)
                              LIMIT 1";

        await using var connection = await dataSource.OpenConnectionAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.Parameters.Add("@x", MySqlDbType.Double).Value = poi.X.Value;
        command.Parameters.Add("@y", MySqlDbType.Double).Value = poi.Y.Value;
        command.Parameters.Add("@id", MySqlDbType.VarChar, 32).Value = poiId;
        command.Parameters.Add("@mapId", MySqlDbType.VarChar, 32).Value = mapId;

        var affected = await command.ExecuteNonQueryAsync();
        var response = new PoiUpdateRecord(poiId, mapId, poi.X.Value, poi.Y.Value, affected > 0);
        return Results.Json(new DataEnvelope<PoiUpdateRecord>(response));
    }

    private static async Task<IResult> HandleDeleteAsync(MySqlDataSource dataSource, string mapId, string? poiIdRaw)
    {
        var poiId = HexGuid.Normalize(poiIdRaw);
        if (poiId is null)
        {
            return Results.Json(new ErrorEnvelope("poiId is required"), statusCode: StatusCodes.Status400BadRequest);
        }

        const string sql = @"DELETE FROM pois
                              WHERE id = UNHEX(@id) AND map_id = UNHEX(@mapId)
                              LIMIT 1";

        await using var connection = await dataSource.OpenConnectionAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.Parameters.Add("@id", MySqlDbType.VarChar, 32).Value = poiId;
        command.Parameters.Add("@mapId", MySqlDbType.VarChar, 32).Value = mapId;

        var affected = await command.ExecuteNonQueryAsync();
        var response = new DeleteResult(poiId, mapId, affected > 0);
        return Results.Json(new DataEnvelope<DeleteResult>(response));
    }

    private static async Task<IResult> HandleTypesAsync(MySqlDataSource dataSource)
    {
        const string sql = @"SELECT id, name, image FROM types ORDER BY id ASC";

        await using var connection = await dataSource.OpenConnectionAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = sql;

        var types = new List<PoiTypeRecord>();
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            types.Add(new PoiTypeRecord(
                reader.GetInt32("id"),
                reader.GetString("name"),
                reader.GetString("image")));
        }

        return Results.Json(new DataEnvelope<IEnumerable<PoiTypeRecord>>(types));
    }
}

static class HexGuid
{
    public static string? Normalize(string? input)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            return null;
        }

        var builder = new StringBuilder(32);
        foreach (var ch in input)
        {
            if (Uri.IsHexDigit(ch))
            {
                builder.Append(char.ToLowerInvariant(ch));
            }
        }

        return builder.Length == 32 ? builder.ToString() : null;
    }
}
