// Тесты чистого ядра симуляции. Собираются без UE:
//   g++ -std=c++17 -Wall -Wextra -Werror -ISource/PrimSimCore/Public Tests/SimCore/SimCoreTests.cpp -o simcore_tests && ./simcore_tests
#include "SimCore/GeoTransform.h"
#include "SimCore/Ledger.h"
#include "SimCore/MetroSim.h"

#include <cmath>
#include <cstdio>
#include <functional>

namespace
{
int Failures = 0;

void Check(bool Cond, const char* What)
{
	if (!Cond)
	{
		std::printf("FAIL: %s\n", What);
		++Failures;
	}
}

void TestGeo()
{
	using namespace SimCore;
	const GeoTransform Geo(60.0, 30.2);
	const LocalPoint O = Geo.Forward({60.0, 30.2});
	Check(std::abs(O.EastM) < 1e-6 && std::abs(O.NorthM) < 1e-6, "origin maps to 0,0");

	// 0.01° широты около 60° ≈ 1113.9 м (длина дуги меридиана WGS84)
	const LocalPoint N = Geo.Forward({60.01, 30.2});
	Check(std::abs(N.NorthM - 1113.9) < 1.0 && std::abs(N.EastM) < 1e-6, "north offset ~1113.9 m");

	// 0.01° долготы на 60° ≈ 557.8 м
	const LocalPoint E = Geo.Forward({60.0, 30.21});
	Check(std::abs(E.EastM - 557.8) < 1.0, "east offset ~557.8 m");

	// Обратимость на краю района (~15 км) с точностью до сантиметра
	const GeoPoint P{60.08, 29.95};
	const GeoPoint R = Geo.Inverse(Geo.Forward(P));
	Check(std::abs(R.LatDeg - P.LatDeg) < 1e-7 && std::abs(R.LonDeg - P.LonDeg) < 1e-7, "inverse round-trip");
}

void TestLedger()
{
	using namespace SimCore;
	Ledger L;
	L.OpenAccount("city", AccountKind::CityBudget);
	L.OpenAccount("p1.bank", AccountKind::Bank);
	L.OpenAccount("shop", AccountKind::Business);

	Check(L.Transfer("salary-1", "city", "p1.bank", 5000000, "Economy.Salary") == PostResult::Applied, "salary applied");
	Check(L.Transfer("salary-1", "city", "p1.bank", 5000000, "Economy.Salary") == PostResult::Duplicate, "idempotent repeat");
	Check(L.Balance("p1.bank") == 5000000, "balance after salary");
	Check(L.Transfer("buy-1", "p1.bank", "shop", 6000000, "Economy.Purchase") == PostResult::InsufficientFunds, "no overdraft");
	Check(L.Balance("p1.bank") == 5000000 && L.Balance("shop") == 0, "failed tx is atomic");
	Check(L.Post({"bad", "x", {{"p1.bank", -100}, {"shop", 99}}}) == PostResult::Unbalanced, "unbalanced rejected");
	Check(L.Post({"ghost", "x", {{"p1.bank", -100}, {"nobody", 100}}}) == PostResult::UnknownAccount, "unknown account");
	Check(L.Transfer("neg", "p1.bank", "shop", -5, "x") == PostResult::Empty, "negative transfer rejected");
	Check(L.Transfer("buy-2", "p1.bank", "shop", 12999, "Economy.Purchase") == PostResult::Applied, "purchase");
	Check(L.TotalBalance() == 0, "double-entry invariant");
	Check(L.Post({"ovf", "x", {{"city", std::numeric_limits<Kopecks>::min()}, {"shop", std::numeric_limits<Kopecks>::max()}, {"shop", 1}}}) == PostResult::Overflow, "overflow detected");
	Check(L.GetJournal().size() == 2, "journal holds only applied");
}

SimCore::MetroLineSim MakeLine(int Trains)
{
	using namespace SimCore;
	LineConfig Line{"TEST", {{"A", 0, 20}, {"B", 1500, 20}, {"C", 3300, 20}}, 60, 60};
	MetroLineSim Sim(Line, TrainType{});
	for (int I = 0; I < Trains; ++I)
	{
		Sim.AddTrain("T" + std::to_string(I), 0, +1);
	}
	return Sim;
}

void TestMetro()
{
	using namespace SimCore;
	MetroLineSim Sim = MakeLine(1);
	double MaxSpeed = 0;
	bool ReachedB = false, ReachedC = false, TurnedBack = false, Overshoot = false;
	for (int Tick = 0; Tick < 20 * 60 * 10; ++Tick) // 20 минут, шаг 0.1 с
	{
		Sim.Step(0.1);
		const TrainState& T = Sim.GetTrains()[0];
		MaxSpeed = std::max(MaxSpeed, T.SpeedMps);
		Overshoot |= T.ChainageM < -0.01 || T.ChainageM > 3300.01;
		if (T.Phase == TrainPhase::DoorsOpen && T.TargetStop == 1)
		{
			ReachedB |= std::abs(T.ChainageM - 1500) < 0.01 && T.SpeedMps == 0;
		}
		if (T.Phase == TrainPhase::DoorsOpen && T.TargetStop == 2)
		{
			ReachedC = true;
		}
		TurnedBack |= ReachedC && T.Direction < 0 && T.Phase == TrainPhase::Running;
	}
	Check(ReachedB, "train stops exactly at B with doors open");
	Check(ReachedC, "train reaches terminal C");
	Check(TurnedBack, "train turns around at terminal");
	Check(!Overshoot, "train never leaves the line");
	Check(MaxSpeed <= TrainType{}.MaxSpeedMps + 1e-9, "speed limit respected");

	// Два поезда в одном направлении: второй не догоняет первый.
	MetroLineSim Two = MakeLine(0);
	Two.AddTrain("Lead", 1, +1);
	Two.AddTrain("Follow", 0, +1);
	bool Collision = false;
	for (int Tick = 0; Tick < 6000; ++Tick)
	{
		Two.Step(0.1);
		const TrainState& A = Two.GetTrains()[0];
		const TrainState& B = Two.GetTrains()[1];
		if (A.Direction > 0 && B.Direction > 0 && A.Phase != TrainPhase::Turnaround && B.ChainageM > A.ChainageM - TrainType{}.LengthM)
		{
			Collision = true;
		}
	}
	Check(!Collision, "follower keeps safety gap");
}
} // namespace

int main()
{
	TestGeo();
	TestLedger();
	TestMetro();
	if (Failures == 0)
	{
		std::printf("SimCore tests: all passed\n");
	}
	return Failures == 0 ? 0 : 1;
}
