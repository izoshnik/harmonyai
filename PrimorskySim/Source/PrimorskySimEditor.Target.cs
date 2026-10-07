using UnrealBuildTool;

public class PrimorskySimEditorTarget : TargetRules
{
	public PrimorskySimEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.AddRange(new string[] { "PrimorskySim" });
	}
}
