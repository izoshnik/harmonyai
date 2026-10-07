#pragma once

#include "CoreMinimal.h"
#include "GameplayTagContainer.h"
#include "SimCore/Ledger.h"
#include "Subsystems/WorldSubsystem.h"

#include "PrimLedgerSubsystem.generated.h"

UENUM(BlueprintType)
enum class EPrimAccountKind : uint8
{
	Cash,
	Bank,
	Business,
	CityBudget,
	Escrow,
};

UENUM(BlueprintType)
enum class EPrimPostResult : uint8
{
	Applied,
	Duplicate,
	Unbalanced,
	UnknownAccount,
	InsufficientFunds,
	Empty,
	Overflow,
	NotAuthority,
};

DECLARE_MULTICAST_DELEGATE_OneParam(FPrimBalanceChanged, FName /*AccountId*/);

/**
 * Серверная книга (двойная запись). На клиенте подсистема существует, но любые операции возвращают NotAuthority.
 * Хранилище сейчас в памяти; запись в PostgreSQL — через IPrimLedgerBackend (этап 5 Roadmap).
 */
UCLASS()
class PRIMECONOMY_API UPrimLedgerSubsystem : public UWorldSubsystem
{
	GENERATED_BODY()

public:
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;

	static FName CityBudgetAccount() { return FName(TEXT("city.budget")); }

	bool OpenAccount(FName AccountId, EPrimAccountKind Kind);
	int64 GetBalance(FName AccountId) const;

	/** Перевод в копейках. IdempotencyKey обязателен: повтор не применяется. */
	EPrimPostResult Transfer(const FString& IdempotencyKey, FName From, FName To, int64 AmountKopecks, FGameplayTag Reason);

	/** Произвольная сбалансированная проводка. */
	EPrimPostResult Post(const FString& IdempotencyKey, const TArray<TPair<FName, int64>>& Postings, FGameplayTag Reason);

	FPrimBalanceChanged OnBalanceChanged;

private:
	bool HasAuthority() const;
	static EPrimPostResult Convert(SimCore::PostResult R);

	SimCore::Ledger Ledger;
};
