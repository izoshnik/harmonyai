#pragma once

#include "CoreMinimal.h"

#include "PrimWorldTime.generated.h"

/**
 * Время мира. Хранится как секунды от 2026-01-01 00:00 (МСК), масштаб — игровых секунд на реальную.
 * Сервер владеет якорем (AnchorServerTime/AnchorWorldSeconds), клиенты вычисляют текущее время локально
 * по синхронизированному серверному времени — без репликации каждый тик.
 */
USTRUCT(BlueprintType)
struct PRIMCORE_API FPrimWorldTime
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Time")
	double AnchorServerTime = 0.0;

	UPROPERTY(BlueprintReadOnly, Category = "Time")
	double AnchorWorldSeconds = 0.0;

	UPROPERTY(BlueprintReadOnly, Category = "Time")
	float TimeScale = 1.0f;

	double WorldSecondsAt(double ServerTime) const
	{
		return AnchorWorldSeconds + (ServerTime - AnchorServerTime) * TimeScale;
	}

	static constexpr double SecondsPerDay = 86400.0;

	/** Часы суток [0, 24). */
	static double HourOfDay(double WorldSeconds)
	{
		const double Day = FMath::Fmod(WorldSeconds, SecondsPerDay);
		return (Day < 0 ? Day + SecondsPerDay : Day) / 3600.0;
	}

	/** 0 = понедельник. 1 января 2026 — четверг. */
	static int32 DayOfWeek(double WorldSeconds)
	{
		const int64 Day = FMath::FloorToInt64(WorldSeconds / SecondsPerDay);
		return static_cast<int32>(((Day + 3) % 7 + 7) % 7);
	}
};
