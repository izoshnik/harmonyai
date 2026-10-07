using UnrealBuildTool;

public class PrimWorld : ModuleRules
{
	public PrimWorld(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "PrimCore" });
		PrivateDependencyModuleNames.AddRange(new string[] { "Json", "JsonUtilities", "Projects" });
	}
}
