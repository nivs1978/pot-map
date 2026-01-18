namespace PotMap.models
{
    sealed record PoiRecord(string Id, string MapId, int Type, double X, double Y);

    sealed record PoiUpdateRecord(string Id, string MapId, double X, double Y, bool Updated);

    sealed record DeleteResult(string Id, string MapId, bool Deleted);

    sealed record PoiTypeRecord(int Id, string Name, string Image);

    sealed record DataEnvelope<T>(T Data);

    sealed record ErrorEnvelope(string Error);
}
