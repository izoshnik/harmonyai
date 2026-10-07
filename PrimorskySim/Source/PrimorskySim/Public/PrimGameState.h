#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameStateBase.h"
#include "PrimWorldTime.h"

#include "PrimGameState.generated.h"

/** Глобальное состояние шарда: время мира. Реплицируется только при смене якоря (старт, смена масштаба). */
UCLASS()
class PRIMORSKYSIM_API APrimGameState : public AGameStateBase
{
	GENERATED_BODY()

public:
	virtual void GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const override;

	/** Секунды от 2026-01-01 00:00 МСК. Одинаково на сервере и клиентах (по синхронизированному серверному времени). */
	UFUNCTION(BlueprintPure, Category = "Time")
	double GetWorldSeconds() const;

	UFUNCTION(BlueprintPure, Category = "Time")
	double GetHourOfDay() const { return FPrimWorldTime::HourOfDay(GetWorldSeconds()); }

	/** Сервер: переякорить время (загрузка из persistence, админ-команда). */
	void SetWorldTime(double WorldSeconds, float TimeScale);

private:
	UPROPERTY(Replicated)
	FPrimWorldTime WorldTime;
};
