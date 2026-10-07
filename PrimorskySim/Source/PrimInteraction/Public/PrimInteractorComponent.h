#pragma once

#include "Components/ActorComponent.h"
#include "CoreMinimal.h"
#include "PrimInteractionAction.h"

#include "PrimInteractorComponent.generated.h"

UENUM(BlueprintType)
enum class EPrimInteractionResult : uint8
{
	Success,
	NoTarget,
	UnsupportedIntent,
	TooFar,
	NoLineOfSight,
	RuleRejected,
	RateLimited,
};

DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(FPrimInteractionResultSignature, FGameplayTag, Intent, EPrimInteractionResult, Result, const FText&, Reason);

/**
 * Висит на PlayerController (и на AI-контроллерах NPC — тот же путь для всех).
 * Клиент отправляет намерение; сервер валидирует и исполняет. Голос/LLM приходят сюда же в виде intent.
 */
UCLASS(ClassGroup = (Prim), meta = (BlueprintSpawnableComponent))
class PRIMINTERACTION_API UPrimInteractorComponent : public UActorComponent
{
	GENERATED_BODY()

public:
	UPrimInteractorComponent();

	/** Точка входа для UI/ввода/голоса. На клиенте уходит RPC на сервер. */
	UFUNCTION(BlueprintCallable, Category = "Interaction")
	void RequestInteraction(AActor* Target, FGameplayTag Intent, const TMap<FName, FString>& Params);

	/** Серверная обработка (используется и AI напрямую). */
	EPrimInteractionResult ExecuteOnServer(AActor* Target, FGameplayTag Intent, const TMap<FName, FString>& Params, FText& OutReason);

	UPROPERTY(BlueprintAssignable, Category = "Interaction")
	FPrimInteractionResultSignature OnInteractionResult;

	/** Минимальный интервал между запросами (анти-спам RPC), с. */
	UPROPERTY(EditAnywhere, Category = "Interaction")
	float MinRequestInterval = 0.15f;

	/** Допуск дистанции на сетевую задержку, см. */
	UPROPERTY(EditAnywhere, Category = "Interaction")
	float DistanceTolerance = 50.f;

private:
	UFUNCTION(Server, Reliable)
	void ServerRequestInteraction(AActor* Target, FGameplayTag Intent, const TArray<FName>& ParamKeys, const TArray<FString>& ParamValues);

	UFUNCTION(Client, Reliable)
	void ClientInteractionResult(FGameplayTag Intent, EPrimInteractionResult Result, const FText& Reason);

	/** Пешка игрока или NPC, от которой меряется дистанция. */
	AActor* GetInstigatorActor() const;

	double LastRequestTime = -1.0;
};
