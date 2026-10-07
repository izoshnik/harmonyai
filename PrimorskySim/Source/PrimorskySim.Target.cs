using UnrealBuildTool;

public class PrimorskySimTarget : TargetRules
{
	public PrimorskySimTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.AddRange(new string[] { "PrimorskySim" });
	}
}
