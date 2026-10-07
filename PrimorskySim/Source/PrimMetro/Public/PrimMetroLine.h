#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "SimCore/MetroSim.h"

#include "PrimMetroLine.generated.h"

class UPrimMetroLineAsset;
class USplineComponent;

UENUM(BlueprintType)
enum class EPrimTrainPhase : uint8
{
	Running,
	DoorsOpening,
	DoorsOpen,
	DoorsClosing,
	Turnaround,
};

/** Компактное сетевое состояние поезда (~12 байт после квантования). */
USTRUCT(BlueprintType)
struct PRIMMETRO_API FPrimTrainNetState
{
	GENERATED_BODY()

	/** Пикетаж головы, дециметры. */
	UPROPERTY(BlueprintReadOnly, Category = "Metro") int32 ChainageDm = 0;
	/** Скорость, см/с. */
	UPROPERTY() uint16 SpeedCms = 0;
	UPROPERTY() int8 Direction = 1;
	UPROPERTY(BlueprintReadOnly, Category = "Metro") EPrimTrainPhase Phase = EPrimTrainPhase::Running;
	UPROPERTY(BlueprintReadOnly, Category = "Metro") uint8 TargetStop = 0;
};

/**
 * Линия метро в уровне: сплайн трассы (пикетаж = длина вдоль сплайна) + серверная симуляция SimCore::MetroLineSim.
 * Сервер симулирует всегда (дёшево), реплицирует состояния поездов; клиенты держат локальные визуальные
 * акторы вагонов и интерполируют их между обновлениями — вагоны не реплицируются по отдельности.
 */
UCLASS()
class PRIMMETRO_API APrimMetroLine : public AActor
{
	GENERATED_BODY()

public:
	APrimMetroLine();

	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type Reason) override;
	virtual void Tick(float DeltaSeconds) override;
	virtual void GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const override;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Metro")
	TObjectPtr<USplineComponent> Track;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Metro")
	TObjectPtr<UPrimMetroLineAsset> LineData;

	/** Шаг серверной симуляции, с. */
	UPROPERTY(EditAnywhere, Category = "Metro")
	float SimStepS = 0.1f;

	/** Частота отправки состояний клиентам, Гц. */
	UPROPERTY(EditAnywhere, Category = "Metro")
	float NetUpdateHz = 4.f;

	/** Боковое смещение пути каждого направления от оси сплайна, см. */
	UPROPERTY(EditAnywhere, Category = "Metro")
	float TrackHalfSpacingCm = 200.f;

	UFUNCTION(BlueprintCallable, Category = "Metro")
	int32 GetTrainCount() const { return Trains.Num(); }

	UFUNCTION(BlueprintCallable, Category = "Metro")
	FTransform GetTransformAtChainage(float ChainageM, int32 Direction) const;

	/** Ближайший к пикетажу поезд, стоящий с открытыми дверями (для посадки). -1 если нет. */
	UFUNCTION(BlueprintCallable, Category = "Metro")
	int32 FindTrainWithOpenDoorsAt(FName StationId, int32 Direction) const;

	UFUNCTION(BlueprintCallable, Category = "Metro")
	FPrimTrainNetState GetTrainState(int32 Index) const { return Trains.IsValidIndex(Index) ? Trains[Index] : FPrimTrainNetState(); }

private:
	void BuildSimulation();
	void PublishStates();
	void UpdateVisuals(float DeltaSeconds);

	UFUNCTION()
	void OnRep_Trains();

	UPROPERTY(ReplicatedUsing = OnRep_Trains)
	TArray<FPrimTrainNetState> Trains;

	TUniquePtr<SimCore::MetroLineSim> Sim;
	float SimAccumulator = 0.f;
	float NetAccumulator = 0.f;

	/** Клиентские визуальные составы: на поезд — массив вагонов. */
	struct FTrainVisual
	{
		TArray<TWeakObjectPtr<AActor>> Cars;
		float DisplayedChainageM = 0.f;
	};
	TArray<FTrainVisual> Visuals;
};
