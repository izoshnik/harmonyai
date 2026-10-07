#include "Engine/World.h"
#include "GameFramework/Controller.h"
#include "GameFramework/Pawn.h"
#include "PrimInteractableComponent.h"
#include "PrimInteractorComponent.h"

// ---------------------------------------------------------------- UPrimInteractionAction

bool UPrimInteractionAction::CanExecute_Implementation(const FPrimInteractionContext& Context, FText& OutFailReason) const
{
	return true;
}

void UPrimInteractionAction::Execute_Implementation(const FPrimInteractionContext& Context)
{
}

// ---------------------------------------------------------------- UPrimInteractableComponent

UPrimInteractableComponent::UPrimInteractableComponent()
{
	PrimaryComponentTick.bCanEverTick = false;
}

FGameplayTagContainer UPrimInteractableComponent::GetAvailableIntents() const
{
	FGameplayTagContainer Result;
	for (const TPair<FGameplayTag, TObjectPtr<UPrimInteractionAction>>& Pair : Actions)
	{
		if (Pair.Value)
		{
			Result.AddTag(Pair.Key);
		}
	}
	return Result;
}

UPrimInteractionAction* UPrimInteractableComponent::FindAction(const FGameplayTag& Intent) const
{
	const TObjectPtr<UPrimInteractionAction>* Found = Actions.Find(Intent);
	return Found ? Found->Get() : nullptr;
}

// ---------------------------------------------------------------- UPrimInteractorComponent

UPrimInteractorComponent::UPrimInteractorComponent()
{
	PrimaryComponentTick.bCanEverTick = false;
	SetIsReplicatedByDefault(true);
}

void UPrimInteractorComponent::RequestInteraction(AActor* Target, FGameplayTag Intent, const TMap<FName, FString>& Params)
{
	if (GetOwner()->HasAuthority())
	{
		FText Reason;
		const EPrimInteractionResult Result = ExecuteOnServer(Target, Intent, Params, Reason);
		OnInteractionResult.Broadcast(Intent, Result, Reason);
		return;
	}
	TArray<FName> Keys;
	TArray<FString> Values;
	Params.GenerateKeyArray(Keys);
	Params.GenerateValueArray(Values);
	ServerRequestInteraction(Target, Intent, Keys, Values);
}

void UPrimInteractorComponent::ServerRequestInteraction_Implementation(AActor* Target, FGameplayTag Intent, const TArray<FName>& ParamKeys, const TArray<FString>& ParamValues)
{
	TMap<FName, FString> Params;
	const int32 Count = FMath::Min(FMath::Min(ParamKeys.Num(), ParamValues.Num()), 16); // ограничение размера запроса
	for (int32 I = 0; I < Count; ++I)
	{
		Params.Add(ParamKeys[I], ParamValues[I].Left(256));
	}
	FText Reason;
	const EPrimInteractionResult Result = ExecuteOnServer(Target, Intent, Params, Reason);
	ClientInteractionResult(Intent, Result, Reason);
}

void UPrimInteractorComponent::ClientInteractionResult_Implementation(FGameplayTag Intent, EPrimInteractionResult Result, const FText& Reason)
{
	OnInteractionResult.Broadcast(Intent, Result, Reason);
}

AActor* UPrimInteractorComponent::GetInstigatorActor() const
{
	if (const AController* Controller = Cast<AController>(GetOwner()))
	{
		return Controller->GetPawn();
	}
	return GetOwner();
}

EPrimInteractionResult UPrimInteractorComponent::ExecuteOnServer(AActor* Target, FGameplayTag Intent, const TMap<FName, FString>& Params, FText& OutReason)
{
	check(GetOwner()->HasAuthority());

	const double Now = GetWorld()->GetTimeSeconds();
	if (LastRequestTime >= 0.0 && Now - LastRequestTime < MinRequestInterval)
	{
		return EPrimInteractionResult::RateLimited;
	}
	LastRequestTime = Now;

	AActor* Instigator = GetInstigatorActor();
	UPrimInteractableComponent* Interactable = Target ? Target->FindComponentByClass<UPrimInteractableComponent>() : nullptr;
	if (!Instigator || !Interactable)
	{
		return EPrimInteractionResult::NoTarget;
	}

	UPrimInteractionAction* Action = Interactable->FindAction(Intent);
	if (!Action)
	{
		return EPrimInteractionResult::UnsupportedIntent;
	}

	const FVector From = Instigator->GetActorLocation();
	const FVector To = Target->GetActorLocation();
	if (FVector::Dist(From, To) > Interactable->MaxDistance + DistanceTolerance)
	{
		return EPrimInteractionResult::TooFar;
	}

	if (Interactable->bRequireLineOfSight)
	{
		FCollisionQueryParams Query(SCENE_QUERY_STAT(PrimInteractionLOS), false, Instigator);
		FHitResult Hit;
		const FVector Eye = From + FVector(0, 0, 60);
		if (GetWorld()->LineTraceSingleByChannel(Hit, Eye, To, ECC_Visibility, Query) && Hit.GetActor() != Target)
		{
			return EPrimInteractionResult::NoLineOfSight;
		}
	}

	FPrimInteractionContext Context;
	Context.Instigator = Instigator;
	Context.Target = Target;
	Context.Intent = Intent;
	Context.Params = Params;

	if (!Action->CanExecute(Context, OutReason))
	{
		return EPrimInteractionResult::RuleRejected;
	}
	Action->Execute(Context);
	return EPrimInteractionResult::Success;
}
