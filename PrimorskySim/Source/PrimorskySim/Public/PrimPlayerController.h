#pragma once

#include "CoreMinimal.h"
#include "GameFramework/PlayerController.h"

#include "PrimPlayerController.generated.h"

class UPrimInteractorComponent;
class UPrimWalletComponent;

UCLASS()
class PRIMORSKYSIM_API APrimPlayerController : public APlayerController
{
	GENERATED_BODY()

public:
	APrimPlayerController();

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Prim")
	TObjectPtr<UPrimInteractorComponent> Interactor;

	/** Кошелёк на контроллере: деньги принадлежат игроку, а не текущей пешке (пересадка в машину их не теряет). */
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Prim")
	TObjectPtr<UPrimWalletComponent> Wallet;

	/** Ищет ближайший интерактивный объект в прицеле и запрашивает намерение по умолчанию (первое доступное). */
	UFUNCTION(BlueprintCallable, Category = "Prim")
	void InteractWithFocus();

	/** Длина луча фокуса, см. */
	UPROPERTY(EditDefaultsOnly, Category = "Prim")
	float FocusTraceLength = 300.f;
};
