#include "PrimMetroLine.h"

#include "Components/SplineComponent.h"
#include "Engine/World.h"
#include "Net/UnrealNetwork.h"
#include "PrimMetroData.h"

DEFINE_LOG_CATEGORY_STATIC(LogPrimMetro, Log, All);

APrimMetroLine::APrimMetroLine()
{
	PrimaryActorTick.bCanEverTick = true;
	bReplicates = true;
	bAlwaysRelevant = false;
	SetNetCullDistanceSquared(FMath::Square(3000.f * 100.f)); // 3 км: подземка стримится отдельно, состояние дешёвое
	SetNetUpdateFrequency(4.f);

	Track = CreateDefaultSubobject<USplineComponent>(TEXT("Track"));
	RootComponent = Track;
}

void APrimMetroLine::BeginPlay()
{
	Super::BeginPlay();
	if (HasAuthority())
	{
		BuildSimulation();
		PublishStates();
	}
}

void APrimMetroLine::EndPlay(const EEndPlayReason::Type Reason)
{
	for (FTrainVisual& V : Visuals)
	{
		for (TWeakObjectPtr<AActor>& Car : V.Cars)
		{
			if (Car.IsValid())
			{
				Car->Destroy();
			}
		}
	}
	Visuals.Reset();
	Super::EndPlay(Reason);
}

void APrimMetroLine::BuildSimulation()
{
	if (!LineData || !LineData->TrainType || LineData->Stops.Num() < 2)
	{
		UE_LOG(LogPrimMetro, Error, TEXT("%s: LineData incomplete (need TrainType and >= 2 stops)"), *GetName());
		return;
	}
	const UPrimTrainTypeAsset* TT = LineData->TrainType;

	SimCore::LineConfig Line;
	Line.LineId = TCHAR_TO_UTF8(*LineData->LineId.ToString());
	Line.TurnaroundS = LineData->TurnaroundS;
	Line.SafetyGapM = LineData->SafetyGapM;
	const float TrackLengthM = Track->GetSplineLength() / 100.f;
	for (const FPrimMetroStop& Stop : LineData->Stops)
	{
		if (Stop.ChainageM < 0.f || Stop.ChainageM > TrackLengthM)
		{
			UE_LOG(LogPrimMetro, Error, TEXT("%s: stop %s chainage %.1f outside track (%.1f m)"), *GetName(), *Stop.StationId.ToString(), Stop.ChainageM, TrackLengthM);
			return;
		}
		Line.Stops.push_back({TCHAR_TO_UTF8(*Stop.StationId.ToString()), Stop.ChainageM, Stop.DwellS});
	}

	SimCore::TrainType Type;
	Type.Id = TCHAR_TO_UTF8(*TT->ManifestId.ToString());
	Type.MaxSpeedMps = TT->MaxSpeedKmh / 3.6;
	Type.AccelMps2 = TT->AccelMps2;
	Type.ServiceDecelMps2 = TT->ServiceDecelMps2;
	Type.LengthM = TT->CarCount * TT->CarLengthM;
	Type.DoorOpenS = TT->DoorOpenS;
	Type.DoorCloseS = TT->DoorCloseS;

	Sim = MakeUnique<SimCore::MetroLineSim>(MoveTemp(Line), Type);

	// Начальная расстановка: равномерно по станциям в обоих направлениях.
	const int32 StopCount = LineData->Stops.Num();
	int32 Serial = 0;
	for (int32 Dir : {+1, -1})
	{
		for (int32 I = 0; I < LineData->TrainsPerDirection; ++I)
		{
			const int32 StopIndex = Dir > 0 ? (I * StopCount) / FMath::Max(1, LineData->TrainsPerDirection)
			                                  : StopCount - 1 - (I * StopCount) / FMath::Max(1, LineData->TrainsPerDirection);
			Sim->AddTrain(TCHAR_TO_UTF8(*FString::Printf(TEXT("%s-%02d"), *LineData->LineId.ToString(), ++Serial)), StopIndex, Dir);
		}
	}
}

void APrimMetroLine::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);

	if (HasAuthority() && Sim)
	{
		SimAccumulator += DeltaSeconds;
		int32 Steps = 0;
		while (SimAccumulator >= SimStepS && Steps++ < 20) // защита от «спирали смерти» после фриза
		{
			Sim->Step(SimStepS);
			SimAccumulator -= SimStepS;
		}
		NetAccumulator += DeltaSeconds;
		if (NetAccumulator >= 1.f / NetUpdateHz)
		{
			NetAccumulator = 0.f;
			PublishStates();
		}
	}

	if (GetNetMode() != NM_DedicatedServer)
	{
		UpdateVisuals(DeltaSeconds);
	}
}

void APrimMetroLine::PublishStates()
{
	if (!Sim)
	{
		return;
	}
	const std::vector<SimCore::TrainState>& Src = Sim->GetTrains();
	Trains.SetNum(static_cast<int32>(Src.size()));
	for (int32 I = 0; I < Trains.Num(); ++I)
	{
		const SimCore::TrainState& S = Src[I];
		FPrimTrainNetState& N = Trains[I];
		N.ChainageDm = FMath::RoundToInt32(S.ChainageM * 10.0);
		N.SpeedCms = static_cast<uint16>(FMath::Clamp(FMath::RoundToInt32(S.SpeedMps * 100.0), 0, 65535));
		N.Direction = static_cast<int8>(S.Direction);
		N.Phase = static_cast<EPrimTrainPhase>(S.Phase);
		N.TargetStop = static_cast<uint8>(S.TargetStop);
	}
	ForceNetUpdate();
}

void APrimMetroLine::OnRep_Trains()
{
	// Визуалы подстраиваются в UpdateVisuals; здесь только реакция на изменение числа поездов.
	if (Visuals.Num() != Trains.Num())
	{
		UpdateVisuals(0.f);
	}
}

FTransform APrimMetroLine::GetTransformAtChainage(float ChainageM, int32 Direction) const
{
	const float Distance = FMath::Clamp(ChainageM * 100.f, 0.f, Track->GetSplineLength());
	FTransform T = Track->GetTransformAtDistanceAlongSpline(Distance, ESplineCoordinateSpace::World);
	const FVector Right = T.GetRotation().GetRightVector();
	T.AddToTranslation(Right * TrackHalfSpacingCm * (Direction > 0 ? 1.f : -1.f));
	if (Direction < 0)
	{
		T.SetRotation(T.GetRotation() * FQuat(FVector::UpVector, PI));
	}
	return T;
}

int32 APrimMetroLine::FindTrainWithOpenDoorsAt(FName StationId, int32 Direction) const
{
	if (!LineData)
	{
		return INDEX_NONE;
	}
	for (int32 I = 0; I < Trains.Num(); ++I)
	{
		const FPrimTrainNetState& T = Trains[I];
		if (T.Phase == EPrimTrainPhase::DoorsOpen && T.Direction == Direction && LineData->Stops.IsValidIndex(T.TargetStop)
			&& LineData->Stops[T.TargetStop].StationId == StationId)
		{
			return I;
		}
	}
	return INDEX_NONE;
}

void APrimMetroLine::UpdateVisuals(float DeltaSeconds)
{
	if (!LineData || !LineData->TrainType)
	{
		return;
	}
	const UPrimTrainTypeAsset* TT = LineData->TrainType;
	UClass* HeadClass = TT->HeadCarClass.LoadSynchronous(); // TODO(stage 4): async preload через Asset Manager
	UClass* MiddleClass = TT->MiddleCarClass.LoadSynchronous();
	if (!HeadClass)
	{
		return;
	}

	// Создание/удаление визуалов под число поездов.
	while (Visuals.Num() > Trains.Num())
	{
		for (TWeakObjectPtr<AActor>& Car : Visuals.Last().Cars)
		{
			if (Car.IsValid())
			{
				Car->Destroy();
			}
		}
		Visuals.Pop();
	}
	while (Visuals.Num() < Trains.Num())
	{
		FTrainVisual& V = Visuals.AddDefaulted_GetRef();
		const FPrimTrainNetState& S = Trains[Visuals.Num() - 1];
		V.DisplayedChainageM = S.ChainageDm / 10.f;
		FActorSpawnParameters Params;
		Params.Owner = this;
		Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
		for (int32 Car = 0; Car < TT->CarCount; ++Car)
		{
			UClass* Cls = (Car == 0 || Car == TT->CarCount - 1 || !MiddleClass) ? HeadClass : MiddleClass;
			AActor* Spawned = GetWorld()->SpawnActor<AActor>(Cls, GetActorTransform(), Params);
			if (Spawned)
			{
				Spawned->SetReplicates(false);
			}
			V.Cars.Add(Spawned);
		}
	}

	// Сглаженное следование за серверным пикетажем + экстраполяция по скорости.
	for (int32 I = 0; I < Trains.Num(); ++I)
	{
		const FPrimTrainNetState& S = Trains[I];
		FTrainVisual& V = Visuals[I];
		const float Server = S.ChainageDm / 10.f;
		const float Speed = S.SpeedCms / 100.f;
		V.DisplayedChainageM += Speed * S.Direction * DeltaSeconds;
		const float Error = Server - V.DisplayedChainageM;
		V.DisplayedChainageM = FMath::Abs(Error) > 50.f ? Server : V.DisplayedChainageM + Error * FMath::Min(1.f, DeltaSeconds * 2.f);

		for (int32 Car = 0; Car < V.Cars.Num(); ++Car)
		{
			if (AActor* CarActor = V.Cars[Car].Get())
			{
				// Центр вагона: от головы назад на (Car + 0.5) длины.
				const float CarCenter = V.DisplayedChainageM - S.Direction * (Car + 0.5f) * TT->CarLengthM;
				FTransform T = GetTransformAtChainage(CarCenter, S.Direction);
				if (Car == V.Cars.Num() - 1 && V.Cars.Num() > 1)
				{
					T.SetRotation(T.GetRotation() * FQuat(FVector::UpVector, PI)); // хвостовой головной вагон развёрнут
				}
				CarActor->SetActorTransform(T);
			}
		}
	}
}

void APrimMetroLine::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const
{
	Super::GetLifetimeReplicatedProps(OutLifetimeProps);
	DOREPLIFETIME(APrimMetroLine, Trains);
}
