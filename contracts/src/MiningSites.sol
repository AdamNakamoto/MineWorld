// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {UpgradeCosts} from "./UpgradeCosts.sol";
import {MineVault} from "./MineVault.sol";

/// @title MiningSites
/// @notice MineWorldCraft's rules for converting earnings to $MINE, which the mining vault (MineVault, $MINE's one
///         minter) mints to players when this contract, its distributor, asks. The vault never mints more than 35,000
///         in a UTC day nor 10,500,000 in all, whatever runs here; the rules here sit behind a UUPS proxy, so the owner
///         can tune them, and upgrade them, from players' feedback.
///
///         To convert earnings a wallet needs a mining site: opened once, with ETH (`sitePrice`), which goes straight
///         to the treasury (this contract never holds ETH). A new site is level 1; `upgradeSite` raises it a level at a
///         time for $MINE (see UpgradeCosts: 75% burned at launch, the rest to the treasury, taken straight from the
///         wallet, never near the vault). The level sets the share of earnings a claim converts: 50%, 60%, 70%, 85% and
///         100% for levels 1 to 5 at launch. The owner can change the rates (each 10% to 100%, never lower for a higher
///         level) and add levels (up to 20). Sites can't be moved to another wallet.
///
///         The game's server keeps each wallet's earnings and signs an EIP-712 voucher for the wallet's lifetime
///         earnings (`total`, 18 decimals). `claim` converts what the wallet hasn't converted yet (`total - settled`)
///         at its site's rate at the moment it claims: upgrading before claiming converts everything still unclaimed
///         at the better rate, which is intended (that's what the upgrade is for); a rate the owner changes applies to
///         earnings not yet claimed in the same way. The $MINE paid is held within two daily caps, one per wallet and
///         one across everyone (never above the vault's daily limit), and what the vault can mint today. When one
///         of those holds a payment back, only the earnings the payment covers count as settled (rounded up, in the
///         vault's favour) and the rest stays claimable later; otherwise all of `total` is settled. The share a rate
///         doesn't convert stays in the vault for good, so the vault lasts longer still. A day is
///         `block.timestamp / 1 days` (UTC).
/// @dev Trust, plainly:
///      - The signer key (the game server's) decides what each wallet has earned. If it leaks, whoever holds it can
///        sign any total for wallets they control, but each wallet needs a site (paid to the treasury) and is paid at
///        most `walletDailyCap` a day, and everyone together at most `dailyCap` a day (two days' worth back to back
///        around midnight UTC), until the owner pauses claims (`setPaused`) or replaces the key (`setSigner`). It can
///        never touch the treasury, anyone's ETH, or $MINE already paid out.
///      - The owner sets the site price, the upgrade costs, burn share and rates, adds levels, sets the treasury, the
///        signer and the caps, can pause, and can upgrade this contract. So the owner, or someone with the owner's
///        key, could take what the vault mints: at most 35,000 $MINE a day, which the vault enforces whatever code
///        runs here. The owner can hand ownership to a multisig or a timelock (see OwnedUUPS). A cost raised just
///        before an upgrade only charges a wallet that approved that much (the game approves exactly the cost it
///        shows).
///      - Upgrades keep every site, level and total: the state lives in ERC-7201 namespaced storage.
contract MiningSites is UpgradeCosts, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    bytes32 public constant EARNINGS_TYPEHASH = keccak256("Earnings(address player,uint256 total,uint64 deadline)");
    /// @notice The highest the per-wallet daily cap can be set (3,500 $MINE).
    uint256 public constant MAX_WALLET_DAILY_CAP = 3_500e18;
    /// @notice The most one level can be set to cost (1,000,000 $MINE).
    uint256 public constant MAX_UPGRADE_COST = 1_000_000e18;
    /// @notice The lowest share of earnings a level can convert (10%).
    uint256 public constant MIN_RATE_BPS = 1_000;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("MineWorldCraft Mining");
    bytes32 private constant VERSION_HASH = keccak256("1");

    /// @dev A wallet's site: when it was opened, and its level (1 to maxLevel()). Both 0: no site.
    struct Site {
        uint64 openedAt;
        uint8 level;
    }

    /// @dev What was paid on `day`; a record from an earlier day reads as nothing paid today.
    struct DayTotal {
        uint64 day;
        uint192 paid;
    }

    /// @custom:storage-location erc7201:mineworldcraft.storage.MiningSites
    struct SitesStorage {
        MineVault vault;
        uint256 sitePrice;
        address signer;
        bool paused;
        uint256 walletDailyCap;
        uint256 dailyCap;
        /// @dev rates[i]: the share level i + 1 converts, in basis points.
        uint16[] rates;
        mapping(address wallet => Site) sites;
        mapping(address player => uint256) claimed;
        mapping(address player => uint256) settled;
        DayTotal paidDay;
        mapping(address player => DayTotal) walletDay;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("mineworldcraft.storage.MiningSites")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant SITES_STORAGE = 0x65ef401c05211035aa84a6ea9a3dd124127d2cf4d8c7545646e73aef77627100;

    event SiteOpened(address indexed owner, uint256 price);
    /// @param cost $MINE paid for the new level; `burned` of it was burned, the rest went to the treasury.
    event SiteUpgraded(address indexed owner, uint256 level, uint256 cost, uint256 burned);
    /// @param amount $MINE paid
    /// @param earnings the earnings this claim converted, at `rateBps`
    /// @param totalClaimed the wallet's $MINE paid in all, after this claim
    /// @param totalSettled the wallet's earnings converted in all (`settled`), after this claim
    event Claimed(
        address indexed player,
        uint256 amount,
        uint256 earnings,
        uint256 rateBps,
        uint256 totalClaimed,
        uint256 totalSettled
    );
    /// @param rates the share each level converts, in basis points, from level 1 up
    event RatesSet(uint256[] rates);
    event SitePriceSet(uint256 sitePrice);
    event SignerSet(address indexed previous, address indexed signer);
    event PausedSet(bool paused);
    event CapsSet(uint256 walletDailyCap, uint256 dailyCap);
    event Swept(address indexed token, address indexed to, uint256 amount);

    error ZeroPrice();
    /// @notice A cap is 0, above its maximum, or the wallet cap is above the cap across everyone.
    error BadCaps();
    /// @notice A rate is below 10% or above 100%, lower than the level below's, or there isn't one per level.
    error BadRates();
    /// @notice The vault mints another token, or doesn't have this proxy as its distributor.
    error BadVault();
    error AlreadyOpen();
    error WrongPayment();
    error NoSite();
    error IsPaused();
    error Expired();
    error BadSignature();
    error NothingToClaim();

    /// @dev The implementation is only ever used through a proxy.
    constructor() {
        _disableInitializers();
    }

    /// @notice Set up the proxy: the rules for `vault_`'s $MINE, with the launch's levels (costs 4,620, 18,942,
    ///         77,662 and 318,415 $MINE to reach levels 2 to 5, about $1,000 in all at a $50,000 market cap; rates 50%,
    ///         60%, 70%, 85% and 100%; 75% of each upgrade burned). The vault must already name this proxy its
    ///         distributor.
    function initialize(
        IERC20 token_,
        MineVault vault_,
        address owner_,
        address treasury_,
        address signer_,
        uint256 sitePrice_,
        uint256 walletDailyCap_,
        uint256 dailyCap_
    ) external initializer {
        __Owned_init(owner_);
        __MinePayer_init(token_, treasury_);
        uint256[] memory costs = new uint256[](4);
        (costs[0], costs[1], costs[2], costs[3]) = (4_620e18, 18_942e18, 77_662e18, 318_415e18);
        __UpgradeCosts_init(costs, 7_500);
        if (address(vault_) == address(0) || signer_ == address(0)) revert ZeroAddress();
        if (address(vault_.token()) != address(token_) || vault_.distributor() != address(this)) revert BadVault();
        if (sitePrice_ == 0) revert ZeroPrice();
        SitesStorage storage $ = _sites();
        $.vault = vault_;
        $.signer = signer_;
        $.sitePrice = sitePrice_;
        emit SignerSet(address(0), signer_);
        emit SitePriceSet(sitePrice_);
        _setCaps(walletDailyCap_, dailyCap_);
        uint256[] memory r = new uint256[](5);
        (r[0], r[1], r[2], r[3], r[4]) = (5_000, 6_000, 7_000, 8_500, 10_000);
        _setRates(r);
    }

    function _sites() private pure returns (SitesStorage storage $) {
        assembly {
            $.slot := SITES_STORAGE
        }
    }

    function _maxUpgradeCost() internal pure override returns (uint256) {
        return MAX_UPGRADE_COST;
    }

    // ---------------------------------------------------------------- sites

    /// @notice Open your mining site, once, for exactly `sitePrice` in ETH (a price change mined first makes this
    ///         revert rather than charge a different amount). The ETH goes straight to the treasury. It opens at
    ///         level 1.
    function openSite() external payable nonReentrant {
        SitesStorage storage $ = _sites();
        if ($.sites[msg.sender].level != 0) revert AlreadyOpen();
        if (msg.value != $.sitePrice) revert WrongPayment();
        $.sites[msg.sender] = Site(uint64(block.timestamp), 1);
        emit SiteOpened(msg.sender, msg.value);
        // With anything ever forced in here (no call reaches this contract with ETH otherwise): it never holds ETH.
        Address.sendValue(payable(treasury()), address(this).balance);
    }

    /// @notice Raise your site one level (up to maxLevel()) for `upgradeCost(level)` $MINE from your wallet: the burn
    ///         share burned, the rest to the treasury. Approve this contract for exactly that much first. Your next
    ///         claim converts at the new level's rate, earnings you haven't claimed yet included.
    function upgradeSite() external nonReentrant returns (uint256 level) {
        Site storage site = _sites().sites[msg.sender];
        if (site.level == 0) revert NoSite();
        uint256 cost;
        (level, cost) = _nextLevel(site.level);
        site.level = uint8(level);
        emit SiteUpgraded(msg.sender, level, cost, _burnShare(cost));
        _payUpgrade(msg.sender, cost);
    }

    /// @notice When `wallet` opened its site (0: none).
    function siteOf(address wallet) external view returns (uint64 openedAt) {
        return _sites().sites[wallet].openedAt;
    }

    function hasSite(address wallet) external view returns (bool) {
        return _sites().sites[wallet].level != 0;
    }

    /// @notice `wallet`'s site level: 1 to maxLevel(), or 0 without a site.
    function siteLevel(address wallet) external view returns (uint256) {
        return _sites().sites[wallet].level;
    }

    /// @notice The share of its earnings `wallet` converts when it claims now, in basis points (0 without a site).
    function rateBps(address wallet) public view returns (uint256) {
        return levelRateBps(_sites().sites[wallet].level);
    }

    /// @notice The share of earnings a site of `level` converts, in basis points (0 for no such level).
    function levelRateBps(uint256 level) public view returns (uint256) {
        uint16[] storage r = _sites().rates;
        return level == 0 || level > r.length ? 0 : r[level - 1];
    }

    /// @notice The share each level converts, in basis points, from level 1 to maxLevel().
    function rates() public view returns (uint256[] memory out) {
        uint16[] storage r = _sites().rates;
        out = new uint256[](r.length);
        for (uint256 i; i < r.length; ++i) {
            out[i] = r[i];
        }
    }

    // ---------------------------------------------------------------- claiming

    /// @notice Convert your earnings: `total` is your lifetime earnings from the server's voucher. Converts what you
    ///         haven't converted yet at your site's rate now, and pays it as far as today's caps and the vault allow;
    ///         the earnings that payment doesn't cover stay claimable with a later voucher.
    function claim(uint256 total, uint64 deadline, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 amount)
    {
        SitesStorage storage $ = _sites();
        uint256 rate = rateBps(msg.sender);
        if (rate == 0) revert NoSite();
        if ($.paused) revert IsPaused();
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = MessageHashUtils.toTypedDataHash(
            domainSeparator(), keccak256(abi.encode(EARNINGS_TYPEHASH, msg.sender, total, deadline))
        );
        // (a malformed signature counts as forged too)
        (address who, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || who != $.signer) revert BadSignature();

        uint256 earnings;
        (amount, earnings) = _quote(msg.sender, total, rate);
        if (amount == 0) revert NothingToClaim();

        uint64 day = uint64(today());
        uint256 paid = $.claimed[msg.sender] + amount;
        uint256 done = $.settled[msg.sender] + earnings;
        $.claimed[msg.sender] = paid;
        $.settled[msg.sender] = done;
        $.paidDay = DayTotal(day, uint192(_on($.paidDay, day) + amount));
        $.walletDay[msg.sender] = DayTotal(day, uint192(_on($.walletDay[msg.sender], day) + amount));
        emit Claimed(msg.sender, amount, earnings, rate, paid, done);
        $.vault.release(msg.sender, amount); // minted straight to the player
    }

    /// @notice The $MINE a claim with a voucher for `total` would pay `player` now, at its site's current rate: 0
    ///         without a site or while paused.
    function claimable(address player, uint256 total) external view returns (uint256 amount) {
        uint256 rate = rateBps(player);
        if (_sites().paused || rate == 0) return 0;
        (amount,) = _quote(player, total, rate);
    }

    /// @dev What a claim pays now, and the earnings it settles. The earnings not yet converted, at `rate` (rounded
    ///      down), held to the wallet's room today, everyone's room today and what the vault can mint today. Paid in
    ///      full, it settles everything up to `total` (no dust left behind). Held back, it settles only the earnings
    ///      the payment covers at `rate`, rounded up (in the vault's favour); that is always less than what was owed,
    ///      so the rest stays claimable.
    function _quote(address player, uint256 total, uint256 rate)
        internal
        view
        returns (uint256 amount, uint256 earnings)
    {
        SitesStorage storage $ = _sites();
        uint256 done = $.settled[player];
        if (total <= done) return (0, 0);
        earnings = total - done;
        uint256 full = Math.mulDiv(earnings, rate, BPS);
        amount = full;
        uint256 room = _room($.walletDailyCap, walletPaidToday(player));
        if (room < amount) amount = room;
        room = _room($.dailyCap, paidToday());
        if (room < amount) amount = room;
        room = $.vault.roomToday();
        if (room < amount) amount = room;
        if (amount < full) earnings = Math.mulDiv(amount, BPS, rate, Math.Rounding.Ceil);
    }

    /// @dev What's left under `cap` (nothing if a lowered cap is already used up).
    function _room(uint256 cap, uint256 used) internal pure returns (uint256) {
        return cap > used ? cap - used : 0;
    }

    function _on(DayTotal memory t, uint64 day) internal pure returns (uint256) {
        return t.day == day ? t.paid : 0;
    }

    // ---------------------------------------------------------------- views

    /// @notice The EIP-712 domain vouchers are signed for: "MineWorldCraft Mining", version "1", this chain and this
    ///         proxy's address (the same across upgrades).
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    /// @notice ERC-5267: the EIP-712 domain, for wallets and the game's server.
    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        )
    {
        return (hex"0f", "MineWorldCraft Mining", "1", block.chainid, address(this), bytes32(0), new uint256[](0));
    }

    /// @notice Days since 1 January 1970 (UTC): the caps reset when it changes.
    function today() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    /// @notice $MINE paid today, across everyone.
    function paidToday() public view returns (uint256) {
        return _on(_sites().paidDay, uint64(today()));
    }

    /// @notice $MINE paid to `player` today.
    function walletPaidToday(address player) public view returns (uint256) {
        return _on(_sites().walletDay[player], uint64(today()));
    }

    /// @notice $MINE paid to each wallet so far, in all.
    function claimed(address player) external view returns (uint256) {
        return _sites().claimed[player];
    }

    /// @notice Each wallet's earnings converted so far (18 decimals, like a voucher's total). A claim converts what
    ///         its voucher's total has on top of this.
    function settled(address player) external view returns (uint256) {
        return _sites().settled[player];
    }

    /// @notice The mining vault this pays from.
    function vault() external view returns (MineVault) {
        return _sites().vault;
    }

    /// @notice $MINE the vault can still mint for players, in all.
    function vaultBalance() external view returns (uint256) {
        return _sites().vault.remaining();
    }

    /// @notice The highest the daily cap across everyone can be set: the vault's daily limit (35,000 $MINE).
    function MAX_DAILY_CAP() public view returns (uint256) {
        return _sites().vault.DAILY_LIMIT();
    }

    /// @notice ETH to open a site (never 0).
    function sitePrice() external view returns (uint256) {
        return _sites().sitePrice;
    }

    /// @notice The game server's key, which signs the vouchers.
    function signer() external view returns (address) {
        return _sites().signer;
    }

    /// @notice While paused nobody can claim. Sites can still be opened and upgraded.
    function paused() external view returns (bool) {
        return _sites().paused;
    }

    /// @notice The most one wallet is paid a day.
    function walletDailyCap() external view returns (uint256) {
        return _sites().walletDailyCap;
    }

    /// @notice The most everyone together is paid a day.
    function dailyCap() external view returns (uint256) {
        return _sites().dailyCap;
    }

    // ---------------------------------------------------------------- the owner

    /// @notice Never free: every site is paid for. Sites already open stay open.
    function setSitePrice(uint256 sitePrice_) external onlyOwner {
        if (sitePrice_ == 0) revert ZeroPrice();
        _sites().sitePrice = sitePrice_;
        emit SitePriceSet(sitePrice_);
    }

    /// @notice Change the server key (if it's ever replaced or exposed). Vouchers signed by the old key stop working.
    function setSigner(address signer_) external onlyOwner {
        if (signer_ == address(0)) revert ZeroAddress();
        emit SignerSet(_sites().signer, signer_);
        _sites().signer = signer_;
    }

    /// @notice Stop every claim (if the server key leaks, say). Nobody's earnings are lost: they stay claimable.
    function setPaused(bool paused_) external onlyOwner {
        _sites().paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice The daily caps on $MINE paid: per wallet (1 wei to MAX_WALLET_DAILY_CAP) and across everyone (the
    ///         wallet cap to the vault's daily limit). They bound what a leaked server key could take in a day. A cap
    ///         lowered below what was already paid today just stops today's claims.
    function setCaps(uint256 walletDailyCap_, uint256 dailyCap_) external onlyOwner {
        _setCaps(walletDailyCap_, dailyCap_);
    }

    function _setCaps(uint256 wallet, uint256 global) private {
        if (wallet == 0 || wallet > MAX_WALLET_DAILY_CAP || global < wallet || global > MAX_DAILY_CAP()) {
            revert BadCaps();
        }
        _sites().walletDailyCap = wallet;
        _sites().dailyCap = global;
        emit CapsSet(wallet, global);
    }

    /// @notice The share each level converts, from level 1 to maxLevel() (one for each): each 10% to 100%, never
    ///         lower than the level below's. It applies to every claim from now on, earnings not yet claimed included.
    function setRates(uint256[] calldata rates_) external onlyOwner {
        if (rates_.length != maxLevel()) revert BadRates();
        _setRates(rates_);
    }

    /// @notice A new top level: reached for `cost` $MINE (1 wei to MAX_UPGRADE_COST), converting `rate` (at least
    ///         the level below's, at most 100%). Up to MAX_LEVELS; levels are never removed.
    function addLevel(uint256 cost, uint256 rate) external onlyOwner returns (uint256 level) {
        uint16[] storage r = _sites().rates;
        if (rate < r[r.length - 1] || rate > BPS) revert BadRates();
        level = _addLevel(cost);
        r.push(uint16(rate));
        emit RatesSet(rates());
    }

    function _setRates(uint256[] memory rates_) private {
        uint16[] storage r = _sites().rates;
        uint256 last = MIN_RATE_BPS;
        while (r.length != 0) {
            r.pop();
        }
        for (uint256 i; i < rates_.length; ++i) {
            if (rates_[i] < last || rates_[i] > BPS) revert BadRates();
            last = rates_[i];
            r.push(uint16(rates_[i]));
        }
        emit RatesSet(rates_);
    }

    /// @notice Send a token that reached this contract by mistake to `to` (it never holds any of its own: claims are
    ///         minted straight to players, upgrades paid straight from them).
    function sweep(IERC20 token_, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = token_.balanceOf(address(this));
        token_.safeTransfer(to, amount);
        emit Swept(address(token_), to, amount);
    }
}
