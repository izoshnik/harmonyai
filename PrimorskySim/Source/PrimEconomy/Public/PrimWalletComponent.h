#pragma once

#include "Components/ActorComponent.h"
#include "CoreMinimal.h"

#include "PrimWalletComponent.generated.h"

DECLARE_DYNAMIC_MULTICAST_DELEGATE(FPrimWalletChanged);

/**
 * Кошелёк персонажа (игрок/NPC): ссылки на счета в Ledger и реплицируемая ТОЛЬКО владельцу копия балансов для UI.
 * Изменить баланс через компонент нельзя — только через UPrimLedgerSubsystem на сервере.
 */
UCLASS(ClassGroup = (Prim), meta = (BlueprintSpawnableComponent))
class PRIMECONOMY_API UPrimWalletComponent : public UActorComponent
{
	GENERATED_BODY()

public:
	UPrimWalletComponent();

	virtual void GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const override;
	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type Reason) override;

	/** Сервер: создать счета для владельца (уникальный id — из persistence, пока из имени актора). */
	void InitAccounts(const FString& OwnerId);

	UFUNCTION(BlueprintPure, Category = "Economy")
	int64 GetCashKopecks() const { return CashKopecks; }

	UFUNCTION(BlueprintPure, Category = "Economy")
	int64 GetBankKopecks() const { return BankKopecks; }

	UPROPERTY(BlueprintReadOnly, Category = "Economy")
	FName CashAccount;

	UPROPERTY(BlueprintReadOnly, Category = "Economy")
	FName BankAccount;

	UPROPERTY(BlueprintAssignable, Category = "Economy")
	FPrimWalletChanged OnWalletChanged;

private:
	void HandleBalanceChanged(FName AccountId);
	void RefreshFromLedger();

	UFUNCTION()
	void OnRep_Balances();

	UPROPERTY(ReplicatedUsing = OnRep_Balances)
	int64 CashKopecks = 0;

	UPROPERTY(ReplicatedUsing = OnRep_Balances)
	int64 BankKopecks = 0;

	FDelegateHandle LedgerHandle;
};
