#include "PrimTags.h"

namespace PrimTags
{
UE_DEFINE_GAMEPLAY_TAG_COMMENT(Intent, "Intent", "Корень намерений взаимодействия");
UE_DEFINE_GAMEPLAY_TAG(Intent_Door_Open, "Intent.Door.Open");
UE_DEFINE_GAMEPLAY_TAG(Intent_Door_Close, "Intent.Door.Close");
UE_DEFINE_GAMEPLAY_TAG(Intent_Object_Inspect, "Intent.Object.Inspect");
UE_DEFINE_GAMEPLAY_TAG(Intent_NPC_Talk, "Intent.NPC.Talk");
UE_DEFINE_GAMEPLAY_TAG(Intent_NPC_Follow, "Intent.NPC.Follow");
UE_DEFINE_GAMEPLAY_TAG(Intent_Vehicle_Enter, "Intent.Vehicle.Enter");
UE_DEFINE_GAMEPLAY_TAG(Intent_Metro_PassGate, "Intent.Metro.PassGate");

UE_DEFINE_GAMEPLAY_TAG(Economy_Salary, "Economy.Salary");
UE_DEFINE_GAMEPLAY_TAG(Economy_Purchase, "Economy.Purchase");
UE_DEFINE_GAMEPLAY_TAG(Economy_Fare_Metro, "Economy.Fare.Metro");
UE_DEFINE_GAMEPLAY_TAG(Economy_Fine, "Economy.Fine");
} // namespace PrimTags
