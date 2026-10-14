// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/// @title MiningSites
/// @notice The vault behind MineWorldCraft's earnings. It holds half of $MINE's supply (500,000,000, minted here when
///         the token was deployed) and pays it out only to players, for what they earn in the game. Nobody, the owner
///         included, can take $MINE out any other way: the only transfer of it is in `claim`.
///
///         To convert earnings a wallet needs a mining site: opened once, with ETH (`sitePrice`), which goes straight
///         to the treasury (this contract never holds ETH). Sites can't be moved to another wallet.
///
///         The game's server keeps each wallet's earnings and signs an EIP-712 voucher for the wallet's lifetime total.
///         `claim` pays the difference from what the wallet was already paid, within two daily caps: one per wallet
///         and one across everyone. Whatever the caps hold back stays claimable later, because `claimed` only grows by
///         what was actually paid. A day is `block.timestamp / 1 days` (UTC).
/// @dev Trust, plainly:
///      - The signer key (the game server's) decides what each wallet has earned. If it leaks, whoever holds it can
///        sign any total for wallets they control, but each wallet needs a site (paid to the treasury) and is paid at
///        most `walletDailyCap` a day, and everyone together at most `dailyCap` a day (two days' worth back to back
///        around midnight UTC), until the owner pauses claims (`setPaused`) or replaces the key (`setSigner`). It can
///        never touch the treasury, anyone's ETH, or $MINE already paid out.
///      - The owner can't withdraw the vault (`sweep` refuses $MINE). It sets the price, the treasury, the signer and
///        the caps (never above MAX_WALLET_DAILY_CAP and MAX_DAILY_CAP), and can pause. So the owner, or someone with
///        the owner's key, could make itself the signer and take up to MAX_DAILY_CAP (5,000,000, 1% of the vault) a
///        day. Ownership moves in two steps and can't be renounced, so the caps and the pause stay manageable.
contract MiningSites is Ownable2Step, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant EARNINGS_TYPEHASH = keccak256("Earnings(address player,uint256 total,uint64 deadline)");
    /// @notice The highest the per-wallet daily cap can be set (100,000 $MINE).
    uint256 public constant MAX_WALLET_DAILY_CAP = 100_000e18;
    /// @notice The highest the daily cap across everyone can be set (5,000,000 $MINE).
    uint256 public constant MAX_DAILY_CAP = 5_000_000e18;

    /// @notice $MINE.
    IERC20 public immutable token;

    /// @notice ETH to open a site (never 0).
    uint256 public sitePrice;
    /// @notice Where site payments go.
    address public treasury;
    /// @notice The game server's key, which signs the vouchers.
    address public signer;
    /// @notice While paused nobody can claim. Sites can still be opened.
    bool public paused;
    /// @notice The most one wallet is paid a day.
    uint256 public walletDailyCap;
    /// @notice The most everyone together is paid a day.
    uint256 public dailyCap;

    /// @notice When each wallet opened its site (0: none).
    mapping(address wallet => uint64 openedAt) public siteOf;
    /// @notice $MINE paid to each wallet so far, in all.
    mapping(address player => uint256) public claimed;

    /// @dev What was paid on `day`; a record from an earlier day reads as nothing paid today.
    struct DayTotal {
        uint64 day;
        uint192 paid;
    }

    DayTotal internal _paidDay;
    mapping(address => DayTotal) internal _walletDay;

    event SiteOpened(address indexed owner, uint256 price);
    event Claimed(address indexed player, uint256 amount, uint256 totalClaimed);
    event SitePriceSet(uint256 sitePrice);
    event TreasurySet(address indexed treasury);
    event SignerSet(address indexed previous, address indexed signer);
    event PausedSet(bool paused);
    event CapsSet(uint256 walletDailyCap, uint256 dailyCap);
    event Swept(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroPrice();
    /// @notice A cap is 0, above its maximum, or the wallet cap is above the cap across everyone.
    error BadCaps();
    /// @notice The treasury can't be this contract (it refuses ETH, so no site could be opened).
    error BadTreasury();
    error AlreadyOpen();
    error WrongPayment();
    error NoSite();
    error IsPaused();
    error Expired();
    error BadSignature();
    error NothingToClaim();
    /// @notice $MINE can only leave through `claim`.
    error CannotSweepMine();
    /// @notice Ownership can only be handed over (two-step), never renounced.
    error CannotRenounce();

    /// @param token_ $MINE. It is deployed after this contract (it mints VAULT_SUPPLY here), so the deploy script
    ///        predicts its address and checks it afterwards.
    constructor(
        IERC20 token_,
        address owner_,
        address treasury_,
        address signer_,
        uint256 sitePrice_,
        uint256 walletDailyCap_,
        uint256 dailyCap_
    ) Ownable(owner_) EIP712("MineWorldCraft Mining", "1") {
        if (address(token_) == address(0) || treasury_ == address(0) || signer_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(this)) revert BadTreasury();
        if (sitePrice_ == 0) revert ZeroPrice();
        _checkCaps(walletDailyCap_, dailyCap_);
        token = token_;
        treasury = treasury_;
        signer = signer_;
        sitePrice = sitePrice_;
        walletDailyCap = walletDailyCap_;
        dailyCap = dailyCap_;
        emit TreasurySet(treasury_);
        emit SignerSet(address(0), signer_);
        emit SitePriceSet(sitePrice_);
        emit CapsSet(walletDailyCap_, dailyCap_);
    }

    // ---------------------------------------------------------------- sites

    /// @notice Open your mining site, once, for exactly `sitePrice` in ETH (a price change mined first makes this
    ///         revert rather than charge a different amount). The ETH goes straight to the treasury.
    function openSite() external payable nonReentrant {
        if (siteOf[msg.sender] != 0) revert AlreadyOpen();
        if (msg.value != sitePrice) revert WrongPayment();
        siteOf[msg.sender] = uint64(block.timestamp);
        emit SiteOpened(msg.sender, msg.value);
        // With anything ever forced in here (no call reaches this contract with ETH otherwise): it never holds ETH.
        Address.sendValue(payable(treasury), address(this).balance);
    }

    function hasSite(address wallet) external view returns (bool) {
        return siteOf[wallet] != 0;
    }

    // ---------------------------------------------------------------- claiming

    /// @notice Convert your earnings: `total` is your lifetime total from the server's voucher. Pays what you haven't
    ///         been paid yet, as far as today's caps and the vault allow; the rest stays claimable with a later voucher.
    function claim(uint256 total, uint64 deadline, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 amount)
    {
        if (siteOf[msg.sender] == 0) revert NoSite();
        if (paused) revert IsPaused();
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(EARNINGS_TYPEHASH, msg.sender, total, deadline)));
        // (a malformed signature counts as forged too)
        (address who, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || who != signer) revert BadSignature();

        amount = _payable(msg.sender, total);
        if (amount == 0) revert NothingToClaim();

        uint64 day = uint64(today());
        uint256 paid = claimed[msg.sender] + amount;
        claimed[msg.sender] = paid;
        _paidDay = DayTotal(day, uint192(_on(_paidDay, day) + amount));
        _walletDay[msg.sender] = DayTotal(day, uint192(_on(_walletDay[msg.sender], day) + amount));
        emit Claimed(msg.sender, amount, paid);
        token.safeTransfer(msg.sender, amount);
    }

    /// @notice What a claim with a voucher for `total` would pay `player` now: 0 without a site or while paused.
    function claimable(address player, uint256 total) external view returns (uint256) {
        if (paused || siteOf[player] == 0) return 0;
        return _payable(player, total);
    }

    /// @dev min(not yet paid, the wallet's room today, everyone's room today, the vault).
    function _payable(address player, uint256 total) internal view returns (uint256 amount) {
        uint256 done = claimed[player];
        if (total <= done) return 0;
        amount = total - done;
        uint256 room = _room(walletDailyCap, walletPaidToday(player));
        if (room < amount) amount = room;
        room = _room(dailyCap, paidToday());
        if (room < amount) amount = room;
        room = token.balanceOf(address(this));
        if (room < amount) amount = room;
    }

    /// @dev What's left under `cap` (nothing if a lowered cap is already used up).
    function _room(uint256 cap, uint256 used) internal pure returns (uint256) {
        return cap > used ? cap - used : 0;
    }

    function _on(DayTotal memory t, uint64 day) internal pure returns (uint256) {
        return t.day == day ? t.paid : 0;
    }

    // ---------------------------------------------------------------- views

    /// @notice Days since 1 January 1970 (UTC): the caps reset when it changes.
    function today() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    /// @notice $MINE paid today, across everyone.
    function paidToday() public view returns (uint256) {
        return _on(_paidDay, uint64(today()));
    }

    /// @notice $MINE paid to `player` today.
    function walletPaidToday(address player) public view returns (uint256) {
        return _on(_walletDay[player], uint64(today()));
    }

    /// @notice $MINE left to pay out.
    function vaultBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    // ---------------------------------------------------------------- the owner

    /// @notice Never free: every site is paid for. Sites already open stay open.
    function setSitePrice(uint256 sitePrice_) external onlyOwner {
        if (sitePrice_ == 0) revert ZeroPrice();
        sitePrice = sitePrice_;
        emit SitePriceSet(sitePrice_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(this)) revert BadTreasury();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    /// @notice Change the server key (if it's ever replaced or exposed). Vouchers signed by the old key stop working.
    function setSigner(address signer_) external onlyOwner {
        if (signer_ == address(0)) revert ZeroAddress();
        emit SignerSet(signer, signer_);
        signer = signer_;
    }

    /// @notice Stop every claim (if the server key leaks, say). Nobody's earnings are lost: they stay claimable.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice The daily caps: per wallet (1 wei to MAX_WALLET_DAILY_CAP) and across everyone (the wallet cap to
    ///         MAX_DAILY_CAP). They bound what a leaked server key could take in a day. A cap lowered below what was
    ///         already paid today just stops today's claims.
    function setCaps(uint256 walletDailyCap_, uint256 dailyCap_) external onlyOwner {
        _checkCaps(walletDailyCap_, dailyCap_);
        walletDailyCap = walletDailyCap_;
        dailyCap = dailyCap_;
        emit CapsSet(walletDailyCap_, dailyCap_);
    }

    function _checkCaps(uint256 wallet, uint256 global) internal pure {
        if (wallet == 0 || wallet > MAX_WALLET_DAILY_CAP || global < wallet || global > MAX_DAILY_CAP) revert BadCaps();
    }

    /// @notice Send a token that reached this contract by mistake to `to`. Never $MINE: the vault only pays players.
    function sweep(IERC20 token_, address to) external onlyOwner nonReentrant {
        if (token_ == token) revert CannotSweepMine();
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = token_.balanceOf(address(this));
        token_.safeTransfer(to, amount);
        emit Swept(address(token_), to, amount);
    }

    /// @notice Ownership can't be renounced: the pause, the signer and the caps must stay manageable.
    function renounceOwnership() public view override onlyOwner {
        revert CannotRenounce();
    }
}
