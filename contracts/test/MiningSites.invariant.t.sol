// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MineToken} from "../src/MineToken.sol";
import {MiningSites} from "../src/MiningSites.sol";
import {SitesFixture} from "./MiningSites.t.sol";

/// Random moves by players, the game server and the owner: wallets earning (the server signs a new lifetime total),
/// claiming with the latest voucher or an older one, forged vouchers, sites opened, caps changed, pauses, stray $MINE
/// sent to the vault, and time passing across midnights. It keeps its own books of what was signed and paid, per
/// wallet and per day, and the test checks them against the contract after every step.
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

    uint256 public strays; // $MINE sent to the vault from outside
    uint256 public claimsPaid;
    uint256 public cappedClaims; // claims that paid less than the voucher's new part (the caps or the vault held some back)
    bool public forgedPaid;
    bool public overpaid; // a claim paid more than claimable() said, or more than a cap allowed

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
        uint256 owedBefore = total > sites.claimed(p) ? total - sites.claimed(p) : 0;
        vm.prank(p);
        try sites.claim(total, deadline, sig) returns (uint256 amount) {
            uint256 day = _today();
            paidOn[day] += amount;
            walletPaidOn[p][day] += amount;
            claimsPaid++;
            if (amount < owedBefore) cappedClaims++;
            if (amount != expect || sites.paidToday() > sites.dailyCap() || sites.walletPaidToday(p) > sites.walletDailyCap()) {
                overpaid = true;
            }
        } catch {}
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
        wallet = bound(wallet, 1e18, 10_000e18);
        global = bound(global, wallet, 30_000e18);
        vm.prank(owner);
        sites.setCaps(wallet, global);
        _touch();
    }

    function pause(bool on) external {
        vm.prank(owner);
        sites.setPaused(on);
    }

    function stray(uint256 amount) external {
        amount = bound(amount, 0, 1_000e18);
        vm.prank(pool);
        token.transfer(address(sites), amount);
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
    address[6] players;

    function setUp() public {
        vm.warp(20_000 days + 12 hours);
        uint256 key = 0x5160;
        (token, sites) = _deploy(owner, makeAddr("treasury"), vm.addr(key), 0.005 ether, 5_000e18, 12_000e18, pool);
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

    /// The vault never pays a wallet more than the highest total the server signed for it, and players only ever got
    /// $MINE through claims.
    function invariant_NeverPaysMoreThanSigned() public view {
        for (uint256 i; i < 6; i++) {
            address p = players[i];
            assertLe(sites.claimed(p), handler.signed(p), "paid more than signed");
            assertEq(token.balanceOf(p), sites.claimed(p), "a wallet's $MINE is what it claimed");
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
        assertEq(sites.vaultBalance() + claimedSum, 500_000_000e18 + handler.strays());
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
            uint256 move = r % 20;
            if (move < 6) handler.earn(uint8(r >> 8), r >> 16);
            else if (move < 13) handler.claim(uint8(r >> 8), (r >> 16) % 4 == 0, r >> 24);
            else if (move < 14) handler.forge(uint8(r >> 8), r >> 16, r >> 80);
            else if (move < 15) handler.openSite(uint8(r >> 8));
            else if (move < 16) handler.setCaps(r >> 8, r >> 72);
            else if (move < 17) handler.pause((r >> 8) % 4 == 0);
            else if (move < 18) handler.stray(r >> 8);
            else handler.warp(r >> 8);
            if (i % 25 == 24) {
                invariant_NeverPaysMoreThanSigned();
                invariant_DailyCapsHold();
                invariant_VaultBooks();
                invariant_ForgedVouchersNeverPay();
            }
        }
        emit log_named_uint("claims paid", handler.claimsPaid());
        emit log_named_uint("claims cut by a cap", handler.cappedClaims());
        assertGt(handler.claimsPaid(), 30, "the walk pays real claims");
        assertGt(handler.cappedClaims(), 5, "the caps bind in the walk");
    }
}
