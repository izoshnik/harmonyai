#pragma once

#include "Components/ActorComponent.h"
#include "CoreMinimal.h"
#include "GameplayTagContainer.h"
#include "PrimInteractionAction.h"

#include "PrimInteractableComponent.generated.h"

/** Делает любой актор целью взаимодействий. Набор намерений задаётся данными, а не кодом объекта. */
UCLASS(ClassGroup = (Prim), meta = (BlueprintSpawnableComponent))
class PRIMINTERACTION_API UPrimInteractableComponent : public UActorComponent
{
	GENERATED_BODY()

public:
	UPrimInteractableComponent();

	/** Намерение → исполнитель. */
	UPROPERTY(EditAnywhere, Instanced, BlueprintReadOnly, Category = "Interaction")
	TMap<FGameplayTag, TObjectPtr<UPrimInteractionAction>> Actions;

	/** Максимальная дистанция взаимодействия, см. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Interaction", meta = (ClampMin = "0"))
	float MaxDistance = 250.f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Interaction")
	bool bRequireLineOfSight = true;

	UFUNCTION(BlueprintCallable, Category = "Interaction")
	FGameplayTagContainer GetAvailableIntents() const;

	UPrimInteractionAction* FindAction(const FGameplayTag& Intent) const;
};
