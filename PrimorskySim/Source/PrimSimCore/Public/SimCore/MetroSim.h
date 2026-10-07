// Серверная симуляция движения поездов метро по линии (без UE).
// Позиция поезда — пикетаж (м) вдоль пути. Два пути (направления), оборот на конечных.
// Интервальное регулирование упрощённо: поезд не подходит к впереди идущему ближе SafetyGapM.
// Визуальные Actor'ы (ATrainActor) читают это состояние и интерполируют по сплайну трассы.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <string>
#include <vector>

namespace SimCore
{
struct TrainType
{
	std::string Id;
	double MaxSpeedMps = 22.2;   // значения по умолчанию — заглушки до верификации «Балтийца»
	double AccelMps2 = 1.0;
	double ServiceDecelMps2 = 1.0;
	double LengthM = 156.0;
	double DoorOpenS = 3.0;
	double DoorCloseS = 3.5;
};

struct StationStop
{
	std::string StationId;
	double ChainageM = 0.0;
	double DwellS = 25.0; // время с открытыми дверями
};

struct LineConfig
{
	std::string LineId;
	std::vector<StationStop> Stops; // по возрастанию пикетажа
	double TurnaroundS = 120.0;
	double SafetyGapM = 60.0;
};

enum class TrainPhase : std::uint8_t
{
	Running,
	DoorsOpening,
	DoorsOpen,
	DoorsClosing,
	Turnaround,
};

struct TrainState
{
	std::string TrainId;
	int Direction = +1;     // +1 — по возрастанию пикетажа, -1 — обратно
	double ChainageM = 0.0; // позиция головы поезда
	double SpeedMps = 0.0;
	int TargetStop = 0;     // индекс в LineConfig::Stops
	TrainPhase Phase = TrainPhase::DoorsOpen;
	double PhaseTimeLeftS = 0.0;
};

class MetroLineSim
{
public:
	MetroLineSim(LineConfig InLine, TrainType InType) : Line(std::move(InLine)), Type(std::move(InType)) {}

	const LineConfig& GetLine() const { return Line; }
	const std::vector<TrainState>& GetTrains() const { return Trains; }

	// Выпуск поезда стоящим на станции с открытыми дверями.
	void AddTrain(const std::string& Id, int StopIndex, int Direction)
	{
		TrainState T;
		T.TrainId = Id;
		T.Direction = Direction;
		T.TargetStop = StopIndex;
		T.ChainageM = Line.Stops.at(StopIndex).ChainageM;
		T.Phase = TrainPhase::DoorsOpen;
		T.PhaseTimeLeftS = Line.Stops.at(StopIndex).DwellS;
		Trains.push_back(T);
	}

	void Step(double Dt)
	{
		for (size_t I = 0; I < Trains.size(); ++I)
		{
			StepTrain(Trains[I], Dt, LimitFor(I));
		}
	}

	// Кинематика: поезд останавливается у целевой станции или перед впереди идущим.
	static double BrakingDistance(double V, double Decel) { return V * V / (2.0 * Decel); }

private:
	// Ближайшая точка, дальше которой поезду нельзя: хвост впереди идущего по тому же пути минус зазор.
	double LimitFor(size_t Self) const
	{
		const TrainState& Me = Trains[Self];
		double Limit = Me.Direction > 0 ? std::numeric_limits<double>::infinity() : -std::numeric_limits<double>::infinity();
		for (size_t J = 0; J < Trains.size(); ++J)
		{
			const TrainState& O = Trains[J];
			if (J == Self || O.Direction != Me.Direction || O.Phase == TrainPhase::Turnaround)
			{
				continue;
			}
			const double Tail = O.ChainageM - O.Direction * Type.LengthM;
			if (Me.Direction > 0 && O.ChainageM > Me.ChainageM)
			{
				Limit = std::min(Limit, Tail - Line.SafetyGapM);
			}
			else if (Me.Direction < 0 && O.ChainageM < Me.ChainageM)
			{
				Limit = std::max(Limit, Tail + Line.SafetyGapM);
			}
		}
		return Limit;
	}

	void StepTrain(TrainState& T, double Dt, double Limit)
	{
		switch (T.Phase)
		{
		case TrainPhase::Running:
			Run(T, Dt, Limit);
			return;
		case TrainPhase::DoorsOpening:
			Advance(T, Dt, TrainPhase::DoorsOpen, Line.Stops[T.TargetStop].DwellS);
			return;
		case TrainPhase::DoorsOpen:
			Advance(T, Dt, TrainPhase::DoorsClosing, Type.DoorCloseS);
			return;
		case TrainPhase::DoorsClosing:
			T.PhaseTimeLeftS -= Dt;
			if (T.PhaseTimeLeftS <= 0)
			{
				Depart(T);
			}
			return;
		case TrainPhase::Turnaround:
			T.PhaseTimeLeftS -= Dt;
			if (T.PhaseTimeLeftS <= 0)
			{
				T.Phase = TrainPhase::DoorsOpening;
				T.PhaseTimeLeftS = Type.DoorOpenS;
			}
			return;
		}
	}

	static void Advance(TrainState& T, double Dt, TrainPhase Next, double NextDuration)
	{
		T.PhaseTimeLeftS -= Dt;
		if (T.PhaseTimeLeftS <= 0)
		{
			T.Phase = Next;
			T.PhaseTimeLeftS = NextDuration;
		}
	}

	void Depart(TrainState& T)
	{
		const int Last = static_cast<int>(Line.Stops.size()) - 1;
		const bool AtTerminal = (T.Direction > 0 && T.TargetStop == Last) || (T.Direction < 0 && T.TargetStop == 0);
		if (AtTerminal)
		{
			// Оборот: смена пути и направления, та же станция становится отправной.
			T.Direction = -T.Direction;
			T.Phase = TrainPhase::Turnaround;
			T.PhaseTimeLeftS = Line.TurnaroundS;
			return;
		}
		T.TargetStop += T.Direction;
		T.Phase = TrainPhase::Running;
	}

	void Run(TrainState& T, double Dt, double Limit)
	{
		const double StopAt = Line.Stops[T.TargetStop].ChainageM;
		const bool StopIsStation = T.Direction > 0 ? StopAt <= Limit : StopAt >= Limit;
		const double Goal = StopIsStation ? StopAt : Limit;
		const double Dist = std::max(0.0, (Goal - T.ChainageM) * T.Direction);

		double V = T.SpeedMps;
		if (Dist <= BrakingDistance(V, Type.ServiceDecelMps2) + V * Dt)
		{
			// Торможение ровно к точке остановки (замедление ограничено 1.5× служебного).
			const double Need = Dist > 1e-3 ? V * V / (2.0 * Dist) : Type.ServiceDecelMps2 * 1.5;
			V = std::max(0.0, V - std::min(Need, Type.ServiceDecelMps2 * 1.5) * Dt);
		}
		else
		{
			V = std::min(Type.MaxSpeedMps, V + Type.AccelMps2 * Dt);
		}
		const double Move = std::min(V * Dt, Dist);
		T.ChainageM += Move * T.Direction;
		T.SpeedMps = V;

		if (StopIsStation && std::abs(StopAt - T.ChainageM) < 0.05 && V < 0.3)
		{
			T.ChainageM = StopAt;
			T.SpeedMps = 0;
			T.Phase = TrainPhase::DoorsOpening;
			T.PhaseTimeLeftS = Type.DoorOpenS;
		}
	}

	LineConfig Line;
	TrainType Type;
	std::vector<TrainState> Trains;
};
} // namespace SimCore
