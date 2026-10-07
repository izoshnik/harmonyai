#include "PrimWorldManifestSubsystem.h"

#include "Dom/JsonObject.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

DEFINE_LOG_CATEGORY_STATIC(LogPrimWorld, Log, All);

namespace
{
EPrimVerificationStatus ParseStatus(const FString& S)
{
	if (S == TEXT("VERIFIED")) return EPrimVerificationStatus::Verified;
	if (S == TEXT("PARTIALLY_VERIFIED")) return EPrimVerificationStatus::PartiallyVerified;
	if (S == TEXT("NEEDS_VERIFICATION")) return EPrimVerificationStatus::NeedsVerification;
	return EPrimVerificationStatus::Unknown;
}
} // namespace

void UPrimWorldManifestSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);
	LoadFromFile(DefaultManifestPath());
}

FString UPrimWorldManifestSubsystem::DefaultManifestPath()
{
	return FPaths::Combine(FPaths::ProjectDir(), TEXT("WorldReference"), TEXT("WorldManifest.json"));
}

bool UPrimWorldManifestSubsystem::LoadFromFile(const FString& Path)
{
	FString Json;
	if (!FFileHelper::LoadFileToString(Json, *Path))
	{
		UE_LOG(LogPrimWorld, Error, TEXT("WorldManifest not found: %s"), *Path);
		return false;
	}
	return LoadFromString(Json);
}

bool UPrimWorldManifestSubsystem::LoadFromString(const FString& Json)
{
	TSharedPtr<FJsonObject> Root;
	if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), Root) || !Root.IsValid())
	{
		UE_LOG(LogPrimWorld, Error, TEXT("WorldManifest: invalid JSON"));
		return false;
	}

	Objects.Reset();
	GeoReference = FPrimGeoReference();

	const TSharedPtr<FJsonObject>* Crs = nullptr;
	const TSharedPtr<FJsonObject>* Origin = nullptr;
	if (Root->TryGetObjectField(TEXT("crs"), Crs) && (*Crs)->TryGetObjectField(TEXT("engine_origin"), Origin))
	{
		GeoReference.OriginLatDeg = (*Origin)->GetNumberField(TEXT("lat"));
		GeoReference.OriginLonDeg = (*Origin)->GetNumberField(TEXT("lon"));
	}

	const TArray<TSharedPtr<FJsonValue>>* Items = nullptr;
	if (!Root->TryGetArrayField(TEXT("objects"), Items))
	{
		UE_LOG(LogPrimWorld, Error, TEXT("WorldManifest: no objects array"));
		return false;
	}

	for (const TSharedPtr<FJsonValue>& Item : *Items)
	{
		const TSharedPtr<FJsonObject> O = Item->AsObject();
		if (!O.IsValid())
		{
			continue;
		}
		FPrimWorldObject Obj;
		Obj.ObjectId = FName(O->GetStringField(TEXT("object_id")));
		Obj.Category = FName(O->GetStringField(TEXT("category")));
		Obj.RealName = O->GetStringField(TEXT("real_name"));
		Obj.Type = FName(O->GetStringField(TEXT("type")));
		Obj.Status = ParseStatus(O->GetStringField(TEXT("verification_status")));
		Obj.bGameplayRequired = O->GetBoolField(TEXT("gameplay_required"));
		Obj.bInteriorRequired = O->GetBoolField(TEXT("interior_required"));

		FString Policy;
		Obj.DisplayNamePolicy = FName(O->TryGetStringField(TEXT("display_name_policy"), Policy) ? Policy : TEXT("undecided"));

		const TSharedPtr<FJsonObject>* Coords = nullptr;
		if (O->TryGetObjectField(TEXT("coordinates"), Coords))
		{
			Obj.bHasCoordinates = true;
			Obj.LatDeg = (*Coords)->GetNumberField(TEXT("lat"));
			Obj.LonDeg = (*Coords)->GetNumberField(TEXT("lon"));
		}

		const TArray<TSharedPtr<FJsonValue>>* Related = nullptr;
		if (O->TryGetArrayField(TEXT("related_ids"), Related))
		{
			for (const TSharedPtr<FJsonValue>& R : *Related)
			{
				Obj.RelatedIds.Add(FName(R->AsString()));
			}
		}

		const TSharedPtr<FJsonObject>* Attributes = nullptr;
		if (O->TryGetObjectField(TEXT("attributes"), Attributes))
		{
			const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Obj.AttributesJson);
			FJsonSerializer::Serialize(Attributes->ToSharedRef(), Writer);
		}

		if (Objects.Contains(Obj.ObjectId))
		{
			UE_LOG(LogPrimWorld, Error, TEXT("WorldManifest: duplicate object_id %s"), *Obj.ObjectId.ToString());
			continue;
		}
		Objects.Add(Obj.ObjectId, MoveTemp(Obj));
	}

	UE_LOG(LogPrimWorld, Log, TEXT("WorldManifest loaded: %d objects, geo origin %s"), Objects.Num(),
		GeoReference.IsSet() ? TEXT("set") : TEXT("NOT SET (boundary pending)"));
	return true;
}

bool UPrimWorldManifestSubsystem::FindObject(FName ObjectId, FPrimWorldObject& OutObject) const
{
	if (const FPrimWorldObject* Found = Objects.Find(ObjectId))
	{
		OutObject = *Found;
		return true;
	}
	return false;
}

TArray<FPrimWorldObject> UPrimWorldManifestSubsystem::GetObjectsByCategory(FName Category) const
{
	TArray<FPrimWorldObject> Result;
	for (const TPair<FName, FPrimWorldObject>& Pair : Objects)
	{
		if (Pair.Value.Category == Category)
		{
			Result.Add(Pair.Value);
		}
	}
	return Result;
}

bool UPrimWorldManifestSubsystem::GetWorldLocation(FName ObjectId, FVector& OutLocation) const
{
	const FPrimWorldObject* Found = Objects.Find(ObjectId);
	if (!Found || !Found->bHasCoordinates || !GeoReference.IsSet())
	{
		return false;
	}
	OutLocation = GeoReference.GeoToWorld(Found->LatDeg, Found->LonDeg);
	return true;
}
