#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "Net/UnrealNetwork.h"
#include "PrimLedgerSubsystem.h"
#include "PrimWalletComponent.h"

DEFINE_LOG_CATEGORY_STATIC(LogPrimEconomy, Log, All);

namespace
{
std::string ToStd(FName Name) { return std::string(TCHAR_TO_UTF8(*Name.ToString())); }
std::string ToStd(const FString& S) { return std::string(TCHAR_TO_UTF8(*S)); }
} // namespace

// ---------------------------------------------------------------- UPrimLedgerSubsystem

void UPrimLedgerSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);
	Ledger.OpenAccount(ToStd(CityBudgetAccount()), SimCore::AccountKind::CityBudget);
}

bool UPrimLedgerSubsystem::HasAuthority() const
{
	const UWorld* World = GetWorld();
	return World && World->GetNetMode() != NM_Client;
}

bool UPrimLedgerSubsystem::OpenAccount(FName AccountId, EPrimAccountKind Kind)
{
	return HasAuthority() && Ledger.OpenAccount(ToStd(AccountId), static_cast<SimCore::AccountKind>(Kind));
}

int64 UPrimLedgerSubsystem::GetBalance(FName AccountId) const
{
	return HasAuthority() ? Ledger.Balance(ToStd(AccountId)) : 0;
}

EPrimPostResult UPrimLedgerSubsystem::Transfer(const FString& IdempotencyKey, FName From, FName To, int64 AmountKopecks, FGameplayTag Reason)
{
	if (AmountKopecks <= 0)
	{
		return EPrimPostResult::Empty;
	}
	TArray<TPair<FName, int64>> Postings;
	Postings.Emplace(From, -AmountKopecks);
	Postings.Emplace(To, AmountKopecks);
	return Post(IdempotencyKey, Postings, Reason);
}

EPrimPostResult UPrimLedgerSubsystem::Post(const FString& IdempotencyKey, const TArray<TPair<FName, int64>>& Postings, FGameplayTag Reason)
{
	if (!HasAuthority())
	{
		return EPrimPostResult::NotAuthority;
	}
	SimCore::Transaction Tx;
	Tx.IdempotencyKey = ToStd(IdempotencyKey);
	Tx.ReasonTag = ToStd(Reason.ToString());
	for (const TPair<FName, int64>& P : Postings)
	{
		if (P.Value == 0)
		{
			continue;
		}
		Tx.Postings.push_back({ToStd(P.Key), P.Value});
	}
	const EPrimPostResult Result = Convert(Ledger.Post(Tx));
	if (Result == EPrimPostResult::Applied)
	{
		for (const TPair<FName, int64>& P : Postings)
		{
			OnBalanceChanged.Broadcast(P.Key);
		}
	}
	else if (Result != EPrimPostResult::Duplicate)
	{
		UE_LOG(LogPrimEconomy, Verbose, TEXT("Ledger rejected %s: %d"), *IdempotencyKey, static_cast<int32>(Result));
	}
	return Result;
}

EPrimPostResult UPrimLedgerSubsystem::Convert(SimCore::PostResult R)
{
	switch (R)
	{
	case SimCore::PostResult::Applied: return EPrimPostResult::Applied;
	case SimCore::PostResult::Duplicate: return EPrimPostResult::Duplicate;
	case SimCore::PostResult::Unbalanced: return EPrimPostResult::Unbalanced;
	case SimCore::PostResult::UnknownAccount: return EPrimPostResult::UnknownAccount;
	case SimCore::PostResult::InsufficientFunds: return EPrimPostResult::InsufficientFunds;
	case SimCore::PostResult::Empty: return EPrimPostResult::Empty;
	case SimCore::PostResult::Overflow: return EPrimPostResult::Overflow;
	}
	return EPrimPostResult::Empty;
}

// ---------------------------------------------------------------- UPrimWalletComponent

UPrimWalletComponent::UPrimWalletComponent()
{
	PrimaryComponentTick.bCanEverTick = false;
	SetIsReplicatedByDefault(true);
}

void UPrimWalletComponent::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const
{
	Super::GetLifetimeReplicatedProps(OutLifetimeProps);
	DOREPLIFETIME_CONDITION(UPrimWalletComponent, CashKopecks, COND_OwnerOnly);
	DOREPLIFETIME_CONDITION(UPrimWalletComponent, BankKopecks, COND_OwnerOnly);
}

void UPrimWalletComponent::BeginPlay()
{
	Super::BeginPlay();
	if (GetOwner()->HasAuthority())
	{
		if (UPrimLedgerSubsystem* Ledger = GetWorld()->GetSubsystem<UPrimLedgerSubsystem>())
		{
			LedgerHandle = Ledger->OnBalanceChanged.AddUObject(this, &UPrimWalletComponent::HandleBalanceChanged);
		}
	}
}

void UPrimWalletComponent::EndPlay(const EEndPlayReason::Type Reason)
{
	if (UPrimLedgerSubsystem* Ledger = GetWorld() ? GetWorld()->GetSubsystem<UPrimLedgerSubsystem>() : nullptr)
	{
		Ledger->OnBalanceChanged.Remove(LedgerHandle);
	}
	Super::EndPlay(Reason);
}

void UPrimWalletComponent::InitAccounts(const FString& OwnerId)
{
	check(GetOwner()->HasAuthority());
	UPrimLedgerSubsystem* Ledger = GetWorld()->GetSubsystem<UPrimLedgerSubsystem>();
	CashAccount = FName(OwnerId + TEXT(".cash"));
	BankAccount = FName(OwnerId + TEXT(".bank"));
	Ledger->OpenAccount(CashAccount, EPrimAccountKind::Cash);
	Ledger->OpenAccount(BankAccount, EPrimAccountKind::Bank);
	RefreshFromLedger();
}

void UPrimWalletComponent::HandleBalanceChanged(FName AccountId)
{
	if (AccountId == CashAccount || AccountId == BankAccount)
	{
		RefreshFromLedger();
	}
}

void UPrimWalletComponent::RefreshFromLedger()
{
	const UPrimLedgerSubsystem* Ledger = GetWorld()->GetSubsystem<UPrimLedgerSubsystem>();
	CashKopecks = Ledger->GetBalance(CashAccount);
	BankKopecks = Ledger->GetBalance(BankAccount);
	OnWalletChanged.Broadcast(); // listen-server / сервер
}

void UPrimWalletComponent::OnRep_Balances()
{
	OnWalletChanged.Broadcast();
}
