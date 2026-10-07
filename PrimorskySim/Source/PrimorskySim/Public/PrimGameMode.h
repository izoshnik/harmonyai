#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"

#include "PrimGameMode.generated.h"

/** Серверные правила шарда. Существует только на сервере. */
UCLASS()
class PRIMORSKYSIM_API APrimGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	APrimGameMode();

	virtual void InitGameState() override;
	virtual void PostLogin(APlayerController* NewPlayer) override;

	/** Стартовое время мира, если persistence ещё не подключён: 2026-06-01 08:00. */
	UPROPERTY(EditDefaultsOnly, Category = "Time")
	double DefaultStartWorldSeconds = 151.0 * 86400.0 + 8.0 * 3600.0;

	/** Игровых секунд на реальную (1 = реальное время). */
	UPROPERTY(EditDefaultsOnly, Category = "Time", meta = (ClampMin = "0"))
	float DefaultTimeScale = 1.f;

	/** Стартовые средства нового персонажа, копейки (выпуск из бюджета города, проводка в Ledger). */
	UPROPERTY(EditDefaultsOnly, Category = "Economy")
	int64 StarterCashKopecks = 5000 * 100;

	UPROPERTY(EditDefaultsOnly, Category = "Economy")
	int64 StarterBankKopecks = 30000 * 100;
};
