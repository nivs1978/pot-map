namespace PotMap.models
{
    sealed record ApiRequest
    {
        public string? Action { get; init; }
        public string? MapId { get; init; }
        public string? Code { get; init; }
        public PoiPayload? Poi { get; init; }
        public string? PoiId { get; init; }
    }
}
