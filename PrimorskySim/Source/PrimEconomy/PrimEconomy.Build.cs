using UnrealBuildTool;

public class PrimEconomy : ModuleRules
{
	public PrimEconomy(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "GameplayTags", "PrimCore", "PrimSimCore" });
		PrivateDependencyModuleNames.AddRange(new string[] {  });
	}
}
