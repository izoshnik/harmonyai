using UnrealBuildTool;

public class PrimInteraction : ModuleRules
{
	public PrimInteraction(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "GameplayTags", "PrimCore" });
		PrivateDependencyModuleNames.AddRange(new string[] {  });
	}
}
