// Серверная книга с двойной записью. Деньги — int64 копейки.
// Единственный путь изменения баланса в игре; клиент, Blueprint и LLM могут только запросить проводку.
#pragma once

#include <cstdint>
#include <limits>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace SimCore
{
using Kopecks = std::int64_t;

enum class AccountKind : std::uint8_t
{
	Cash,
	Bank,
	Business,
	CityBudget, // может уходить в минус (эмиссия/дотации города)
	Escrow,
};

struct Posting
{
	std::string AccountId;
	Kopecks Amount = 0; // + зачисление, - списание
};

struct Transaction
{
	std::string IdempotencyKey; // повтор с тем же ключом не применяется второй раз
	std::string ReasonTag;      // Gameplay Tag, например "Economy.Purchase.Grocery"
	std::vector<Posting> Postings;
};

enum class PostResult : std::uint8_t
{
	Applied,
	Duplicate,
	Unbalanced,
	UnknownAccount,
	InsufficientFunds,
	Empty,
	Overflow,
};

// Переносимая проверка переполнения (MSVC не поддерживает __builtin_add_overflow).
inline bool CheckedAdd(Kopecks A, Kopecks B, Kopecks& Out)
{
	if ((B > 0 && A > std::numeric_limits<Kopecks>::max() - B) || (B < 0 && A < std::numeric_limits<Kopecks>::min() - B))
	{
		return false;
	}
	Out = A + B;
	return true;
}

class Ledger
{
public:
	bool OpenAccount(const std::string& Id, AccountKind Kind)
	{
		return Accounts.emplace(Id, Account{Kind, 0}).second;
	}

	bool HasAccount(const std::string& Id) const { return Accounts.count(Id) != 0; }

	Kopecks Balance(const std::string& Id) const
	{
		auto It = Accounts.find(Id);
		return It == Accounts.end() ? 0 : It->second.Balance;
	}

	// Атомарно: либо все проводки применены, либо ни одной.
	PostResult Post(const Transaction& Tx)
	{
		if (Tx.Postings.empty() || Tx.IdempotencyKey.empty())
		{
			return PostResult::Empty;
		}
		if (Applied.count(Tx.IdempotencyKey))
		{
			return PostResult::Duplicate;
		}

		std::unordered_map<std::string, Kopecks> Delta;
		Kopecks Sum = 0;
		for (const Posting& P : Tx.Postings)
		{
			if (!HasAccount(P.AccountId))
			{
				return PostResult::UnknownAccount;
			}
			Kopecks& D = Delta[P.AccountId];
			if (!CheckedAdd(Sum, P.Amount, Sum) || !CheckedAdd(D, P.Amount, D))
			{
				return PostResult::Overflow;
			}
		}
		if (Sum != 0)
		{
			return PostResult::Unbalanced;
		}
		for (const auto& [Id, D] : Delta)
		{
			const Account& Acc = Accounts.at(Id);
			Kopecks NewBalance = 0;
			if (!CheckedAdd(Acc.Balance, D, NewBalance))
			{
				return PostResult::Overflow;
			}
			if (NewBalance < 0 && Acc.Kind != AccountKind::CityBudget)
			{
				return PostResult::InsufficientFunds;
			}
		}
		for (const auto& [Id, D] : Delta)
		{
			Accounts.at(Id).Balance += D;
		}
		Applied.insert(Tx.IdempotencyKey);
		Journal.push_back(Tx);
		return PostResult::Applied;
	}

	// Простой перевод — частный случай двух проводок.
	PostResult Transfer(const std::string& Key, const std::string& From, const std::string& To, Kopecks Amount, const std::string& Reason)
	{
		if (Amount <= 0)
		{
			return PostResult::Empty;
		}
		return Post(Transaction{Key, Reason, {{From, -Amount}, {To, Amount}}});
	}

	const std::vector<Transaction>& GetJournal() const { return Journal; }

	// Инвариант двойной записи: сумма всех балансов равна нулю
	// (у CityBudget отрицательный баланс — это деньги, выпущенные в экономику).
	Kopecks TotalBalance() const
	{
		Kopecks Total = 0;
		for (const auto& [Id, Acc] : Accounts)
		{
			Total += Acc.Balance;
		}
		return Total;
	}

private:
	struct Account
	{
		AccountKind Kind;
		Kopecks Balance;
	};

	std::unordered_map<std::string, Account> Accounts;
	std::unordered_set<std::string> Applied;
	std::vector<Transaction> Journal;
};
} // namespace SimCore
