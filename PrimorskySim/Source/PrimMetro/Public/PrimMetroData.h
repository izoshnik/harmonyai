#pragma once

#include "CoreMinimal.h"
#include "Engine/DataAsset.h"

#include "PrimMetroData.generated.h"

/** Тип состава (Балтиец и др.). Числа — данные; до верификации помечаются в манифесте NEEDS_VERIFICATION. */
UCLASS(BlueprintType)
class PRIMMETRO_API UPrimTrainTypeAsset : public UPrimaryDataAsset
{
	GENERATED_BODY()

public:
	/** object_id в WorldManifest, например PRM-ROLLINGSTOCK-BALTIETS. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Train") FName ManifestId;
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Train") FText DisplayName;
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Train", meta = (ClampMin = "1")) int32 CarCount = 8;
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Train", meta = (Units = "m")) float CarLengthM = 19.6f;
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Train", meta = (Units = "km/h")) float MaxSpeedKmh = 80.f;
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Train") float AccelMps2 = 1.0f;
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Train") float ServiceDecelMps2 = 1.0f;
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Train") float DoorOpenS = 3.f;
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Train") float DoorCloseS = 3.5f;

	/** Визуал вагонов: головной/промежуточный. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Visual") TSoftClassPtr<AActor> HeadCarClass;
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Visual") TSoftClassPtr<AActor> MiddleCarClass;
};

USTRUCT(BlueprintType)
struct PRIMMETRO_API FPrimMetroStop
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Metro") FName StationId;
	/** Пикетаж точки остановки головы поезда, м вдоль сплайна линии. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Metro") float ChainageM = 0.f;
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Metro") float DwellS = 25.f;
};

UCLASS(BlueprintType)
class PRIMMETRO_API UPrimMetroLineAsset : public UPrimaryDataAsset
{
	GENERATED_BODY()

public:
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Metro") FName LineId;
	/** Остановки по возрастанию пикетажа. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Metro") TArray<FPrimMetroStop> Stops;
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Metro") TObjectPtr<UPrimTrainTypeAsset> TrainType;
	/** Сколько составов в каждом направлении выпускается на старте. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Metro", meta = (ClampMin = "0")) int32 TrainsPerDirection = 2;
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Metro") float TurnaroundS = 120.f;
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Metro") float SafetyGapM = 60.f;
};
