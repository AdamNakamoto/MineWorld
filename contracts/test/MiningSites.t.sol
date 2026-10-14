// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MineToken} from "../src/MineToken.sol";
import {MiningSites} from "../src/MiningSites.sol";

/// Some other token, sent to the vault by mistake (or standing in for a small vault).
contract OtherCoin is ERC20 {
    constructor(address to, uint256 amount) ERC20("Other", "OTHR") {
        _mint(to, amount);
    }
}

/// Puts ETH into an address without calling it (SELFDESTRUCT in the creating transaction).
contract ForceSend {
    constructor(address payable to) payable {
        selfdestruct(to);
    }
}

/// A treasury that tries to claim again while it's being paid for a site.
contract ReentrantTreasury {
    MiningSites public sites;
    bytes public call;
    bool public reentered;
    bool public reentryWorked;

    function arm(MiningSites s, bytes calldata c) external {
        sites = s;
        call = c;
    }

    receive() external payable {
        if (call.length == 0) return;
        bytes memory c = call;
        delete call;
        reentered = true;
        (reentryWorked,) = address(sites).call(c);
    }
}

/// Deploys MiningSites with a plain CREATE from its own nonce, so the next address is predictable.
contract SitesFactory {
    function make(address t, address o, address tr, address si, uint256 price, uint256 w, uint256 c)
        external
        returns (address)
    {
        return address(new MiningSites(IERC20(t), o, tr, si, price, w, c));
    }
}

/// Helpers shared by the unit and invariant tests: vouchers signed the way the game server signs them.
abstract contract SitesFixture is Test {
    function _voucher(MiningSites sites, uint256 key, address player, uint256 total, uint64 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(keccak256("Earnings(address player,uint256 total,uint64 deadline)"), player, total, deadline)
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("MineWorldCraft Mining"),
                keccak256("1"),
                block.chainid,
                address(sites)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    /// @dev Deploys MiningSites at the address the token will get, then the token (as the deploy script does).
    function _deploy(address owner, address treasury, address signer, uint256 price, uint256 walletCap, uint256 cap, address pool)
        internal
        returns (MineToken token, MiningSites sites)
    {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        sites = new MiningSites(IERC20(predicted), owner, treasury, signer, price, walletCap, cap);
        token = new MineToken(pool, address(sites));
        require(address(token) == predicted, "predicted token");
    }
}

contract MiningSitesTest is SitesFixture {
    MineToken token;
    MiningSites sites;

    uint256 constant SIGNER_KEY = 0x5160;
    address signer = vm.addr(SIGNER_KEY);
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address pool = makeAddr("pool");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol"); // no site

    uint256 constant PRICE = 0.005 ether;
    uint256 constant WALLET_CAP = 5_000e18;
    uint256 constant DAILY_CAP = 1_000_000e18;
    uint256 constant VAULT = 500_000_000e18;

    function setUp() public {
        vm.warp(20_000 days + 12 hours); // midday
        (token, sites) = _deploy(owner, treasury, signer, PRICE, WALLET_CAP, DAILY_CAP, pool);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(carol, 10 ether);
        vm.prank(alice);
        sites.openSite{value: PRICE}();
        vm.prank(bob);
        sites.openSite{value: PRICE}();
    }

    // ---------------------------------------------------------------- helpers

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp(); // (via-IR may reuse one read of block.timestamp across a warp)
    }

    function _sig(address player, uint256 total, uint64 deadline) internal view returns (bytes memory) {
        return _voucher(sites, SIGNER_KEY, player, total, deadline);
    }

    function _claim(address who, uint256 total) internal returns (uint256) {
        uint64 deadline = uint64(_now() + 1 hours);
        bytes memory sig = _sig(who, total, deadline);
        vm.prank(who);
        return sites.claim(total, deadline, sig);
    }

    function claimAs(address who, uint256 total) external returns (uint256) {
        return _claim(who, total);
    }

    function _nextDay() internal {
        vm.warp(_now() + 1 days);
    }

    /// @dev External, so `vm.expectRevert` checks this constructor call. (A `new` straight in the test body reverts
    ///      the test itself, which forge counts as the expected revert, so nothing after it would run.)
    function newSites(address t, address o, address tr, address si, uint256 price, uint256 w, uint256 c)
        external
        returns (address)
    {
        return address(new MiningSites(IERC20(t), o, tr, si, price, w, c));
    }

    // ---------------------------------------------------------------- deploy

    function test_DeployedAsSpecified() public view {
        assertEq(address(sites.token()), address(token));
        assertEq(sites.vaultBalance(), VAULT);
        assertEq(sites.owner(), owner);
        assertEq(sites.treasury(), treasury);
        assertEq(sites.signer(), signer);
        assertEq(sites.sitePrice(), PRICE);
        assertEq(sites.walletDailyCap(), WALLET_CAP);
        assertEq(sites.dailyCap(), DAILY_CAP);
        assertFalse(sites.paused());
        assertEq(sites.MAX_WALLET_DAILY_CAP(), 100_000e18);
        assertEq(sites.MAX_DAILY_CAP(), 5_000_000e18);
        assertEq(sites.EARNINGS_TYPEHASH(), keccak256("Earnings(address player,uint256 total,uint64 deadline)"));
        assertEq(sites.today(), _now() / 1 days);
        (, string memory name, string memory version,, address verifying,,) = sites.eip712Domain();
        assertEq(name, "MineWorldCraft Mining");
        assertEq(version, "1");
        assertEq(verifying, address(sites));
    }

    function test_ConstructorChecks() public {
        address t = address(token);
        vm.expectRevert(MiningSites.ZeroAddress.selector);
        this.newSites(address(0), owner, treasury, signer, PRICE, WALLET_CAP, DAILY_CAP);
        vm.expectRevert(MiningSites.ZeroAddress.selector);
        this.newSites(t, owner, address(0), signer, PRICE, WALLET_CAP, DAILY_CAP);
        vm.expectRevert(MiningSites.ZeroAddress.selector);
        this.newSites(t, owner, treasury, address(0), PRICE, WALLET_CAP, DAILY_CAP);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        this.newSites(t, address(0), treasury, signer, PRICE, WALLET_CAP, DAILY_CAP);
        vm.expectRevert(MiningSites.ZeroPrice.selector);
        this.newSites(t, owner, treasury, signer, 0, WALLET_CAP, DAILY_CAP);
        vm.expectRevert(MiningSites.BadCaps.selector);
        this.newSites(t, owner, treasury, signer, PRICE, 0, DAILY_CAP);
        vm.expectRevert(MiningSites.BadCaps.selector);
        this.newSites(t, owner, treasury, signer, PRICE, 100_000e18 + 1, DAILY_CAP);
        vm.expectRevert(MiningSites.BadCaps.selector);
        this.newSites(t, owner, treasury, signer, PRICE, WALLET_CAP, WALLET_CAP - 1);
        vm.expectRevert(MiningSites.BadCaps.selector);
        this.newSites(t, owner, treasury, signer, PRICE, WALLET_CAP, 5_000_000e18 + 1);
        // The treasury can't be the contract itself (its address is the factory's next one).
        SitesFactory f = new SitesFactory();
        address next = vm.computeCreateAddress(address(f), vm.getNonce(address(f)));
        vm.expectRevert(MiningSites.BadTreasury.selector);
        f.make(t, owner, next, signer, PRICE, WALLET_CAP, DAILY_CAP);
    }

    // ---------------------------------------------------------------- sites

    function test_OpenSitePaysTheTreasury() public {
        assertFalse(sites.hasSite(carol));
        assertEq(sites.siteOf(carol), 0);
        uint256 before = treasury.balance;
        vm.expectEmit(address(sites));
        emit MiningSites.SiteOpened(carol, PRICE);
        vm.prank(carol);
        sites.openSite{value: PRICE}();
        assertTrue(sites.hasSite(carol));
        assertEq(sites.siteOf(carol), _now());
        assertEq(treasury.balance - before, PRICE);
        assertEq(address(sites).balance, 0, "never holds ETH");
        assertEq(treasury.balance, 3 * PRICE); // alice's, bob's and carol's
    }

    function test_OpenSiteOnceForExactlyThePrice() public {
        vm.startPrank(carol);
        vm.expectRevert(MiningSites.WrongPayment.selector);
        sites.openSite{value: PRICE - 1}();
        vm.expectRevert(MiningSites.WrongPayment.selector);
        sites.openSite{value: PRICE + 1}();
        vm.expectRevert(MiningSites.WrongPayment.selector);
        sites.openSite();
        sites.openSite{value: PRICE}();
        vm.expectRevert(MiningSites.AlreadyOpen.selector);
        sites.openSite{value: PRICE}();
        vm.stopPrank();
    }

    function test_PlainEthIsRefused() public {
        vm.prank(carol);
        (bool ok,) = address(sites).call{value: 1 ether}("");
        assertFalse(ok);
        vm.prank(carol);
        (ok,) = address(sites).call{value: 1 ether}(hex"12345678");
        assertFalse(ok);
        assertEq(address(sites).balance, 0);
    }

    /// ETH forced in without a call (selfdestruct) leaves with the next site.
    function test_ForcedEthGoesToTheTreasury() public {
        new ForceSend{value: 1 ether}(payable(address(sites)));
        assertEq(address(sites).balance, 1 ether);
        uint256 before = treasury.balance;
        vm.prank(carol);
        sites.openSite{value: PRICE}();
        assertEq(address(sites).balance, 0);
        assertEq(treasury.balance - before, 1 ether + PRICE);
    }

    function test_SitePriceChanges() public {
        vm.prank(owner);
        vm.expectRevert(MiningSites.ZeroPrice.selector);
        sites.setSitePrice(0);
        vm.prank(owner);
        sites.setSitePrice(0.01 ether);
        assertEq(sites.sitePrice(), 0.01 ether);
        // A buyer who saw the old price is refused, not charged a different amount.
        vm.prank(carol);
        vm.expectRevert(MiningSites.WrongPayment.selector);
        sites.openSite{value: PRICE}();
        vm.prank(carol);
        sites.openSite{value: 0.01 ether}();
        // Sites already open stay open.
        assertTrue(sites.hasSite(alice));
    }

    function test_TreasuryMoves() public {
        address next = makeAddr("next");
        vm.startPrank(owner);
        vm.expectRevert(MiningSites.ZeroAddress.selector);
        sites.setTreasury(address(0));
        vm.expectRevert(MiningSites.BadTreasury.selector);
        sites.setTreasury(address(sites));
        sites.setTreasury(next);
        vm.stopPrank();
        vm.prank(carol);
        sites.openSite{value: PRICE}();
        assertEq(next.balance, PRICE);
    }

    /// A treasury that calls back in while it's paid can't claim or open a second site: both are nonReentrant.
    function test_TreasuryCantReenter() public {
        ReentrantTreasury rt = new ReentrantTreasury();
        vm.deal(address(rt), 1 ether);
        vm.prank(address(rt));
        sites.openSite{value: PRICE}(); // it has a site, so only the reentrancy guard can stop its claim
        vm.prank(owner);
        sites.setTreasury(address(rt));
        uint64 deadline = uint64(_now() + 1 hours);
        rt.arm(sites, abi.encodeCall(MiningSites.claim, (1_000e18, deadline, _sig(address(rt), 1_000e18, deadline))));
        vm.prank(carol);
        sites.openSite{value: PRICE}();
        assertTrue(rt.reentered());
        assertFalse(rt.reentryWorked());
        assertEq(token.balanceOf(address(rt)), 0);
        // Outside the payment, the same voucher pays.
        vm.prank(address(rt));
        assertEq(sites.claim(1_000e18, deadline, _sig(address(rt), 1_000e18, deadline)), 1_000e18);
    }

    // ---------------------------------------------------------------- claiming

    function test_ClaimPaysTheVoucher() public {
        vm.expectEmit(address(sites));
        emit MiningSites.Claimed(alice, 1_000e18, 1_000e18);
        assertEq(_claim(alice, 1_000e18), 1_000e18);
        assertEq(token.balanceOf(alice), 1_000e18);
        assertEq(sites.claimed(alice), 1_000e18);
        assertEq(sites.paidToday(), 1_000e18);
        assertEq(sites.walletPaidToday(alice), 1_000e18);
        assertEq(sites.walletPaidToday(bob), 0);
        assertEq(sites.vaultBalance(), VAULT - 1_000e18);
    }

    function test_ClaimingAgainPaysOnlyTheDifference() public {
        _claim(alice, 1_000e18);
        assertEq(_claim(alice, 1_500e18), 500e18);
        assertEq(sites.claimed(alice), 1_500e18);
        // The same voucher, or an older one, pays nothing more.
        vm.expectRevert(MiningSites.NothingToClaim.selector);
        this.claimAs(alice, 1_500e18);
        vm.expectRevert(MiningSites.NothingToClaim.selector);
        this.claimAs(alice, 1_000e18);
        vm.expectRevert(MiningSites.NothingToClaim.selector);
        this.claimAs(alice, 0);
    }

    function test_SignaturesMustBeTheSignersForThisWalletAndTotal() public {
        uint64 deadline = uint64(_now() + 1 hours);
        // Signed by someone else.
        bytes memory forged = _voucher(sites, 0xBAD, alice, 1_000e18, deadline);
        vm.prank(alice);
        vm.expectRevert(MiningSites.BadSignature.selector);
        sites.claim(1_000e18, deadline, forged);
        // Bob's voucher, used by alice.
        bytes memory bobs = _sig(bob, 1_000e18, deadline);
        vm.prank(alice);
        vm.expectRevert(MiningSites.BadSignature.selector);
        sites.claim(1_000e18, deadline, bobs);
        // A different total, or a different deadline, than signed.
        bytes memory good = _sig(alice, 1_000e18, deadline);
        vm.prank(alice);
        vm.expectRevert(MiningSites.BadSignature.selector);
        sites.claim(2_000e18, deadline, good);
        vm.prank(alice);
        vm.expectRevert(MiningSites.BadSignature.selector);
        sites.claim(1_000e18, deadline + 1, good);
        // Malformed signatures count as forged.
        vm.prank(alice);
        vm.expectRevert(MiningSites.BadSignature.selector);
        sites.claim(1_000e18, deadline, hex"1234");
        vm.prank(alice);
        vm.expectRevert(MiningSites.BadSignature.selector);
        sites.claim(1_000e18, deadline, new bytes(65));
        // The real one works.
        vm.prank(alice);
        sites.claim(1_000e18, deadline, good);
        assertEq(token.balanceOf(alice), 1_000e18);
    }

    /// A voucher signed for another deployment (another verifying contract) doesn't work here.
    function test_VouchersAreBoundToThisContract() public {
        (, MiningSites other) = _deploy(owner, treasury, signer, PRICE, WALLET_CAP, DAILY_CAP, pool);
        uint64 deadline = uint64(_now() + 1 hours);
        bytes memory forOther = _voucher(other, SIGNER_KEY, alice, 1_000e18, deadline);
        vm.prank(alice);
        vm.expectRevert(MiningSites.BadSignature.selector);
        sites.claim(1_000e18, deadline, forOther);
    }

    function test_ExpiredVouchersAreRefused() public {
        uint64 deadline = uint64(_now() - 1);
        bytes memory sig = _sig(alice, 1_000e18, deadline);
        vm.prank(alice);
        vm.expectRevert(MiningSites.Expired.selector);
        sites.claim(1_000e18, deadline, sig);
        // Valid up to and including the deadline second.
        deadline = uint64(_now());
        sig = _sig(alice, 1_000e18, deadline);
        vm.prank(alice);
        sites.claim(1_000e18, deadline, sig);
    }

    function test_NoSiteNoClaim() public {
        vm.expectRevert(MiningSites.NoSite.selector);
        this.claimAs(carol, 1_000e18);
        assertEq(sites.claimable(carol, 1_000e18), 0);
        vm.prank(carol);
        sites.openSite{value: PRICE}();
        assertEq(_claim(carol, 1_000e18), 1_000e18);
    }

    function test_PausedStopsClaimsButNotEarnings() public {
        vm.prank(owner);
        sites.setPaused(true);
        assertTrue(sites.paused());
        vm.expectRevert(MiningSites.IsPaused.selector);
        this.claimAs(alice, 1_000e18);
        assertEq(sites.claimable(alice, 1_000e18), 0);
        // Sites can still be opened.
        vm.prank(carol);
        sites.openSite{value: PRICE}();
        vm.prank(owner);
        sites.setPaused(false);
        assertEq(_claim(alice, 1_000e18), 1_000e18);
    }

    /// Partial claims: the wallet cap holds back the rest, which stays claimable on later days.
    function test_WalletCapAndPartialClaimsAcrossDays() public {
        assertEq(sites.claimable(alice, 12_000e18), 5_000e18);
        assertEq(_claim(alice, 12_000e18), 5_000e18);
        assertEq(sites.claimed(alice), 5_000e18, "claimed grows only by what was paid");
        vm.expectRevert(MiningSites.NothingToClaim.selector);
        this.claimAs(alice, 12_000e18);
        assertEq(sites.claimable(alice, 12_000e18), 0);
        _nextDay();
        assertEq(sites.walletPaidToday(alice), 0, "a new day");
        assertEq(_claim(alice, 12_000e18), 5_000e18);
        _nextDay();
        assertEq(_claim(alice, 12_000e18), 2_000e18);
        assertEq(sites.claimed(alice), 12_000e18);
        vm.expectRevert(MiningSites.NothingToClaim.selector);
        this.claimAs(alice, 12_000e18);
        // A bigger total later pays the new part, within today's room.
        assertEq(_claim(alice, 14_000e18), 2_000e18);
    }

    function test_GlobalCapAcrossEveryone() public {
        vm.prank(owner);
        sites.setCaps(5_000e18, 8_000e18);
        assertEq(_claim(alice, 6_000e18), 5_000e18);
        assertEq(sites.claimable(bob, 6_000e18), 3_000e18);
        assertEq(_claim(bob, 6_000e18), 3_000e18);
        assertEq(sites.paidToday(), 8_000e18);
        vm.expectRevert(MiningSites.NothingToClaim.selector);
        this.claimAs(bob, 6_000e18);
        vm.expectRevert(MiningSites.NothingToClaim.selector);
        this.claimAs(alice, 6_000e18);
        _nextDay();
        assertEq(sites.paidToday(), 0);
        assertEq(_claim(bob, 6_000e18), 3_000e18);
        assertEq(_claim(alice, 6_000e18), 1_000e18);
    }

    /// Lowering a cap below what's already been paid today just stops today's claims.
    function test_LoweredCapStopsTodaysClaims() public {
        _claim(alice, 5_000e18);
        vm.prank(owner);
        sites.setCaps(1_000e18, 1_000e18);
        assertEq(sites.claimable(bob, 1_000e18), 0);
        vm.expectRevert(MiningSites.NothingToClaim.selector);
        this.claimAs(bob, 1_000e18);
        _nextDay();
        assertEq(_claim(bob, 3_000e18), 1_000e18);
    }

    /// Caps reset at midnight UTC: a claim just before and one just after each get a full day's room. (This is the
    /// "two days' worth back to back" in the contract's trust note.)
    function test_CapsResetAtMidnight() public {
        uint256 midnight = (_now() / 1 days + 1) * 1 days;
        vm.warp(midnight - 1);
        assertEq(_claim(alice, 20_000e18), 5_000e18);
        vm.warp(midnight);
        assertEq(_claim(alice, 20_000e18), 5_000e18);
    }

    function test_CapBounds() public {
        vm.startPrank(owner);
        vm.expectRevert(MiningSites.BadCaps.selector);
        sites.setCaps(0, 1_000e18);
        vm.expectRevert(MiningSites.BadCaps.selector);
        sites.setCaps(100_000e18 + 1, 5_000_000e18);
        vm.expectRevert(MiningSites.BadCaps.selector);
        sites.setCaps(5_000e18, 4_999e18); // the cap across everyone below one wallet's
        vm.expectRevert(MiningSites.BadCaps.selector);
        sites.setCaps(5_000e18, 5_000_000e18 + 1);
        vm.expectEmit(address(sites));
        emit MiningSites.CapsSet(100_000e18, 5_000_000e18);
        sites.setCaps(100_000e18, 5_000_000e18); // the maxima themselves are fine
        sites.setCaps(1, 1); // and so is the smallest
        vm.stopPrank();
        assertEq(sites.walletDailyCap(), 1);
        assertEq(sites.dailyCap(), 1);
    }

    /// The vault pays what it has; the rest stays claimable if it's topped up (any $MINE sent here joins the vault).
    function test_PaysWhatTheVaultHolds() public {
        // A small vault: a stand-in token holding 100.
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        MiningSites small = new MiningSites(IERC20(predicted), owner, treasury, signer, PRICE, WALLET_CAP, DAILY_CAP);
        OtherCoin coin = new OtherCoin(address(small), 100e18);
        assertEq(address(coin), predicted);
        vm.prank(alice);
        small.openSite{value: PRICE}();

        uint64 deadline = uint64(_now() + 1 hours);
        bytes memory sig = _voucher(small, SIGNER_KEY, alice, 1_000e18, deadline);
        assertEq(small.claimable(alice, 1_000e18), 100e18);
        vm.prank(alice);
        assertEq(small.claim(1_000e18, deadline, sig), 100e18);
        assertEq(small.vaultBalance(), 0);
        vm.prank(alice);
        vm.expectRevert(MiningSites.NothingToClaim.selector);
        small.claim(1_000e18, deadline, sig);

        vm.prank(alice);
        coin.transfer(address(small), 50e18); // alice sends some back: it joins the vault
        vm.prank(alice);
        assertEq(small.claim(1_000e18, deadline, sig), 50e18);
        assertEq(small.claimed(alice), 150e18);
    }

    function testFuzz_ClaimableMatchesWhatClaimPays(uint256 first, uint256 total, uint256 walletCap, uint256 cap) public {
        walletCap = bound(walletCap, 1, 100_000e18);
        cap = bound(cap, walletCap, 5_000_000e18);
        vm.prank(owner);
        sites.setCaps(walletCap, cap);
        first = bound(first, 1, 200_000e18);
        uint256 want = sites.claimable(bob, first);
        if (want == 0) return;
        assertEq(_claim(bob, first), want); // bob uses some of today's room first
        total = bound(total, 0, 1_000_000e18);
        uint256 expect = sites.claimable(alice, total);
        assertLe(expect, walletCap);
        assertLe(expect + sites.paidToday(), cap);
        assertLe(expect, total);
        if (expect == 0) {
            vm.expectRevert(MiningSites.NothingToClaim.selector);
            this.claimAs(alice, total);
        } else {
            assertEq(_claim(alice, total), expect);
        }
    }

    // ---------------------------------------------------------------- the owner

    function test_SignerCanBeReplaced() public {
        uint256 newKey = 0xC0FFEE;
        vm.prank(owner);
        vm.expectRevert(MiningSites.ZeroAddress.selector);
        sites.setSigner(address(0));
        vm.expectEmit(address(sites));
        emit MiningSites.SignerSet(signer, vm.addr(newKey));
        vm.prank(owner);
        sites.setSigner(vm.addr(newKey));
        // The old key's vouchers stop working; the new key's work.
        vm.expectRevert(MiningSites.BadSignature.selector);
        this.claimAs(alice, 1_000e18);
        uint64 deadline = uint64(_now() + 1 hours);
        bytes memory sig = _voucher(sites, newKey, alice, 1_000e18, deadline);
        vm.prank(alice);
        assertEq(sites.claim(1_000e18, deadline, sig), 1_000e18);
    }

    function test_SweepRefusesMine() public {
        vm.prank(pool);
        token.transfer(address(sites), 10e18); // $MINE sent here joins the vault, and stays in it
        vm.prank(owner);
        vm.expectRevert(MiningSites.CannotSweepMine.selector);
        sites.sweep(IERC20(address(token)), owner);
        assertEq(sites.vaultBalance(), VAULT + 10e18);

        OtherCoin coin = new OtherCoin(address(sites), 7e18);
        vm.prank(owner);
        vm.expectRevert(MiningSites.ZeroAddress.selector);
        sites.sweep(IERC20(address(coin)), address(0));
        vm.prank(owner);
        sites.sweep(IERC20(address(coin)), owner);
        assertEq(coin.balanceOf(owner), 7e18);
    }

    function test_RenounceReverts() public {
        vm.prank(owner);
        vm.expectRevert(MiningSites.CannotRenounce.selector);
        sites.renounceOwnership();
        assertEq(sites.owner(), owner);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        sites.renounceOwnership();
    }

    function test_OwnershipMovesInTwoSteps() public {
        address next = makeAddr("next");
        vm.prank(owner);
        sites.transferOwnership(next);
        assertEq(sites.owner(), owner);
        assertEq(sites.pendingOwner(), next);
        vm.prank(next);
        sites.acceptOwnership();
        assertEq(sites.owner(), next);
        vm.prank(next);
        sites.setPaused(true);
    }

    function test_OwnerOnly() public {
        bytes memory unauthorized = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice);
        vm.startPrank(alice);
        vm.expectRevert(unauthorized);
        sites.setSitePrice(1);
        vm.expectRevert(unauthorized);
        sites.setTreasury(alice);
        vm.expectRevert(unauthorized);
        sites.setSigner(alice);
        vm.expectRevert(unauthorized);
        sites.setPaused(true);
        vm.expectRevert(unauthorized);
        sites.setCaps(1, 1);
        vm.expectRevert(unauthorized);
        sites.sweep(IERC20(address(token)), alice);
        vm.expectRevert(unauthorized);
        sites.transferOwnership(alice);
        vm.stopPrank();
    }
}
