using UnrealBuildTool;

public class PrimMetro : ModuleRules
{
	public PrimMetro(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "NetCore", "PrimCore", "PrimSimCore", "PrimWorld" });
		PrivateDependencyModuleNames.AddRange(new string[] {  });
	}
}
