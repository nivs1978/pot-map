namespace PotMap.models
{
    sealed class ApiSecurityOptions
    {
        public const string SectionName = "ApiSecurity";
        public string AccessPassword { get; set; } = string.Empty;
    }
}
