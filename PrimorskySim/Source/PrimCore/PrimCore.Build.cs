using UnrealBuildTool;

public class PrimCore : ModuleRules
{
	public PrimCore(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "GameplayTags", "PrimSimCore" });
		PrivateDependencyModuleNames.AddRange(new string[] {  });
	}
}
