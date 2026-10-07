using UnrealBuildTool;

public class PrimorskySimClientTarget : TargetRules
{
	public PrimorskySimClientTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Client;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.AddRange(new string[] { "PrimorskySim" });
	}
}
