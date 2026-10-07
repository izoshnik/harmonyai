#pragma once

#include "CoreMinimal.h"
#include "GameplayTagContainer.h"
#include "UObject/Object.h"

#include "PrimInteractionAction.generated.h"

/** Контекст одного взаимодействия: кто, с чем, какое намерение и с какими параметрами. */
USTRUCT(BlueprintType)
struct PRIMINTERACTION_API FPrimInteractionContext
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Interaction") TObjectPtr<AActor> Instigator = nullptr;
	UPROPERTY(BlueprintReadOnly, Category = "Interaction") TObjectPtr<AActor> Target = nullptr;
	UPROPERTY(BlueprintReadOnly, Category = "Interaction") FGameplayTag Intent;
	/** Параметры намерения (например, сумма, предмет, реплика) — ключ/значение, проверяются правилами. */
	UPROPERTY(BlueprintReadOnly, Category = "Interaction") TMap<FName, FString> Params;
};

/**
 * Исполнитель намерения. Один класс обслуживает много объектов (все двери, все турникеты).
 * Выполняется только на сервере; результат доходит до клиентов через реплицируемое состояние цели.
 */
UCLASS(Abstract, Blueprintable, EditInlineNew, DefaultToInstanced)
class PRIMINTERACTION_API UPrimInteractionAction : public UObject
{
	GENERATED_BODY()

public:
	/** Игровые правила поверх общей валидации (дистанция/видимость проверены до вызова). */
	UFUNCTION(BlueprintNativeEvent, Category = "Interaction")
	bool CanExecute(const FPrimInteractionContext& Context, FText& OutFailReason) const;

	UFUNCTION(BlueprintNativeEvent, Category = "Interaction")
	void Execute(const FPrimInteractionContext& Context);

	/** Подпись в радиальном меню. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Interaction")
	FText DisplayName;
};
