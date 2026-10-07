#pragma once

#include "CoreMinimal.h"
#include "PrimGeoReference.h"
#include "Subsystems/GameInstanceSubsystem.h"

#include "PrimWorldManifestSubsystem.generated.h"

UENUM(BlueprintType)
enum class EPrimVerificationStatus : uint8
{
	Verified,
	PartiallyVerified,
	NeedsVerification,
	Unknown,
};

/** Запись WorldManifest (подмножество полей, нужное рантайму; полная схема — Data/Schemas). */
USTRUCT(BlueprintType)
struct PRIMWORLD_API FPrimWorldObject
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "World") FName ObjectId;
	UPROPERTY(BlueprintReadOnly, Category = "World") FName Category;
	UPROPERTY(BlueprintReadOnly, Category = "World") FString RealName;
	UPROPERTY(BlueprintReadOnly, Category = "World") FName Type;
	UPROPERTY(BlueprintReadOnly, Category = "World") bool bHasCoordinates = false;
	UPROPERTY(BlueprintReadOnly, Category = "World") double LatDeg = 0.0;
	UPROPERTY(BlueprintReadOnly, Category = "World") double LonDeg = 0.0;
	UPROPERTY(BlueprintReadOnly, Category = "World") EPrimVerificationStatus Status = EPrimVerificationStatus::Unknown;
	UPROPERTY(BlueprintReadOnly, Category = "World") FName DisplayNamePolicy;
	UPROPERTY(BlueprintReadOnly, Category = "World") bool bGameplayRequired = false;
	UPROPERTY(BlueprintReadOnly, Category = "World") bool bInteriorRequired = false;
	UPROPERTY(BlueprintReadOnly, Category = "World") TArray<FName> RelatedIds;
	/** attributes как сырой JSON — профильные системы (метро, здания) разбирают его сами. */
	UPROPERTY(BlueprintReadOnly, Category = "World") FString AttributesJson;
};

/**
 * Реестр реальных объектов мира. Источник — WorldReference/WorldManifest.json (стейджится как non-UFS файл).
 * Одинаков на сервере и клиенте; не реплицируется — это статические данные сборки.
 */
UCLASS()
class PRIMWORLD_API UPrimWorldManifestSubsystem : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;

	/** Загружает манифест из файла. Возвращает false и пишет ошибку в лог при сбое разбора. */
	bool LoadFromFile(const FString& Path);
	bool LoadFromString(const FString& Json);

	UFUNCTION(BlueprintCallable, Category = "World")
	bool FindObject(FName ObjectId, FPrimWorldObject& OutObject) const;

	UFUNCTION(BlueprintCallable, Category = "World")
	TArray<FPrimWorldObject> GetObjectsByCategory(FName Category) const;

	UFUNCTION(BlueprintCallable, Category = "World")
	int32 GetObjectCount() const { return Objects.Num(); }

	/** Позиция объекта в мире UE; false, если координаты не подтверждены или origin не задан. */
	UFUNCTION(BlueprintCallable, Category = "World")
	bool GetWorldLocation(FName ObjectId, FVector& OutLocation) const;

	const FPrimGeoReference& GetGeoReference() const { return GeoReference; }

	static FString DefaultManifestPath();

private:
	TMap<FName, FPrimWorldObject> Objects;
	FPrimGeoReference GeoReference;
};
