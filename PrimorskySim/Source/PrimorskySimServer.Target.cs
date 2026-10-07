using UnrealBuildTool;

public class PrimorskySimServerTarget : TargetRules
{
	public PrimorskySimServerTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Server;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.AddRange(new string[] { "PrimorskySim" });
	}
}
