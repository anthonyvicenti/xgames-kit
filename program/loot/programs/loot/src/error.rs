use anchor_lang::prelude::*;

#[error_code]
pub enum LootError {
    // ---- who may sign
    #[msg("Signer is not the game's owner")]
    NotOwner,
    #[msg("Signer is not the game's owner or its authority")]
    NotTheGames,
    #[msg("Signer is not the game's authority")]
    NotAuthority,
    #[msg("Signer is not the platform admin or the program's upgrade authority")]
    NotPlatform,

    // ---- settings
    #[msg("Collection is not a Core collection this signer controls")]
    BadCollection,
    #[msg("This collection can freeze, move or burn its assets whoever holds them")]
    CollectionCanSeize,
    #[msg("Fee is above the cap")]
    FeeAboveCap,
    #[msg("Name or URI too long")]
    StringTooLong,
    #[msg("Box needs 1 to 8 entries with non-zero weights and non-zero prizes (none that burns in wrapped SOL)")]
    BadEntries,
    #[msg("A split takes at most 4 shares that add up to 100% or less (exactly 100% for a box in another mint; none that burns in wrapped SOL)")]
    BadShares,
    #[msg("Max supply is below the units already out (issued, less voided)")]
    SupplyBelowIssued,
    #[msg("A pool that still holds tokens can't be closed")]
    PoolNotEmpty,
    #[msg("An item's kind, name, life, soulbound and burnable flags can't change once one is issued")]
    KindLocked,

    // ---- money in
    #[msg("Game is paused by its owner")]
    Paused,
    #[msg("Game is suspended by the platform")]
    Suspended,
    #[msg("Amount must be above zero")]
    ZeroAmount,
    #[msg("Box, item or recipe is not on offer")]
    NotForSale,
    #[msg("Item is sold out")]
    SoldOut,
    #[msg("The price is above the most the buyer agreed to pay")]
    PriceAboveMax,
    #[msg("A share names an account that was not passed, or the wrong account was")]
    WrongPool,
    #[msg("A share for whoever holds a collectible must go to a token account of that mint that the holder owns")]
    NotTheHolders,
    #[msg("This is not the mint the price is in")]
    WrongMint,

    // ---- orders
    #[msg("Order is not in the right state")]
    BadOrderState,
    #[msg("Order is not stale yet")]
    NotStale,
    #[msg("Item or pool accounts don't match the box or the order")]
    ItemMismatch,
    #[msg("This order's outcome is settled by the other settle instruction")]
    WrongSettle,
    #[msg("The prize must go to a token account the order's player owns")]
    NotThePlayers,

    // ---- make
    #[msg("Only a collectible item can be made as an asset")]
    NotCollectible,

    // ---- mechanics that run without the authority
    #[msg("A schedule needs a period above zero, a share of 100% or less, and a move between two different pools")]
    BadSchedule,
    #[msg("This is not due yet")]
    NotDue,
    #[msg("This schedule is switched off or has done its last run")]
    ScheduleOver,
    #[msg("A lottery needs a price and a period above zero, a period of at most 1,000 years and a first draw between 1970 and 1,000 years later, a cut of 100% or less, and at most 8 places that each take something and together 100% or less")]
    BadLottery,
    #[msg("A lottery can't be changed while tickets of its round are sold")]
    RoundRunning,
    #[msg("Ticket sales are closed for this round")]
    SalesClosed,
    #[msg("This stake can't be taken out yet: its lock has not run")]
    StillLocked,
    #[msg("That is more than this position holds")]
    MoreThanStaked,
    #[msg("A recipe has up to 8 lines a side, takes up to 8 collectibles, no line of it is zero, and its needs and keeps name collectibles it has")]
    BadRecipe,
    #[msg("A recipe that takes or makes a collectible is crafted once at a time")]
    OnceAtATime,
    #[msg("A collectible handed in does not have the number this recipe asks for")]
    NeedNotMet,
    #[msg("This recipe was edited since the player saw it")]
    RecipeChanged,
    #[msg("This collectible is not ready yet: it is too new, or it was used too recently")]
    NotReady,
    #[msg("This collectible has expired")]
    Expired,
    #[msg("This collectible has no uses left")]
    UsedUp,
    #[msg("The game is holding this collectible for a player")]
    Held,
    #[msg("These are not the terms this contest has")]
    TermsChanged,
    #[msg("This contest's result was due: it can only be called off")]
    ResultOverdue,
    #[msg("This collectible is held until its time is up")]
    StillHeld,
    #[msg("The hold on this collectible is over: it can only go back to its player")]
    HoldOver,
    #[msg("A contest needs 2 or more sides, entries that close no later than its result is due, and a side that exists")]
    BadContest,
    #[msg("This contest is not open")]
    ContestNotOpen,
    #[msg("This contest has no result yet")]
    ContestOpen,
    #[msg("Nobody backed that side: call the contest off instead")]
    NoWinner,
    #[msg("This contest still has entries to claim")]
    EntriesLeft,
    #[msg("Not a token account")]
    NotATokenAccount,
    #[msg("Arithmetic overflow")]
    Overflow,

    // ---- the registry (official tokens)
    #[msg("Game has no official token")]
    NoToken,
    #[msg("These are not the venue's own accounts for this mint")]
    VenueAccounts,
    #[msg("Venue account layout is not one this program knows")]
    VenueLayout,
    #[msg("The wallet that launched the token must sign")]
    LauncherMustSign,
    #[msg("Meteora config: the fee claimer is not the games.fun partner")]
    FeeClaimerNotPartner,
    #[msg("Meteora config: the creator's trading fee share is above 95%")]
    CreatorFeeTooHigh,
    #[msg("Meteora config: the partner's permanently locked liquidity is below 5%")]
    PartnerLockTooLow,
    #[msg("Meteora config: the creator takes more than 95% of the migration fee")]
    CreatorMigrationFeeTooHigh,
    #[msg("Meteora config: the migrated pool compounds its fees instead of paying them out")]
    CompoundingFees,
    #[msg("pump.fun: no bonding curve for this mint")]
    NoBondingCurve,
    #[msg("pump.fun: no fee-sharing config for this mint")]
    NoFeeSharing,
    #[msg("pump.fun: the bonding curve does not pay the fee-sharing config")]
    CurveNotSharing,
    #[msg("pump.fun: fee sharing is not active")]
    SharingNotActive,
    #[msg("pump.fun: the fee-sharing admin is not revoked")]
    SharingAdminNotRevoked,
    #[msg("pump.fun: shareholders are not the launcher and the partner with at least 5%, together 100%")]
    ShareholdersMismatch,
    #[msg("pump.fun: this coin's creator fee goes to traders or holders, not to the fee-sharing config")]
    CreatorFeeDiverted,
    #[msg("A falling price needs a step and a period above zero, and a start that is not before 1970")]
    BadPrice,
    #[msg("This place has no winner this round, or was paid already")]
    PlacePaid,
    #[msg("Not a mint of the SPL Token program or of Token-2022")]
    NotAMint,
    #[msg("A destination requires a memo: pass the Memo program with the hook's accounts")]
    MemoNeeded,
    #[msg("The game can't pay into the account it pays from")]
    SameAccount,
    #[msg("An order closes in a later slot than the one it was opened in")]
    SameSlot,
    #[msg("The game can't be given a collectible: nothing could ever move it again")]
    ToTheGame,
}
