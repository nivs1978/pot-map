namespace PotMap.models
{
    sealed record PoiPayload
    {
        public string? Id { get; init; }
        public int? Type { get; init; }
        public double? X { get; init; }
        public double? Y { get; init; }
    }
}
