using UnrealBuildTool;

public class PrimorskySim : ModuleRules
{
	public PrimorskySim(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "InputCore", "EnhancedInput", "NetCore", "PrimCore", "PrimWorld", "PrimInteraction", "PrimEconomy", "PrimMetro" });
		PrivateDependencyModuleNames.AddRange(new string[] {  });
	}
}
