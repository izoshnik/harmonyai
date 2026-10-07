using UnrealBuildTool;

public class PrimSimCore : ModuleRules
{
	public PrimSimCore(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core" });
		PrivateDependencyModuleNames.AddRange(new string[] {  });
	}
}
