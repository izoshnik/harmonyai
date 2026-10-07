#pragma once

#include "CoreMinimal.h"
#include "SimCore/GeoTransform.h"

#include "PrimGeoReference.generated.h"

/**
 * Привязка мира UE к географии. Origin задаётся один раз (WorldManifest.crs.engine_origin).
 * UE: 1 uu = 1 см, X = восток, Y = юг (левосторонняя система), Z = высота над базовой отметкой.
 */
USTRUCT(BlueprintType)
struct PRIMCORE_API FPrimGeoReference
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Geo")
	double OriginLatDeg = 0.0;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Geo")
	double OriginLonDeg = 0.0;

	/** Высота (Балтийская система, м), соответствующая Z = 0. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Geo")
	double BaseAltitudeM = 0.0;

	bool IsSet() const { return OriginLatDeg != 0.0 || OriginLonDeg != 0.0; }

	FVector GeoToWorld(double LatDeg, double LonDeg, double AltitudeM = 0.0) const
	{
		const SimCore::LocalPoint P = SimCore::GeoTransform(OriginLatDeg, OriginLonDeg).Forward({LatDeg, LonDeg});
		return FVector(P.EastM * 100.0, -P.NorthM * 100.0, (AltitudeM - BaseAltitudeM) * 100.0);
	}

	void WorldToGeo(const FVector& World, double& OutLatDeg, double& OutLonDeg) const
	{
		const SimCore::GeoPoint G = SimCore::GeoTransform(OriginLatDeg, OriginLonDeg).Inverse({World.X / 100.0, -World.Y / 100.0});
		OutLatDeg = G.LatDeg;
		OutLonDeg = G.LonDeg;
	}
};
