#include "Camera/CameraComponent.h"
#include "Components/CapsuleComponent.h"
#include "EnhancedInputComponent.h"
#include "EnhancedInputSubsystems.h"
#include "Engine/LocalPlayer.h"
#include "Engine/World.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "GameFramework/PlayerState.h"
#include "GameFramework/SpringArmComponent.h"
#include "Net/UnrealNetwork.h"
#include "PrimCharacter.h"
#include "PrimGameMode.h"
#include "PrimGameState.h"
#include "PrimInteractableComponent.h"
#include "PrimInteractorComponent.h"
#include "PrimLedgerSubsystem.h"
#include "PrimPlayerController.h"
#include "PrimTags.h"
#include "PrimWalletComponent.h"

// ---------------------------------------------------------------- APrimGameState

void APrimGameState::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const
{
	Super::GetLifetimeReplicatedProps(OutLifetimeProps);
	DOREPLIFETIME(APrimGameState, WorldTime);
}

double APrimGameState::GetWorldSeconds() const
{
	return WorldTime.WorldSecondsAt(GetServerWorldTimeSeconds());
}

void APrimGameState::SetWorldTime(double WorldSeconds, float TimeScale)
{
	check(HasAuthority());
	WorldTime.AnchorServerTime = GetServerWorldTimeSeconds();
	WorldTime.AnchorWorldSeconds = WorldSeconds;
	WorldTime.TimeScale = TimeScale;
	ForceNetUpdate();
}

// ---------------------------------------------------------------- APrimGameMode

APrimGameMode::APrimGameMode()
{
	GameStateClass = APrimGameState::StaticClass();
	PlayerControllerClass = APrimPlayerController::StaticClass();
	DefaultPawnClass = APrimCharacter::StaticClass(); // в DefaultGame.ini переопределяется на BP_PrimCharacter
}

void APrimGameMode::InitGameState()
{
	Super::InitGameState();
	if (APrimGameState* GS = GetGameState<APrimGameState>())
	{
		GS->SetWorldTime(DefaultStartWorldSeconds, DefaultTimeScale);
	}
}

void APrimGameMode::PostLogin(APlayerController* NewPlayer)
{
	Super::PostLogin(NewPlayer);

	APrimPlayerController* PC = Cast<APrimPlayerController>(NewPlayer);
	UPrimLedgerSubsystem* Ledger = GetWorld()->GetSubsystem<UPrimLedgerSubsystem>();
	if (!PC || !Ledger)
	{
		return;
	}
	// TODO(stage 5): стабильный id игрока из persistence/онлайн-подсистемы вместо UniqueNetId-строки.
	const FString PlayerId = TEXT("player.") + (PC->PlayerState ? PC->PlayerState->GetUniqueId().ToString() : PC->GetName());
	PC->Wallet->InitAccounts(PlayerId);

	// Идемпотентный ключ: повторный вход того же игрока не выдаёт деньги второй раз.
	const FName City = UPrimLedgerSubsystem::CityBudgetAccount();
	Ledger->Transfer(PlayerId + TEXT(".starter.cash"), City, PC->Wallet->CashAccount, StarterCashKopecks, PrimTags::Economy_Salary);
	Ledger->Transfer(PlayerId + TEXT(".starter.bank"), City, PC->Wallet->BankAccount, StarterBankKopecks, PrimTags::Economy_Salary);
}

// ---------------------------------------------------------------- APrimPlayerController

APrimPlayerController::APrimPlayerController()
{
	Interactor = CreateDefaultSubobject<UPrimInteractorComponent>(TEXT("Interactor"));
	Wallet = CreateDefaultSubobject<UPrimWalletComponent>(TEXT("Wallet"));
}

void APrimPlayerController::InteractWithFocus()
{
	FVector ViewLocation;
	FRotator ViewRotation;
	GetPlayerViewPoint(ViewLocation, ViewRotation);

	FCollisionQueryParams Query(SCENE_QUERY_STAT(PrimFocus), false, GetPawn());
	FHitResult Hit;
	const FVector End = ViewLocation + ViewRotation.Vector() * (FocusTraceLength + 400.f); // + плечо камеры
	if (!GetWorld()->LineTraceSingleByChannel(Hit, ViewLocation, End, ECC_Visibility, Query) || !Hit.GetActor())
	{
		return;
	}
	const UPrimInteractableComponent* Interactable = Hit.GetActor()->FindComponentByClass<UPrimInteractableComponent>();
	if (!Interactable)
	{
		return;
	}
	const FGameplayTagContainer Intents = Interactable->GetAvailableIntents();
	if (Intents.Num() > 0)
	{
		// Одно намерение — сразу; несколько — радиальное меню UI (вызывает RequestInteraction с выбранным).
		Interactor->RequestInteraction(Hit.GetActor(), Intents.GetByIndex(0), {});
	}
}

// ---------------------------------------------------------------- APrimCharacter

APrimCharacter::APrimCharacter()
{
	GetCapsuleComponent()->InitCapsuleSize(34.f, 88.f);
	bUseControllerRotationYaw = false;

	UCharacterMovementComponent* Move = GetCharacterMovement();
	Move->bOrientRotationToMovement = true;
	Move->RotationRate = FRotator(0.f, 540.f, 0.f);
	Move->MaxWalkSpeed = WalkSpeed;
	Move->NavAgentProps.bCanCrouch = true;

	CameraBoom = CreateDefaultSubobject<USpringArmComponent>(TEXT("CameraBoom"));
	CameraBoom->SetupAttachment(RootComponent);
	CameraBoom->TargetArmLength = 320.f;
	CameraBoom->SocketOffset = FVector(0.f, 45.f, 60.f);
	CameraBoom->bUsePawnControlRotation = true;

	Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
	Camera->SetupAttachment(CameraBoom, USpringArmComponent::SocketName);
	Camera->bUsePawnControlRotation = false;
}

void APrimCharacter::PawnClientRestart()
{
	Super::PawnClientRestart();
	if (const APlayerController* PC = Cast<APlayerController>(GetController()))
	{
		if (UEnhancedInputLocalPlayerSubsystem* Input = ULocalPlayer::GetSubsystem<UEnhancedInputLocalPlayerSubsystem>(PC->GetLocalPlayer()))
		{
			if (DefaultMapping)
			{
				Input->AddMappingContext(DefaultMapping, 0);
			}
		}
	}
}

void APrimCharacter::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)
{
	Super::SetupPlayerInputComponent(PlayerInputComponent);
	UEnhancedInputComponent* Input = Cast<UEnhancedInputComponent>(PlayerInputComponent);
	if (!Input)
	{
		return;
	}
	if (MoveAction) Input->BindAction(MoveAction, ETriggerEvent::Triggered, this, &APrimCharacter::Move);
	if (LookAction) Input->BindAction(LookAction, ETriggerEvent::Triggered, this, &APrimCharacter::Look);
	if (JumpAction)
	{
		Input->BindAction(JumpAction, ETriggerEvent::Started, this, &ACharacter::Jump);
		Input->BindAction(JumpAction, ETriggerEvent::Completed, this, &ACharacter::StopJumping);
	}
	if (SprintAction)
	{
		Input->BindAction(SprintAction, ETriggerEvent::Started, this, &APrimCharacter::StartSprint);
		Input->BindAction(SprintAction, ETriggerEvent::Completed, this, &APrimCharacter::StopSprint);
	}
	if (InteractAction) Input->BindAction(InteractAction, ETriggerEvent::Started, this, &APrimCharacter::Interact);
}

void APrimCharacter::Move(const FInputActionValue& Value)
{
	const FVector2D Axis = Value.Get<FVector2D>();
	if (!Controller)
	{
		return;
	}
	const FRotator Yaw(0.f, Controller->GetControlRotation().Yaw, 0.f);
	AddMovementInput(FRotationMatrix(Yaw).GetUnitAxis(EAxis::X), Axis.Y);
	AddMovementInput(FRotationMatrix(Yaw).GetUnitAxis(EAxis::Y), Axis.X);
}

void APrimCharacter::Look(const FInputActionValue& Value)
{
	const FVector2D Axis = Value.Get<FVector2D>();
	AddControllerYawInput(Axis.X);
	AddControllerPitchInput(Axis.Y);
}

void APrimCharacter::StartSprint()
{
	ApplySprint(true);
	if (!HasAuthority())
	{
		ServerSetSprinting(true);
	}
}

void APrimCharacter::StopSprint()
{
	ApplySprint(false);
	if (!HasAuthority())
	{
		ServerSetSprinting(false);
	}
}

void APrimCharacter::ServerSetSprinting_Implementation(bool bNewSprinting)
{
	ApplySprint(bNewSprinting);
}

// TODO(stage 5): перенести спринт во флаги FSavedMove (custom CharacterMovement), чтобы не было коррекций при лаге.
void APrimCharacter::ApplySprint(bool bNewSprinting)
{
	// Сервер применяет ту же скорость: CharacterMovement корректирует клиента, если тот попытается бежать быстрее.
	GetCharacterMovement()->MaxWalkSpeed = bNewSprinting ? RunSpeed : WalkSpeed;
}

void APrimCharacter::Interact()
{
	if (APrimPlayerController* PC = Cast<APrimPlayerController>(Controller))
	{
		PC->InteractWithFocus();
	}
}
