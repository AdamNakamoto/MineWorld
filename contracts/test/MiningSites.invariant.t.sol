// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MineToken} from "../src/MineToken.sol";
import {MiningSites} from "../src/MiningSites.sol";
import {MineVault} from "../src/MineVault.sol";
import {SitesFixture} from "./MiningSites.t.sol";

/// Random moves by players, the game server and the owner: wallets earning (the server signs a new lifetime total),
/// claiming with the latest voucher or an older one, forged vouchers, sites opened and upgraded, caps, rates, burn share
/// and levels changed by the owner, pauses, stray $MINE sent to the contracts, and time passing across midnights. It keeps its own books of what was signed,
/// settled and paid, per wallet and per day, and of what upgrades cost, burned and paid the treasury, and the test
/// checks them against the contract after every step.
contract SitesHandler is SitesFixture {
    MiningSites public sites;
    MineToken public token;
    address internal owner;
    address internal pool;
    uint256 internal signerKey;
    address[6] public players;

    /// The highest total the server ever signed for each wallet.
    mapping(address => uint256) public signed;
    /// What the handler saw paid, per day and per wallet per day.
    mapping(uint256 => uint256) public paidOn;
    mapping(address => mapping(uint256 => uint256)) public walletPaidOn;
    /// The highest caps in force at any moment of each day (a cap can change mid-day).
    mapping(uint256 => uint256) public maxCapOn;
    mapping(uint256 => uint256) public maxWalletCapOn;
    uint256[] public daysSeen;
    mapping(uint256 => bool) internal seen;

    /// Per wallet: $MINE given to it to pay for upgrades, and spent on them; the earnings' worth at the rates they were
    /// settled at (sum of earnings x rate, in basis points), which bounds what it may have been paid.
    mapping(address => uint256) public funded;
    mapping(address => uint256) public spent;
    mapping(address => uint256) public worth;
    uint256 public burned; // by upgrades, expected
    uint256 public toTreasury; // by upgrades, expected
    uint256 public upgrades;
    uint256 public tunes;

    uint256 public strays; // $MINE sent to the vault from outside
    uint256 public claimsPaid;
    uint256 public cappedClaims; // claims that paid less than the voucher's new part (the caps or the vault held some back)
    bool public forgedPaid;
    bool public overpaid; // a claim paid more than claimable() said, or more than a cap allowed
    bool public badSettlement; // a claim settled other than the rule says (all when paid in full, else what it covers)

    constructor(MiningSites s, MineToken t, address o, address p, uint256 key, address[6] memory ps) {
        sites = s;
        token = t;
        owner = o;
        pool = p;
        signerKey = key;
        players = ps;
        _touch();
    }

    function daysSeenCount() external view returns (uint256) {
        return daysSeen.length;
    }

    function _today() internal view returns (uint256) {
        return vm.getBlockTimestamp() / 1 days;
    }

    /// @dev Records today and the caps in force now.
    function _touch() internal {
        uint256 day = _today();
        if (!seen[day]) {
            seen[day] = true;
            daysSeen.push(day);
        }
        if (sites.dailyCap() > maxCapOn[day]) maxCapOn[day] = sites.dailyCap();
        if (sites.walletDailyCap() > maxWalletCapOn[day]) maxWalletCapOn[day] = sites.walletDailyCap();
    }

    /// The server credits a wallet with more earnings (its lifetime total grows).
    function earn(uint8 who, uint256 amount) external {
        signed[players[who % 6]] += bound(amount, 0, 8_000e18);
    }

    /// A wallet claims with its latest voucher, or with an older one (any total up to the latest).
    function claim(uint8 who, bool older, uint256 olderTotal) external {
        _touch();
        address p = players[who % 6];
        uint256 total = older ? bound(olderTotal, 0, signed[p]) : signed[p];
        uint64 deadline = uint64(vm.getBlockTimestamp() + 1 hours);
        bytes memory sig = _voucher(sites, signerKey, p, total, deadline);
        uint256 expect = sites.claimable(p, total);
        uint256 rate = sites.rateBps(p);
        uint256 done = sites.settled(p);
        // What the earnings not yet converted are worth at the wallet's rate now.
        uint256 owedBefore = total > done && rate != 0 ? Math.mulDiv(total - done, rate, 10_000) : 0;
        vm.prank(p);
        try sites.claim(total, deadline, sig) returns (uint256 amount) {
            uint256 day = _today();
            paidOn[day] += amount;
            walletPaidOn[p][day] += amount;
            claimsPaid++;
            uint256 settledNow = sites.settled(p);
            worth[p] += (settledNow - done) * rate;
            if (amount < owedBefore) {
                cappedClaims++;
                if (settledNow - done != Math.mulDiv(amount, 10_000, rate, Math.Rounding.Ceil)) badSettlement = true;
            } else if (amount != owedBefore || settledNow != total) {
                badSettlement = true;
            }
            if (amount != expect || sites.paidToday() > sites.dailyCap() || sites.walletPaidToday(p) > sites.walletDailyCap()) {
                overpaid = true;
            }
        } catch {}
    }

    /// A wallet buys its site's next level: it's given the cost (as if bought in the pool) and approves exactly that.
    function upgrade(uint8 who) external {
        address p = players[who % 6];
        uint256 level = sites.siteLevel(p);
        if (level == 0 || level == sites.maxLevel()) return;
        uint256 cost = sites.upgradeCost(level + 1);
        uint256 burn = cost * sites.upgradeBurnBps() / 10_000;
        vm.prank(pool);
        token.transfer(p, cost);
        funded[p] += cost;
        vm.startPrank(p);
        token.approve(address(sites), cost);
        sites.upgradeSite();
        vm.stopPrank();
        spent[p] += cost;
        burned += burn;
        toTreasury += cost - burn;
        upgrades++;
    }

    /// The owner tunes the rules: new rates (each 10% to 100%, rising by level), a new burn share, or a new level.
    function tune(uint256 r) external {
        uint256 move = r % 3;
        vm.startPrank(owner);
        if (move == 0) {
            uint256 n = sites.maxLevel();
            uint256[] memory rates = new uint256[](n);
            uint256 last = 1_000;
            for (uint256 i; i < n; i++) {
                last = bound(uint256(keccak256(abi.encode(r, i))), last, 10_000);
                rates[i] = last;
            }
            sites.setRates(rates);
        } else if (move == 1) {
            sites.setUpgradeBurnBps(bound(r >> 8, 0, 10_000));
        } else if (sites.maxLevel() < 8) {
            sites.addLevel(bound(r >> 8, 1e18, 50_000e18), 10_000);
        }
        vm.stopPrank();
        tunes++;
    }

    /// Someone signs a voucher with a key that isn't the server's.
    function forge(uint8 who, uint256 key, uint256 total) external {
        key = bound(key, 1, 1e30);
        if (key == signerKey) key++;
        address p = players[who % 6];
        uint64 deadline = uint64(vm.getBlockTimestamp() + 1 hours);
        bytes memory sig = _voucher(sites, key, p, bound(total, 1, 1e27), deadline);
        vm.prank(p);
        try sites.claim(bound(total, 1, 1e27), deadline, sig) {
            forgedPaid = true;
        } catch {}
    }

    function openSite(uint8 who) external {
        address p = players[who % 6];
        vm.deal(p, 1 ether);
        uint256 price = sites.sitePrice();
        vm.prank(p);
        try sites.openSite{value: price}() {} catch {}
    }

    function setCaps(uint256 wallet, uint256 global) external {
        wallet = bound(wallet, 1e18, 3_500e18);
        global = bound(global, wallet, 35_000e18);
        vm.prank(owner);
        sites.setCaps(wallet, global);
        _touch();
    }

    function pause(bool on) external {
        vm.prank(owner);
        sites.setPaused(on);
    }

    /// $MINE sent to the contracts by mistake: it changes nothing (the vault mints, it never pays from a balance).
    function stray(uint256 amount) external {
        amount = bound(amount, 0, 1_000e18);
        vm.startPrank(pool);
        token.transfer(address(sites), amount / 2);
        token.transfer(address(sites.vault()), amount - amount / 2);
        vm.stopPrank();
        strays += amount;
    }

    /// Time passes: up to a day and a half, often across a midnight.
    function warp(uint256 secs) external {
        vm.warp(vm.getBlockTimestamp() + bound(secs, 1, 36 hours));
        _touch();
    }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 80
/// forge-config: default.invariant.fail-on-revert = false
contract MiningSitesInvariantTest is SitesFixture {
    MiningSites sites;
    MineToken token;
    SitesHandler handler;
    address owner = makeAddr("owner");
    address pool = makeAddr("pool");
    address treasury = makeAddr("treasury");
    address[6] players;

    function setUp() public {
        vm.warp(20_000 days + 12 hours);
        uint256 key = 0x5160;
        (token, sites) = _deploy(owner, treasury, vm.addr(key), 0.005 ether, 1_500e18, 4_000e18, pool);
        for (uint256 i; i < 6; i++) {
            players[i] = makeAddr(string(abi.encodePacked("player", vm.toString(i))));
            if (i < 5) {
                // The sixth starts without a site.
                vm.deal(players[i], 1 ether);
                vm.prank(players[i]);
                sites.openSite{value: 0.005 ether}();
            }
        }
        handler = new SitesHandler(sites, token, owner, pool, key, players);
        targetContract(address(handler));
    }

    /// The vault never settles more earnings than the server signed for a wallet, nor pays more than those earnings
    /// were worth at the rates they were settled at; and players only ever got $MINE through claims (and the funding
    /// for their upgrades).
    function invariant_NeverPaysMoreThanSigned() public view {
        for (uint256 i; i < 6; i++) {
            address p = players[i];
            assertLe(sites.settled(p), handler.signed(p), "settled more than signed");
            assertLe(sites.claimed(p), sites.settled(p), "paid more than the earnings settled");
            assertLe(sites.claimed(p) * 10_000, handler.worth(p), "paid more than the earnings were worth");
            assertEq(
                token.balanceOf(p) + handler.spent(p),
                sites.claimed(p) + handler.funded(p),
                "a wallet's $MINE is what it claimed, plus what it was given for upgrades, less what they cost"
            );
        }
        assertFalse(handler.badSettlement(), "a claim settled other than the rule says");
    }

    /// Upgrades burn 75% and pay the treasury 25%, from the wallet: never through the vault. Levels stay 1-5 and the
    /// rate is always the level's.
    function invariant_UpgradesBurnAndPayTheTreasury() public view {
        assertEq(token.totalSupply(), token.totalMinted() - handler.burned(), "burned the burn share of each upgrade");
        assertEq(token.totalBurned(), handler.burned());
        assertEq(token.balanceOf(treasury), handler.toTreasury(), "25% to the treasury");
        for (uint256 i; i < 6; i++) {
            address p = players[i];
            uint256 level = sites.siteLevel(p);
            assertEq(level == 0, !sites.hasSite(p));
            assertLe(level, sites.maxLevel());
            assertEq(sites.rateBps(p), sites.levelRateBps(level));
        }
    }

    /// No day ever pays more than the daily cap in force that day, nor any wallet more than the wallet cap.
    function invariant_DailyCapsHold() public view {
        for (uint256 k; k < handler.daysSeenCount(); k++) {
            uint256 day = handler.daysSeen(k);
            assertLe(handler.paidOn(day), handler.maxCapOn(day), "a day paid more than the daily cap");
            for (uint256 i; i < 6; i++) {
                assertLe(handler.walletPaidOn(players[i], day), handler.maxWalletCapOn(day), "a wallet passed its cap");
            }
        }
        assertFalse(handler.overpaid(), "a claim paid more than claimable() or a cap allowed");
    }

    /// $MINE only leaves the vault through claims, and every claim is in the books.
    function invariant_VaultBooks() public view {
        uint256 claimedSum;
        for (uint256 i; i < 6; i++) claimedSum += sites.claimed(players[i]);
        MineVault vault = sites.vault();
        assertEq(vault.released(), claimedSum, "the vault mints exactly what claims pay");
        assertEq(sites.vaultBalance() + claimedSum, 10_500_000e18);
        assertEq(token.totalMinted(), 10_500_000e18 + vault.released(), "only the pool's allocation and claims");
        assertLe(token.totalMinted(), token.MAX_SUPPLY());
        assertEq(address(sites).balance, 0, "never holds ETH");
    }

    function invariant_ForgedVouchersNeverPay() public view {
        assertFalse(handler.forgedPaid());
    }

    /// The handler really pays claims, and the caps really bind (a run where neither happens would test nothing):
    /// a fixed pseudo-random walk through the same moves.
    function test_HandlerExercisesPayoutsAndCaps() public {
        uint256 r = 7;
        for (uint256 i; i < 500; i++) {
            r = uint256(keccak256(abi.encode(r)));
            uint256 move = r % 22;
            if (move < 6) handler.earn(uint8(r >> 8), r >> 16);
            else if (move < 13) handler.claim(uint8(r >> 8), (r >> 16) % 4 == 0, r >> 24);
            else if (move < 14) handler.forge(uint8(r >> 8), r >> 16, r >> 80);
            else if (move < 15) handler.openSite(uint8(r >> 8));
            else if (move < 16) handler.setCaps(r >> 8, r >> 72);
            else if (move < 17) handler.pause((r >> 8) % 4 == 0);
            else if (move < 18) handler.stray(r >> 8);
            else if (move < 19) handler.upgrade(uint8(r >> 8));
            else if (move < 20) handler.tune(r >> 8);
            else handler.warp(r >> 8);
            if (i % 25 == 24) {
                invariant_NeverPaysMoreThanSigned();
                invariant_UpgradesBurnAndPayTheTreasury();
                invariant_DailyCapsHold();
                invariant_VaultBooks();
                invariant_ForgedVouchersNeverPay();
            }
        }
        emit log_named_uint("claims paid", handler.claimsPaid());
        emit log_named_uint("claims cut by a cap", handler.cappedClaims());
        emit log_named_uint("upgrades", handler.upgrades());
        assertGt(handler.claimsPaid(), 30, "the walk pays real claims");
        assertGt(handler.cappedClaims(), 5, "the caps bind in the walk");
        assertGt(handler.upgrades(), 5, "the walk upgrades sites");
        assertGt(handler.tunes(), 5, "the owner tunes the rules in the walk");
    }
}
