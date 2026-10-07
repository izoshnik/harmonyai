// Локальная поперечная проекция Меркатора (WGS84) для мира Приморского района.
// Чистый C++17 без зависимостей от UE: используется GIS-импортом, сервером и тестами.
// Формулы: Snyder, «Map Projections — A Working Manual» (USGS PP 1395), §8, k0 = 1.
#pragma once

#include <cmath>

namespace SimCore
{
struct GeoPoint
{
	double LatDeg = 0.0;
	double LonDeg = 0.0;
};

struct LocalPoint
{
	double EastM = 0.0;
	double NorthM = 0.0;
};

class GeoTransform
{
public:
	GeoTransform(double OriginLatDeg, double OriginLonDeg)
		: Lat0(Rad(OriginLatDeg)), Lon0(Rad(OriginLonDeg)), M0(Meridian(Rad(OriginLatDeg)))
	{
	}

	LocalPoint Forward(const GeoPoint& P) const
	{
		const double Phi = Rad(P.LatDeg);
		const double SinPhi = std::sin(Phi), CosPhi = std::cos(Phi), TanPhi = std::tan(Phi);
		const double N = A / std::sqrt(1.0 - E2 * SinPhi * SinPhi);
		const double T = TanPhi * TanPhi;
		const double C = Ep2 * CosPhi * CosPhi;
		const double Am = (Rad(P.LonDeg) - Lon0) * CosPhi;
		const double Am2 = Am * Am;
		const double M = Meridian(Phi);

		LocalPoint Out;
		Out.EastM = N * (Am + (1 - T + C) * Am2 * Am / 6.0 + (5 - 18 * T + T * T + 72 * C - 58 * Ep2) * Am2 * Am2 * Am / 120.0);
		Out.NorthM = M - M0 + N * TanPhi * (Am2 / 2.0 + (5 - T + 9 * C + 4 * C * C) * Am2 * Am2 / 24.0 + (61 - 58 * T + T * T + 600 * C - 330 * Ep2) * Am2 * Am2 * Am2 / 720.0);
		return Out;
	}

	// Обратное преобразование итерацией Ньютона по Forward: в пределах района сходится за 3–4 шага.
	GeoPoint Inverse(const LocalPoint& L) const
	{
		GeoPoint G{Deg(Lat0) + L.NorthM / 111132.0, Deg(Lon0) + L.EastM / (111320.0 * std::cos(Lat0))};
		for (int Iter = 0; Iter < 8; ++Iter)
		{
			const LocalPoint F = Forward(G);
			const double DE = L.EastM - F.EastM, DN = L.NorthM - F.NorthM;
			if (std::abs(DE) < 1e-6 && std::abs(DN) < 1e-6)
			{
				break;
			}
			G.LatDeg += DN / 111132.0;
			G.LonDeg += DE / (111320.0 * std::cos(Rad(G.LatDeg)));
		}
		return G;
	}

private:
	static constexpr double Pi = 3.14159265358979323846;
	static constexpr double A = 6378137.0;
	static constexpr double F = 1.0 / 298.257223563;
	static constexpr double E2 = F * (2 - F);
	static constexpr double Ep2 = E2 / (1 - E2);

	static double Rad(double D) { return D * Pi / 180.0; }
	static double Deg(double R) { return R * 180.0 / Pi; }

	static double Meridian(double Phi)
	{
		const double E4 = E2 * E2, E6 = E4 * E2;
		return A * ((1 - E2 / 4 - 3 * E4 / 64 - 5 * E6 / 256) * Phi
			- (3 * E2 / 8 + 3 * E4 / 32 + 45 * E6 / 1024) * std::sin(2 * Phi)
			+ (15 * E4 / 256 + 45 * E6 / 1024) * std::sin(4 * Phi)
			- (35 * E6 / 3072) * std::sin(6 * Phi));
	}

	double Lat0;
	double Lon0;
	double M0;
};
} // namespace SimCore
