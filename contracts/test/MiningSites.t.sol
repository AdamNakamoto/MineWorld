// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, stdStorage, StdStorage} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {MineToken} from "../src/MineToken.sol";
import {MineVault} from "../src/MineVault.sol";
import {MiningSites} from "../src/MiningSites.sol";
import {MinePayer} from "../src/MinePayer.sol";
import {UpgradeCosts} from "../src/UpgradeCosts.sol";
import {OwnedUUPS} from "../src/lib/OwnedUUPS.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {CrafterLevels} from "../src/CrafterLevels.sol";
import {MinePayments} from "../src/MinePayments.sol";
import {MineDeployer} from "../script/Deploy.s.sol";

/// MiningSites' next version, for the upgrade test: the same contract, plus a way to tell it apart.
contract MiningSitesV2 is MiningSites {
    function version() external pure returns (uint256) {
        return 2;
    }
}

/// Deploys MiningSites' implementation, a vault naming the proxy, and the proxy, from its own nonce (so the test can
/// predict the proxy's address: `proxy`).
contract SitesFactory {
    function make(MineToken token, address owner, address treasury, address proxy) external returns (address) {
        MiningSites impl = new MiningSites();
        MineVault v = new MineVault(token, owner, proxy);
        return address(
            new ERC1967Proxy(
                address(impl),
                abi.encodeCall(MiningSites.initialize, (IERC20(address(token)), v, owner, treasury, owner, 1, 1, 1))
            )
        );
    }
}

/// Some other token, sent here by mistake.
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

/// A treasury with no receive or fallback: it refuses ETH (audit 0792975e #4).
contract NoReceive {}

/// A treasury contract that takes ETH.
contract TakesEth {
    receive() external payable {}
}

/// Helpers shared by the unit and invariant tests: the game deployed as the deploy script does it, and vouchers
/// signed the way the game server signs them.
abstract contract SitesFixture is Test, MineDeployer {
    /// The default site upgrade costs, to levels 2, 3, 4 and 5.
    uint256 constant COST_2 = 4_620e18;
    uint256 constant COST_3 = 18_942e18;
    uint256 constant COST_4 = 77_662e18;
    uint256 constant COST_5 = 318_415e18;

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

    /// @dev The token (its launch allocation to `pool`, a stand-in holder), the vault, MiningSites' proxy and the
    ///      payments, as the deploy script makes them.
    function _deploy(address owner, address treasury, address signer, uint256 price, uint256 walletCap, uint256 cap, address pool)
        internal
        returns (MineToken token, MiningSites sites)
    {
        Game memory g = _deployGame(address(this), owner, pool, Sites(treasury, signer, price, walletCap, cap));
        return (MineToken(g.token), MiningSites(g.sites));
    }

    function _list(uint256 a, uint256 b, uint256 c, uint256 d) internal pure returns (uint256[] memory l) {
        l = new uint256[](4);
        (l[0], l[1], l[2], l[3]) = (a, b, c, d);
    }

    function _list5(uint256 a, uint256 b, uint256 c, uint256 d, uint256 e) internal pure returns (uint256[] memory l) {
        l = new uint256[](5);
        (l[0], l[1], l[2], l[3], l[4]) = (a, b, c, d, e);
    }

    /// @dev `who` buys its site's next level: `from` (the pool's stand-in holder) gives it the cost, and it approves
    ///      exactly that, as the game does.
    function _upgrade(MiningSites sites, MineToken token, address from, address who) internal returns (uint256 cost) {
        cost = sites.upgradeCost(sites.siteLevel(who) + 1);
        vm.prank(from);
        token.transfer(who, cost);
        vm.startPrank(who);
        token.approve(address(sites), cost);
        sites.upgradeSite(cost, sites.levelRateBps(sites.siteLevel(who) + 1));
        vm.stopPrank();
    }
}

contract MiningSitesTest is SitesFixture {
    using stdStorage for StdStorage;

    MineToken token;
    MiningSites sites;
    MineVault vault;

    uint256 constant SIGNER_KEY = 0x5160;
    address signer = vm.addr(SIGNER_KEY);
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address pool = makeAddr("pool");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol"); // no site

    uint256 constant PRICE = 0.005 ether;
    uint256 constant WALLET_CAP = 1_500e18;
    uint256 constant DAILY_CAP = 35_000e18;
    uint256 constant VAULT = 10_500_000e18;

    function setUp() public {
        vm.warp(20_000 days + 12 hours); // midday
        (token, sites) = _deploy(owner, treasury, signer, PRICE, WALLET_CAP, DAILY_CAP, pool);
        vault = sites.vault();
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

    function _upgrade(address who) internal returns (uint256) {
        return _upgrade(sites, token, pool, who);
    }

    function _upgradeTo(address who, uint256 level) internal {
        while (sites.siteLevel(who) < level) _upgrade(who);
    }

    /// @dev A new MiningSites proxy, initialized with these settings, and a vault that names it its distributor.
    ///      External, so `vm.expectRevert` checks the deploy. (A `new` straight in the test body reverts the test
    ///      itself, which forge counts as the expected revert, so nothing after it would run.)
    function newSites(address t, address o, address tr, address si, uint256 price, uint256 w, uint256 c)
        external
        returns (address)
    {
        MiningSites impl = new MiningSites();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        MineVault v = new MineVault(token, owner, predicted);
        return address(
            new ERC1967Proxy(address(impl), abi.encodeCall(MiningSites.initialize, (IERC20(t), v, o, tr, si, price, w, c)))
        );
    }

    /// @dev A proxy initialized with `v`, a vault that may not name it.
    function newSitesWithVault(MineVault v) external returns (address) {
        MiningSites impl = new MiningSites();
        return address(
            new ERC1967Proxy(
                address(impl),
                abi.encodeCall(
                    MiningSites.initialize, (IERC20(address(token)), v, owner, treasury, signer, PRICE, WALLET_CAP, DAILY_CAP)
                )
            )
        );
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
        assertEq(sites.MAX_WALLET_DAILY_CAP(), 3_500e18);
        assertEq(sites.MAX_DAILY_CAP(), 35_000e18);
        assertEq(sites.maxLevel(), 5);
        assertEq(sites.MAX_LEVELS(), 20);
        assertEq(sites.MAX_UPGRADE_COST(), 1_000_000e18);
        assertEq(sites.MIN_RATE_BPS(), 1_000);
        assertEq(sites.upgradeBurnBps(), 7_500);
        assertEq(abi.encode(sites.upgradeCosts()), abi.encode(_list(COST_2, COST_3, COST_4, COST_5)));
        assertEq(abi.encode(sites.rates()), abi.encode(_list5(5_000, 6_000, 7_000, 8_500, 10_000)));
        assertEq(address(sites.vault()), address(vault));
        assertEq(vault.distributor(), address(sites));
        assertEq(token.minter(), address(vault));
        assertEq(token.owner(), address(0), "nobody owns the token");
        assertEq(vault.owner(), owner);
        assertEq(sites.upgradeCost(2), 4_620e18);
        assertEq(sites.upgradeCost(5), 318_415e18);
        assertEq(sites.EARNINGS_TYPEHASH(), keccak256("Earnings(address player,uint256 total,uint64 deadline)"));
        assertEq(sites.today(), _now() / 1 days);
        (, string memory name, string memory version,, address verifying,,) = sites.eip712Domain();
        assertEq(name, "MineWorldCraft Mining");
        assertEq(version, "1");
        assertEq(verifying, address(sites));
    }

    /// The highest daily cap mints the vault's whole share in exactly 300 days, so no setting of the caps can do it
    /// sooner.
    function test_MaxDailyCapIsTheVaultOver300Days() public view {
        assertEq(sites.MAX_DAILY_CAP() * 300, vault.TOTAL_LIMIT());
        assertEq(vault.TOTAL_LIMIT(), VAULT);
        assertEq(vault.TOTAL_LIMIT(), token.MAX_SUPPLY() - token.totalMinted());
    }

    /// Everyone claiming everything they can, every day, with the caps at their highest: the vault still lasts 300
    /// days (ten wallets at the 3,500 wallet cap fill the 35,000 a day).
    function test_VaultCantEmptyInUnder300Days() public {
        vm.prank(owner);
        sites.setCaps(3_500e18, 35_000e18);
        address[10] memory miners;
        bytes[10] memory sigs;
        uint64 deadline = type(uint64).max;
        uint256 huge = 1e30; // far more earnings than the vault holds
        for (uint256 i; i < 10; i++) {
            miners[i] = makeAddr(string.concat("miner", vm.toString(i)));
            vm.deal(miners[i], PRICE);
            vm.prank(miners[i]);
            sites.openSite{value: PRICE}();
            sigs[i] = _sig(miners[i], huge, deadline);
        }
        for (uint256 day = 1; day <= 300; day++) {
            for (uint256 i; i < 10; i++) {
                vm.prank(miners[i]);
                sites.claim(huge, deadline, sigs[i]);
            }
            assertEq(sites.paidToday(), 35_000e18);
            assertEq(sites.vaultBalance(), VAULT - day * 35_000e18);
            if (day < 300) assertGt(sites.vaultBalance(), 0, "the vault emptied early");
            _nextDay();
        }
        assertEq(sites.vaultBalance(), 0);
        assertEq(token.totalMinted(), token.MAX_SUPPLY(), "all 21M minted, never more");
        assertEq(sites.claimable(miners[0], huge), 0);
        vm.prank(miners[0]);
        vm.expectRevert(MiningSites.NothingToClaim.selector);
        sites.claim(huge, deadline, sigs[0]);
    }

    function test_InitializeChecks() public {
        address t = address(token);
        this.newSites(t, owner, treasury, signer, PRICE, WALLET_CAP, DAILY_CAP); // the good one
        vm.expectRevert(MinePayer.ZeroAddress.selector);
        this.newSites(address(0), owner, treasury, signer, PRICE, WALLET_CAP, DAILY_CAP);
        vm.expectRevert(MinePayer.ZeroAddress.selector);
        this.newSites(t, owner, address(0), signer, PRICE, WALLET_CAP, DAILY_CAP);
        vm.expectRevert(MinePayer.ZeroAddress.selector);
        this.newSites(t, owner, treasury, address(0), PRICE, WALLET_CAP, DAILY_CAP);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        this.newSites(t, address(0), treasury, signer, PRICE, WALLET_CAP, DAILY_CAP);
        vm.expectRevert(MiningSites.ZeroPrice.selector);
        this.newSites(t, owner, treasury, signer, 0, WALLET_CAP, DAILY_CAP);
        vm.expectRevert(MiningSites.BadCaps.selector);
        this.newSites(t, owner, treasury, signer, PRICE, 0, DAILY_CAP);
        vm.expectRevert(MiningSites.BadCaps.selector);
        this.newSites(t, owner, treasury, signer, PRICE, 3_500e18 + 1, DAILY_CAP);
        vm.expectRevert(MiningSites.BadCaps.selector);
        this.newSites(t, owner, treasury, signer, PRICE, WALLET_CAP, WALLET_CAP - 1);
        vm.expectRevert(MiningSites.BadCaps.selector);
        this.newSites(t, owner, treasury, signer, PRICE, WALLET_CAP, 35_000e18 + 1);
        // The treasury can't be the proxy itself (the factory's third contract from now).
        SitesFactory f = new SitesFactory();
        address next = vm.computeCreateAddress(address(f), vm.getNonce(address(f)) + 2);
        vm.expectRevert(MinePayer.BadTreasury.selector);
        f.make(token, owner, next, next);
        f.make(token, owner, treasury, next); // (the same, with another treasury, works)
        // The vault must mint this token and name this proxy its distributor.
        vm.expectRevert(MiningSites.BadVault.selector);
        this.newSitesWithVault(vault); // (its distributor is the first proxy)
        MineToken other = new MineToken(address(this), address(this), 1);
        MineVault otherVault = new MineVault(other, owner, vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1));
        vm.expectRevert(MiningSites.BadVault.selector);
        this.newSitesWithVault(otherVault);
    }

    /// The implementation can't be set up or used on its own, and the proxy can't be set up twice.
    function test_InitializersAreLocked() public {
        MiningSites impl = new MiningSites();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(IERC20(address(token)), vault, owner, treasury, signer, PRICE, WALLET_CAP, DAILY_CAP);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        sites.initialize(IERC20(address(token)), vault, alice, alice, alice, PRICE, WALLET_CAP, DAILY_CAP);
        assertEq(sites.owner(), owner);
    }

    // ---------------------------------------------------------------- sites

    function test_OpenSitePaysTheTreasury() public {
        assertFalse(sites.hasSite(carol));
        assertEq(sites.siteOf(carol), 0);
        assertEq(sites.siteLevel(carol), 0);
        assertEq(sites.rateBps(carol), 0);
        uint256 before = treasury.balance;
        vm.expectEmit(address(sites));
        emit MiningSites.SiteOpened(carol, PRICE);
        vm.prank(carol);
        sites.openSite{value: PRICE}();
        assertTrue(sites.hasSite(carol));
        assertEq(sites.siteOf(carol), _now());
        assertEq(sites.siteLevel(carol), 1, "a new site is level 1");
        assertEq(sites.rateBps(carol), 5_000, "which converts half");
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

    /// An upgraded site can't be opened again (back to level 1, or a second time).
    function test_UpgradedSiteCantBeReopened() public {
        _upgrade(alice);
        vm.prank(alice);
        vm.expectRevert(MiningSites.AlreadyOpen.selector);
        sites.openSite{value: PRICE}();
        assertEq(sites.siteLevel(alice), 2);
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
        vm.expectRevert(MinePayer.ZeroAddress.selector);
        sites.setTreasury(address(0));
        vm.expectRevert(MinePayer.BadTreasury.selector);
        sites.setTreasury(address(sites));
        sites.setTreasury(next);
        vm.stopPrank();
        vm.prank(carol);
        sites.openSite{value: PRICE}();
        assertEq(next.balance, PRICE);
        // Upgrades pay the new treasury too.
        _upgrade(alice);
        assertEq(token.balanceOf(next), COST_2 / 4);
        assertEq(token.balanceOf(treasury), 0);
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
        // Outside the payment, the same voucher pays (half of it, at level 1).
        vm.prank(address(rt));
        assertEq(sites.claim(1_000e18, deadline, _sig(address(rt), 1_000e18, deadline)), 500e18);
    }

    /// Audit 0792975e #4: a treasury that refuses ETH would make every openSite revert, so it's refused when it's
    /// set (setTreasury and initialize). A wallet, or a contract that takes ETH, is fine, and is paid.
    function test_TreasuryMustTakeEth() public {
        NoReceive no = new NoReceive();
        vm.prank(owner);
        vm.expectRevert(MiningSites.TreasuryRefusesEth.selector);
        sites.setTreasury(address(no));
        assertEq(sites.treasury(), treasury);
        vm.expectRevert(MiningSites.TreasuryRefusesEth.selector);
        this.newSites(address(token), owner, address(no), signer, PRICE, WALLET_CAP, DAILY_CAP);

        TakesEth yes = new TakesEth();
        vm.prank(owner);
        sites.setTreasury(address(yes));
        vm.prank(carol);
        sites.openSite{value: PRICE}();
        assertEq(address(yes).balance, PRICE);
        address wallet = makeAddr("wallet");
        vm.prank(owner);
        sites.setTreasury(wallet);
        address dave = makeAddr("dave");
        vm.deal(dave, 1 ether);
        vm.prank(dave);
        sites.openSite{value: PRICE}();
        assertEq(wallet.balance, PRICE);
        this.newSites(address(token), owner, address(yes), signer, PRICE, WALLET_CAP, DAILY_CAP);
        this.newSites(address(token), owner, wallet, signer, PRICE, WALLET_CAP, DAILY_CAP);
    }

    // ---------------------------------------------------------------- upgrades

    /// 75% of the cost is burned from the wallet, 25% goes from the wallet to the treasury; the vault is untouched.
    function test_UpgradeBurnsThreeQuartersAndPaysTheTreasuryTheRest() public {
        vm.prank(pool);
        token.transfer(alice, COST_2);
        vm.prank(alice);
        token.approve(address(sites), COST_2);
        uint256 supply = token.totalSupply();
        vm.expectEmit(address(sites));
        emit MiningSites.SiteUpgraded(alice, 2, COST_2, 3_465e18);
        vm.prank(alice);
        assertEq(sites.upgradeSite(COST_2, 0), 2);
        assertEq(sites.siteLevel(alice), 2);
        assertEq(sites.rateBps(alice), 6_000);
        assertEq(supply - token.totalSupply(), 3_465e18, "75% burned");
        assertEq(token.balanceOf(treasury), 1_155e18, "25% to the treasury");
        assertEq(token.balanceOf(alice), 0);
        assertEq(token.allowance(alice, address(sites)), 0);
        assertEq(sites.vaultBalance(), VAULT, "the vault is untouched");
        assertEq(token.balanceOf(address(sites)), 0);
        assertEq(sites.siteOf(alice), 20_000 days + 12 hours, "still the same site");
    }

    /// Level 1 to 5, each at its cost and rate; then no more.
    function test_UpgradeAllTheWayToLevelFive() public {
        uint256[6] memory rates = [uint256(0), 5_000, 6_000, 7_000, 8_500, 10_000];
        uint256 supply = token.totalSupply();
        uint256 spent;
        assertEq(sites.rateBps(alice), rates[1]);
        for (uint256 level = 2; level <= 5; level++) {
            spent += _upgrade(alice);
            assertEq(sites.siteLevel(alice), level);
            assertEq(sites.rateBps(alice), rates[level]);
            assertEq(sites.levelRateBps(level), rates[level]);
        }
        assertEq(spent, COST_2 + COST_3 + COST_4 + COST_5);
        assertEq(spent, 419_639e18, "about $1,000 at a $50,000 market cap");
        assertEq(supply - token.totalSupply(), spent * 3 / 4);
        assertEq(token.balanceOf(treasury), spent / 4);
        assertEq(sites.vaultBalance(), VAULT);

        vm.prank(pool);
        token.transfer(alice, 1_000_000e18);
        vm.startPrank(alice);
        token.approve(address(sites), type(uint256).max);
        vm.expectRevert(UpgradeCosts.MaxLevel.selector);
        sites.upgradeSite(type(uint256).max, 0);
        vm.stopPrank();
        assertEq(sites.levelRateBps(0), 0);
        assertEq(sites.levelRateBps(6), 0);
    }

    function test_UpgradeNeedsASiteAndTheMine() public {
        vm.prank(pool);
        token.transfer(carol, COST_2);
        vm.startPrank(carol);
        token.approve(address(sites), COST_2);
        vm.expectRevert(MiningSites.NoSite.selector);
        sites.upgradeSite(COST_2, 0);
        vm.stopPrank();

        // Not approved, too little approved, approved but not held.
        vm.prank(pool);
        token.transfer(alice, COST_2);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(sites), 0, COST_2 * 3 / 4)
        );
        sites.upgradeSite(COST_2, 0);
        vm.prank(alice);
        token.approve(address(sites), COST_2 - 1);
        vm.prank(alice);
        vm.expectRevert();
        sites.upgradeSite(COST_2, 0);
        vm.prank(bob);
        token.approve(address(sites), COST_2);
        vm.prank(bob);
        vm.expectRevert();
        sites.upgradeSite(COST_2, 0);
        assertEq(sites.siteLevel(alice), 1);
        assertEq(sites.siteLevel(bob), 1);
    }

    /// The game passes the cost it shows as maxCost (and approves exactly that): a cost raised before the upgrade is
    /// mined makes it revert instead of charging more.
    function test_RaisedCostRevertsForAnExactApproval() public {
        vm.prank(pool);
        token.transfer(alice, 50_000e18);
        vm.prank(alice);
        token.approve(address(sites), COST_2);
        vm.prank(owner);
        sites.setUpgradeCosts(_list(10_000e18, COST_3, COST_4, COST_5));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(UpgradeCosts.CostAboveMax.selector, 10_000e18, COST_2));
        sites.upgradeSite(COST_2, 0);
        assertEq(token.balanceOf(alice), 50_000e18);
        // Lowered, the same approval and maxCost cover it, and it charges the lower cost.
        vm.prank(owner);
        sites.setUpgradeCosts(_list(4_000e18, COST_3, COST_4, COST_5));
        vm.prank(alice);
        sites.upgradeSite(COST_2, 0);
        assertEq(token.balanceOf(alice), 46_000e18);
    }

    /// Audit 0792975e #5: with an unlimited allowance (a wallet's default, another front end's), a cost raise mined
    /// just before the upgrade still can't charge more than the maxCost the player sent.
    function test_RaisedCostRevertsEvenWithAnUnlimitedApproval() public {
        vm.prank(pool);
        token.transfer(alice, 1_000_000e18);
        vm.prank(alice);
        token.approve(address(sites), type(uint256).max);
        assertEq(sites.upgradeCost(2), COST_2); // what the player was shown
        vm.prank(owner);
        sites.setUpgradeCosts(_list(1_000_000e18, COST_3, COST_4, COST_5)); // mined first
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(UpgradeCosts.CostAboveMax.selector, 1_000_000e18, COST_2));
        sites.upgradeSite(COST_2, 0);
        assertEq(token.balanceOf(alice), 1_000_000e18, "nothing taken");
        assertEq(sites.siteLevel(alice), 1);
        // One wei short of the cost is refused too; the cost itself, agreed to, goes through.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(UpgradeCosts.CostAboveMax.selector, 1_000_000e18, 1_000_000e18 - 1));
        sites.upgradeSite(1_000_000e18 - 1, 0);
        vm.prank(alice);
        assertEq(sites.upgradeSite(1_000_000e18, 0), 2);
        assertEq(token.balanceOf(alice), 0);
    }

    /// Re-check 8c7ba957 #5: a rate cut mined just before the upgrade makes it revert (the player sent the rate it
    /// was shown as minRateBps), instead of charging the full cost for a level that converts no more.
    function test_RateCutMinedFirstRevertsTheUpgrade() public {
        vm.prank(pool);
        token.transfer(alice, COST_2);
        vm.prank(alice);
        token.approve(address(sites), COST_2);
        assertEq(sites.levelRateBps(2), 6_000); // what alice was shown
        vm.prank(owner);
        sites.setRates(_list5(5_000, 5_000, 7_000, 8_500, 10_000)); // mined first
        uint256 supply = token.totalSupply();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MiningSites.RateBelowMin.selector, 5_000, 6_000));
        sites.upgradeSite(COST_2, 6_000);
        assertEq(token.balanceOf(alice), COST_2, "nothing taken");
        assertEq(token.totalSupply(), supply, "nothing burned");
        assertEq(sites.siteLevel(alice), 1);
        // Agreeing to the new rate, it goes through.
        vm.prank(alice);
        assertEq(sites.upgradeSite(COST_2, 5_000), 2);
        assertEq(sites.rateBps(alice), 5_000);
    }

    /// Second re-check 52b534f9 #1, case (c): initialize runs only in the proxy's own constructor, so a launch done
    /// in two steps by mistake (the vault names a proxy deployed without its initialize) leaves a proxy nobody can set
    /// up: not a stranger (with any vault), not the vault's owner. The owner recovers by replacing it, as MineVault
    /// sets out; the replacement follows the dead one (whose books are empty) and pays.
    function test_InitializeOnlyInTheConstructor() public {
        MiningSites impl = new MiningSites();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        MineVault v = new MineVault(token, owner, predicted);
        address p = address(new ERC1967Proxy(address(impl), ""));
        assertEq(p, predicted);
        vm.prank(alice);
        vm.expectRevert(OwnedUUPS.InitializeOutsideConstructor.selector);
        MiningSites(p).initialize(IERC20(address(token)), v, alice, alice, alice, PRICE, WALLET_CAP, DAILY_CAP);
        vm.prank(owner);
        vm.expectRevert(OwnedUUPS.InitializeOutsideConstructor.selector);
        MiningSites(p).initialize(IERC20(address(token)), v, owner, treasury, signer, PRICE, WALLET_CAP, DAILY_CAP);
        assertEq(MiningSites(p).owner(), address(0));

        // The way out: a replacement, proposed at its predicted address and deployed initialised.
        address next = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        MiningSites impl2 = new MiningSites();
        vm.prank(owner);
        v.proposeDistributor(next);
        MiningSites replacement = MiningSites(
            address(
                new ERC1967Proxy(
                    address(impl2),
                    abi.encodeCall(
                        MiningSites.initialize,
                        (IERC20(address(token)), v, owner, treasury, signer, PRICE, WALLET_CAP, DAILY_CAP)
                    )
                )
            )
        );
        assertEq(address(replacement), next);
        assertEq(replacement.predecessor(), p);
        vm.warp(_now() + 2 days);
        vm.prank(owner);
        v.acceptDistributor();
        assertEq(v.distributor(), next);
        assertFalse(replacement.hasSite(carol));
    }

    function test_UpgradeCostsAreTheOwnersWithinBounds() public {
        vm.startPrank(owner);
        vm.expectRevert(UpgradeCosts.BadCosts.selector);
        sites.setUpgradeCosts(_list(0, COST_3, COST_4, COST_5));
        vm.expectRevert(UpgradeCosts.BadCosts.selector);
        sites.setUpgradeCosts(_list(COST_2, COST_3, COST_4, 1_000_000e18 + 1));
        vm.expectEmit(address(sites));
        emit UpgradeCosts.UpgradeCostsSet(_list(1, 2, 3, 1_000_000e18));
        sites.setUpgradeCosts(_list(1, 2, 3, 1_000_000e18)); // 1 wei and the maximum are fine
        vm.stopPrank();
        assertEq(sites.upgradeCost(2), 1);
        assertEq(sites.upgradeCost(5), 1_000_000e18);
        vm.expectRevert(UpgradeCosts.BadLevel.selector);
        sites.upgradeCost(1);
        vm.expectRevert(UpgradeCosts.BadLevel.selector);
        sites.upgradeCost(6);
        // A 1 wei upgrade: nothing to burn, the wei to the treasury.
        _upgrade(alice);
        assertEq(token.balanceOf(treasury), 1);
        // Levels already bought stay when the costs change.
        vm.prank(owner);
        sites.setUpgradeCosts(_list(COST_2, COST_3, COST_4, COST_5));
        assertEq(sites.siteLevel(alice), 2);
    }

    /// Upgrades don't need claims to be open.
    function test_UpgradeWhilePaused() public {
        vm.prank(owner);
        sites.setPaused(true);
        _upgrade(alice);
        assertEq(sites.siteLevel(alice), 2);
    }

    // ---------------------------------------------------------------- claiming

    function test_ClaimPaysTheVoucherAtTheSiteRate() public {
        assertEq(sites.claimable(alice, 1_000e18), 500e18);
        vm.expectEmit(address(sites));
        emit MiningSites.Claimed(alice, 500e18, 1_000e18, 5_000, 500e18, 1_000e18);
        assertEq(_claim(alice, 1_000e18), 500e18);
        assertEq(token.balanceOf(alice), 500e18);
        assertEq(sites.claimed(alice), 500e18);
        assertEq(sites.settled(alice), 1_000e18);
        assertEq(sites.paidToday(), 500e18);
        assertEq(sites.walletPaidToday(alice), 500e18);
        assertEq(sites.walletPaidToday(bob), 0);
        // The unconverted half stays in the vault for good.
        assertEq(sites.vaultBalance(), VAULT - 500e18);
    }

    function test_ClaimingAgainConvertsOnlyNewEarnings() public {
        _claim(alice, 1_000e18);
        assertEq(_claim(alice, 1_500e18), 250e18);
        assertEq(sites.claimed(alice), 750e18);
        assertEq(sites.settled(alice), 1_500e18);
        // The same voucher, or an older one, pays nothing more.
        vm.expectRevert(MiningSites.NothingToClaim.selector);
        this.claimAs(alice, 1_500e18);
        vm.expectRevert(MiningSites.NothingToClaim.selector);
        this.claimAs(alice, 1_000e18);
        vm.expectRevert(MiningSites.NothingToClaim.selector);
        this.claimAs(alice, 0);
    }

    /// Each level converts 1,000 earnings at its own rate.
    function test_EachLevelConvertsAtItsRate() public {
        uint256[6] memory pays = [uint256(0), 500e18, 600e18, 700e18, 850e18, 1_000e18];
        for (uint256 level = 1; level <= 5; level++) {
            _upgradeTo(alice, level);
            uint256 total = level * 1_000e18;
            assertEq(sites.claimable(alice, total), pays[level]);
            assertEq(_claim(alice, total), pays[level]);
            assertEq(sites.settled(alice), total);
            _nextDay();
        }
        assertEq(sites.claimed(alice), 3_650e18);
    }

    /// The rate is the one in force when you claim: earnings left unclaimed convert at the better rate after an
    /// upgrade (that's what the upgrade is for).
    function test_UpgradingBeforeClaimingConvertsTheBacklogAtTheNewRate() public {
        assertEq(sites.claimable(alice, 1_200e18), 600e18);
        _upgradeTo(alice, 5);
        assertEq(sites.claimable(alice, 1_200e18), 1_200e18);
        assertEq(_claim(alice, 1_200e18), 1_200e18);
        assertEq(sites.settled(alice), 1_200e18);
    }

    /// The wallet cap holds a payment back: only the earnings it covers are settled, and the rest converts later.
    function test_CappedClaimsSettleOnlyWhatTheyCover() public {
        // 5,000 earned at 50% is 2,500 owed; 1,500 a day.
        assertEq(sites.claimable(alice, 5_000e18), 1_500e18);
        assertEq(_claim(alice, 5_000e18), 1_500e18);
        assertEq(sites.settled(alice), 3_000e18, "1,500 paid covers 3,000 earnings");
        assertEq(sites.claimable(alice, 5_000e18), 0, "today's room is used");
        _nextDay();
        assertEq(sites.claimable(alice, 5_000e18), 1_000e18);
        assertEq(_claim(alice, 5_000e18), 1_000e18);
        assertEq(sites.settled(alice), 5_000e18, "paid in full: everything settled");
        assertEq(sites.claimed(alice), 2_500e18);
        vm.expectRevert(MiningSites.NothingToClaim.selector);
        this.claimAs(alice, 5_000e18);
    }

    /// At 85%, a payment the cap holds back covers a fraction of a wei of earnings: rounded up, in the vault's
    /// favour. Over the whole backlog the wallet gets at most its earnings' worth, and the last claim settles all.
    function test_CappedClaimsRoundInTheVaultsFavour() public {
        _upgradeTo(alice, 4);
        uint256 total = 10_000e18; // 8,500 owed at 85%
        uint256 paid = _claim(alice, total);
        assertEq(paid, 1_500e18);
        uint256 covered = Math.mulDiv(1_500e18, 10_000, 8_500, Math.Rounding.Ceil);
        assertEq(sites.settled(alice), covered);
        assertEq(covered, 1_764_705_882_352_941_176_471); // 1,764.70588235294117647058... rounded up
        assertGe(covered * 8_500, paid * 10_000, "never more than the earnings' worth");
        for (uint256 day; day < 10 && sites.settled(alice) < total; day++) {
            _nextDay();
            paid += _claim(alice, total);
        }
        assertEq(sites.settled(alice), total, "all settled in the end");
        assertEq(sites.claimed(alice), paid);
        assertLe(paid, 8_500e18);
        assertGe(paid, 8_500e18 - 10, "at most a few wei lost to rounding");
    }

    /// Paid in full, the whole total is settled, wei included: no dust is left to claim.
    function test_NoDustWhenNothingHoldsTheClaimBack() public {
        assertEq(_claim(alice, 3), 1); // 1.5 wei rounds down
        assertEq(sites.settled(alice), 3);
        vm.expectRevert(MiningSites.NothingToClaim.selector);
        this.claimAs(alice, 4); // 0.5 wei: nothing to pay, nothing settled
        assertEq(sites.settled(alice), 3);
        assertEq(_claim(alice, 5), 1);
        assertEq(sites.settled(alice), 5);
        assertEq(sites.claimed(alice), 2);
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
        assertEq(token.balanceOf(alice), 500e18);
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
        assertEq(_claim(carol, 1_000e18), 500e18);
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
        assertEq(_claim(alice, 1_000e18), 500e18);
    }

    /// Partial claims: the wallet cap holds back the rest, which stays claimable on later days.
    function test_WalletCapAndPartialClaimsAcrossDays() public {
        _upgradeTo(alice, 5); // 100%, so earnings and $MINE line up
        assertEq(sites.claimable(alice, 4_000e18), 1_500e18);
        assertEq(_claim(alice, 4_000e18), 1_500e18);
        assertEq(sites.claimed(alice), 1_500e18, "claimed grows only by what was paid");
        assertEq(sites.settled(alice), 1_500e18);
        vm.expectRevert(MiningSites.NothingToClaim.selector);
        this.claimAs(alice, 4_000e18);
        assertEq(sites.claimable(alice, 4_000e18), 0);
        _nextDay();
        assertEq(sites.walletPaidToday(alice), 0, "a new day");
        assertEq(_claim(alice, 4_000e18), 1_500e18);
        _nextDay();
        assertEq(_claim(alice, 4_000e18), 1_000e18);
        assertEq(sites.claimed(alice), 4_000e18);
        vm.expectRevert(MiningSites.NothingToClaim.selector);
        this.claimAs(alice, 4_000e18);
        // A bigger total later pays the new part, within today's room.
        assertEq(_claim(alice, 5_000e18), 500e18);
    }

    function test_GlobalCapAcrossEveryone() public {
        vm.prank(owner);
        sites.setCaps(1_500e18, 2_500e18);
        assertEq(_claim(alice, 4_000e18), 1_500e18);
        assertEq(sites.claimable(bob, 4_000e18), 1_000e18);
        assertEq(_claim(bob, 4_000e18), 1_000e18);
        assertEq(sites.settled(bob), 2_000e18);
        assertEq(sites.paidToday(), 2_500e18);
        vm.expectRevert(MiningSites.NothingToClaim.selector);
        this.claimAs(bob, 4_000e18);
        vm.expectRevert(MiningSites.NothingToClaim.selector);
        this.claimAs(alice, 4_000e18);
        _nextDay();
        assertEq(sites.paidToday(), 0);
        assertEq(_claim(bob, 4_000e18), 1_000e18);
        assertEq(_claim(alice, 4_000e18), 500e18);
    }

    /// Lowering a cap below what's already been paid today just stops today's claims.
    function test_LoweredCapStopsTodaysClaims() public {
        _claim(alice, 3_000e18);
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
        assertEq(_claim(alice, 20_000e18), 1_500e18);
        vm.warp(midnight);
        assertEq(_claim(alice, 20_000e18), 1_500e18);
    }

    function test_CapBounds() public {
        vm.startPrank(owner);
        vm.expectRevert(MiningSites.BadCaps.selector);
        sites.setCaps(0, 1_000e18);
        vm.expectRevert(MiningSites.BadCaps.selector);
        sites.setCaps(3_500e18 + 1, 35_000e18);
        vm.expectRevert(MiningSites.BadCaps.selector);
        sites.setCaps(1_500e18, 1_499e18); // the cap across everyone below one wallet's
        vm.expectRevert(MiningSites.BadCaps.selector);
        sites.setCaps(1_500e18, 35_000e18 + 1); // never above the 300-day pace
        vm.expectEmit(address(sites));
        emit MiningSites.CapsSet(3_500e18, 35_000e18);
        sites.setCaps(3_500e18, 35_000e18); // the maxima themselves are fine
        sites.setCaps(1, 1); // and so is the smallest
        vm.stopPrank();
        assertEq(sites.walletDailyCap(), 1);
        assertEq(sites.dailyCap(), 1);
    }

    /// Near the end of the vault's share, a claim pays what's left to mint; the rest of the earnings stay settled
    /// only as far as that covers them, and nothing more can ever be minted.
    function test_PaysWhatTheVaultCanStillMint() public {
        stdstore.target(address(vault)).sig("released()").checked_write(VAULT - 100e18);
        assertEq(vault.remaining(), 100e18);
        assertEq(sites.vaultBalance(), 100e18);
        assertEq(sites.claimable(alice, 1_000e18), 100e18);
        assertEq(_claim(alice, 1_000e18), 100e18);
        assertEq(sites.settled(alice), 200e18, "100 paid at 50% covers 200 earnings");
        assertEq(vault.remaining(), 0);
        assertEq(sites.claimable(alice, 1_000e18), 0);
        vm.expectRevert(MiningSites.NothingToClaim.selector);
        this.claimAs(alice, 1_000e18);
        _nextDay();
        vm.expectRevert(MiningSites.NothingToClaim.selector);
        this.claimAs(bob, 1_000e18);
    }

    /// The vault's daily limit counts every distributor: what it already minted today leaves this one less room.
    function test_VaultsDailyRoomLimitsClaims() public {
        vm.prank(owner);
        sites.setCaps(3_500e18, 35_000e18);
        // Pretend another distributor minted 34,000 today: write the vault's day record.
        bytes32 slot = bytes32(uint256(stdstore.target(address(vault)).sig("released()").find()) + 1);
        vm.store(address(vault), slot, bytes32((uint256(34_000e18) << 64) | (_now() / 1 days)));
        assertEq(vault.releasedToday(), 34_000e18);
        assertEq(sites.claimable(alice, 10_000e18), 1_000e18);
        assertEq(_claim(alice, 10_000e18), 1_000e18);
        assertEq(vault.releasedToday(), 35_000e18);
        assertEq(sites.claimable(bob, 10_000e18), 0);
    }

    /// claimable() is what claim() pays, at any level and with any caps, and the earnings it settles follow the
    /// rule: all of `total` when paid in full, else what the payment covers rounded up, never worth less than paid.
    function testFuzz_ClaimableMatchesWhatClaimPays(
        uint256 first,
        uint256 total,
        uint256 walletCap,
        uint256 cap,
        uint256 level,
        uint256 earlier
    ) public {
        walletCap = bound(walletCap, 1, 3_500e18);
        cap = bound(cap, walletCap, 35_000e18);
        vm.prank(owner);
        sites.setCaps(walletCap, cap);
        _upgradeTo(alice, bound(level, 1, 5));
        uint256 rate = sites.rateBps(alice);
        first = bound(first, 1, 200_000e18);
        uint256 want = sites.claimable(bob, first);
        if (want != 0) assertEq(_claim(bob, first), want); // bob uses some of today's room first
        // Alice may have converted some already, on an earlier day.
        earlier = bound(earlier, 0, 10_000e18);
        if (sites.claimable(alice, earlier) != 0) _claim(alice, earlier);
        _nextDay();
        if (sites.claimable(bob, first) != 0) _claim(bob, first);

        total = bound(total, 0, 1_000_000e18);
        uint256 done = sites.settled(alice);
        uint256 expect = sites.claimable(alice, total);
        assertLe(expect, walletCap);
        assertLe(expect + sites.paidToday(), cap);
        uint256 owed = total > done ? Math.mulDiv(total - done, rate, 10_000) : 0;
        assertLe(expect, owed);
        if (expect == 0) {
            vm.expectRevert(MiningSites.NothingToClaim.selector);
            this.claimAs(alice, total);
            assertEq(sites.settled(alice), done);
            return;
        }
        assertEq(_claim(alice, total), expect);
        uint256 settledNow = sites.settled(alice);
        if (expect == owed) {
            assertEq(settledNow, total, "paid in full: everything settled");
        } else {
            assertEq(settledNow - done, Math.mulDiv(expect, 10_000, rate, Math.Rounding.Ceil));
            assertLt(settledNow, total, "held back: some earnings stay claimable");
        }
        assertGe((settledNow - done) * rate, expect * 10_000, "never pays more than the earnings are worth");
    }

    // ---------------------------------------------------------------- the owner

    function test_SignerCanBeReplaced() public {
        uint256 newKey = 0xC0FFEE;
        vm.prank(owner);
        vm.expectRevert(MinePayer.ZeroAddress.selector);
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
        assertEq(sites.claim(1_000e18, deadline, sig), 500e18);
    }

    /// Tokens sent here by mistake can be sent on: MiningSites never holds any of its own ($MINE is minted straight
    /// to players).
    function test_SweepStrays() public {
        vm.prank(pool);
        token.transfer(address(sites), 10e18);
        OtherCoin coin = new OtherCoin(address(sites), 7e18);
        vm.startPrank(owner);
        vm.expectRevert(MinePayer.ZeroAddress.selector);
        sites.sweep(IERC20(address(coin)), address(0));
        sites.sweep(IERC20(address(coin)), owner);
        sites.sweep(IERC20(address(token)), owner);
        vm.stopPrank();
        assertEq(coin.balanceOf(owner), 7e18);
        assertEq(token.balanceOf(owner), 10e18);
        assertEq(sites.vaultBalance(), VAULT, "the vault's share is untouched");
    }

    // ---------------------------------------------------------------- tuning

    /// The owner sets the rates: one per level, each 10% to 100%, never lower than the level below's.
    function test_RatesAreTheOwnersWithinBounds() public {
        vm.startPrank(owner);
        vm.expectRevert(MiningSites.BadRates.selector);
        sites.setRates(_list(5_000, 6_000, 7_000, 8_500)); // one short
        vm.expectRevert(MiningSites.BadRates.selector);
        sites.setRates(_list5(999, 6_000, 7_000, 8_500, 10_000)); // under 10%
        vm.expectRevert(MiningSites.BadRates.selector);
        sites.setRates(_list5(5_000, 6_000, 7_000, 8_500, 10_001)); // over 100%
        vm.expectRevert(MiningSites.BadRates.selector);
        sites.setRates(_list5(5_000, 7_000, 6_000, 8_500, 10_000)); // a higher level lower
        vm.expectEmit(address(sites));
        emit MiningSites.RatesSet(_list5(1_000, 1_000, 4_000, 10_000, 10_000));
        sites.setRates(_list5(1_000, 1_000, 4_000, 10_000, 10_000)); // equal is fine, and so are the bounds
        vm.stopPrank();
        assertEq(sites.levelRateBps(1), 1_000);
        assertEq(sites.levelRateBps(4), 10_000);
        // Claims use the rate in force when they're made, earnings not yet claimed included.
        assertEq(_claim(alice, 1_000e18), 100e18);
        vm.prank(owner);
        sites.setRates(_list5(8_000, 8_000, 8_000, 9_000, 10_000));
        assertEq(_claim(alice, 2_000e18), 800e18);
    }

    /// The owner adds levels on top (cost and rate), up to 20, and never removes one.
    function test_AddLevels() public {
        vm.startPrank(owner);
        vm.expectRevert(MiningSites.BadRates.selector);
        sites.addLevel(500_000e18, 9_999); // lower than level 5's 100%
        vm.expectRevert(UpgradeCosts.BadCosts.selector);
        sites.addLevel(0, 10_000);
        vm.expectRevert(UpgradeCosts.BadCosts.selector);
        sites.addLevel(1_000_000e18 + 1, 10_000);
        vm.expectEmit(address(sites));
        emit UpgradeCosts.LevelAdded(6, 500_000e18);
        assertEq(sites.addLevel(500_000e18, 10_000), 6);
        vm.stopPrank();
        assertEq(sites.maxLevel(), 6);
        assertEq(sites.upgradeCost(6), 500_000e18);
        assertEq(sites.levelRateBps(6), 10_000);
        assertEq(sites.rates().length, 6);
        assertEq(sites.upgradeCosts().length, 5);
        _upgradeTo(alice, 6);
        assertEq(sites.siteLevel(alice), 6);
        vm.prank(pool);
        token.transfer(alice, 1_000_000e18);
        vm.prank(alice);
        token.approve(address(sites), type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(UpgradeCosts.MaxLevel.selector);
        sites.upgradeSite(type(uint256).max, 0);
        // Costs and rates now have six levels' worth.
        vm.startPrank(owner);
        vm.expectRevert(UpgradeCosts.BadCosts.selector);
        sites.setUpgradeCosts(_list(1, 2, 3, 4));
        uint256[] memory six = new uint256[](6);
        (six[0], six[1], six[2], six[3], six[4], six[5]) = (5_000, 6_000, 7_000, 8_500, 9_000, 10_000);
        sites.setRates(six);
        // Up to 20 levels in all.
        for (uint256 level = 7; level <= 20; level++) {
            sites.addLevel(1e18, 10_000);
        }
        assertEq(sites.maxLevel(), 20);
        vm.expectRevert(UpgradeCosts.TooManyLevels.selector);
        sites.addLevel(1e18, 10_000);
        vm.stopPrank();
    }

    /// The burn share of upgrades: 0% to 100%, all the rest to the treasury.
    function test_UpgradeBurnShare() public {
        vm.prank(owner);
        vm.expectRevert(MinePayer.BadBurn.selector);
        sites.setUpgradeBurnBps(10_001);
        vm.prank(owner);
        vm.expectEmit(address(sites));
        emit UpgradeCosts.UpgradeBurnSet(0);
        sites.setUpgradeBurnBps(0);
        uint256 supply = token.totalSupply();
        _upgrade(alice); // all to the treasury
        assertEq(token.balanceOf(treasury), COST_2);
        assertEq(token.totalSupply(), supply);
        vm.prank(owner);
        sites.setUpgradeBurnBps(10_000);
        _upgrade(alice); // all burned
        assertEq(token.balanceOf(treasury), COST_2);
        assertEq(supply - token.totalSupply(), COST_3);
        assertEq(token.totalBurned(), COST_3, "burns are permanent: totalMinted stays");
    }

    /// The daily cap across everyone can't pass what the vault allows a day.
    function test_DailyCapNeverAboveTheVaultsLimit() public {
        uint256 limit = vault.DAILY_LIMIT();
        assertEq(sites.MAX_DAILY_CAP(), limit);
        vm.prank(owner);
        vm.expectRevert(MiningSites.BadCaps.selector);
        sites.setCaps(1_500e18, limit + 1);
    }

    // ---------------------------------------------------------------- upgrades of the code

    /// An upgrade keeps every site, level, total, setting and voucher; only the owner can make one.
    function test_UpgradeKeepsEverything() public {
        _upgradeTo(alice, 3);
        _claim(alice, 5_000e18); // capped: 1,500 paid, part settled
        _claim(bob, 1_000e18);
        vm.startPrank(owner);
        sites.setCaps(2_000e18, 30_000e18);
        sites.setRates(_list5(5_000, 6_500, 7_000, 8_500, 10_000));
        sites.addLevel(400_000e18, 10_000);
        vm.stopPrank();
        bytes memory before = abi.encode(
            sites.siteLevel(alice), sites.siteLevel(bob), sites.siteOf(alice), sites.claimed(alice), sites.settled(alice),
            sites.claimed(bob), sites.settled(bob), sites.walletPaidToday(alice), sites.paidToday(), sites.rates(),
            sites.upgradeCosts(), sites.walletDailyCap(), sites.dailyCap()
        );
        bytes memory before2 = abi.encode(
            sites.signer(), sites.treasury(), sites.sitePrice(), sites.owner(), address(sites.vault()),
            address(sites.token()), sites.upgradeBurnBps(), sites.domainSeparator()
        );
        MiningSitesV2 v2 = new MiningSitesV2();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        sites.upgradeToAndCall(address(v2), "");
        vm.prank(owner);
        sites.upgradeToAndCall(address(v2), "");

        assertEq(MiningSitesV2(address(sites)).version(), 2);
        assertEq(
            abi.encode(
                sites.siteLevel(alice), sites.siteLevel(bob), sites.siteOf(alice), sites.claimed(alice),
                sites.settled(alice), sites.claimed(bob), sites.settled(bob), sites.walletPaidToday(alice),
                sites.paidToday(), sites.rates(), sites.upgradeCosts(), sites.walletDailyCap(), sites.dailyCap()
            ),
            before
        );
        assertEq(
            abi.encode(
                sites.signer(), sites.treasury(), sites.sitePrice(), sites.owner(), address(sites.vault()),
                address(sites.token()), sites.upgradeBurnBps(), sites.domainSeparator()
            ),
            before2
        );
        // The same proxy, the same vouchers: alice's backlog keeps converting.
        _nextDay();
        assertGt(_claim(alice, 5_000e18), 0);
        _upgrade(bob);
        assertEq(sites.siteLevel(bob), 2);
        // Still locked: no second initialize.
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        sites.initialize(IERC20(address(token)), vault, alice, alice, alice, PRICE, WALLET_CAP, DAILY_CAP);
    }

    function test_RenounceReverts() public {
        vm.prank(owner);
        vm.expectRevert(OwnedUUPS.CannotRenounce.selector);
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
        vm.prank(next);
        sites.setUpgradeCosts(_list(1e18, 2e18, 3e18, 4e18));
    }

    function test_OwnerOnly() public {
        address v2 = address(new MiningSitesV2());
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
        sites.setUpgradeCosts(_list(1, 1, 1, 1));
        vm.expectRevert(unauthorized);
        sites.setUpgradeBurnBps(0);
        vm.expectRevert(unauthorized);
        sites.setRates(_list5(5_000, 6_000, 7_000, 8_500, 10_000));
        vm.expectRevert(unauthorized);
        sites.addLevel(1, 10_000);
        vm.expectRevert(unauthorized);
        sites.upgradeToAndCall(v2, "");
        vm.expectRevert(unauthorized);
        sites.sweep(IERC20(address(token)), alice);
        vm.expectRevert(unauthorized);
        sites.transferOwnership(alice);
        vm.stopPrank();
    }
}

/// Audit 0792975e #2, the auditor's proof as submitted, with one change: in test_hijackerMintsFromTheVault the owner's
/// acceptDistributor() is now a low-level call, because the fix makes the vault refuse that uninitialised proxy (its
/// owner() isn't the vault's owner), which is the first place the attack stops.
///
/// A replacement distributor (a second MiningSites proxy for the same vault) can only be initialised once the vault
/// already names it distributor, and the vault only accepts a proposal for an address that already has code. So the
/// replacement must sit on chain uninitialised through the 2-day wait and the owner's acceptDistributor(); whoever
/// calls initialize() first after that owns it, picks its signer and treasury, and can have the vault mint to them.
contract DistributorRaceTest is Test {
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address attacker = makeAddr("attacker");
    uint256 attackerKey = 0xA11CE;

    MineToken token;
    MineVault vault;
    MiningSites impl;

    function setUp() public {
        token = new MineToken(address(this), address(0), 0);
        impl = new MiningSites();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        vault = new MineVault(token, owner, predicted);
        address sites = address(
            new ERC1967Proxy(
                address(impl),
                abi.encodeCall(
                    MiningSites.initialize,
                    (IERC20(address(token)), vault, owner, treasury, owner, 1, 1_500e18, 35_000e18)
                )
            )
        );
        assertEq(sites, predicted);
        token.setMinter(address(vault));
        token.renounceOwnership();
    }

    function test_replacementDistributorCannotBeHijacked() public {
        bytes memory init = abi.encodeCall(
            MiningSites.initialize, (IERC20(address(token)), vault, owner, treasury, owner, 1, 1_500e18, 35_000e18)
        );
        address replacement;
        // The way a fixed design would do it: propose the predicted address, then deploy the proxy initialised.
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.prank(owner);
        (bool proposed,) = address(vault).call(abi.encodeCall(MineVault.proposeDistributor, (predicted)));
        if (proposed) {
            replacement = address(new ERC1967Proxy(address(impl), init));
            assertEq(replacement, predicted);
        } else {
            // What the current code forces: an uninitialised proxy, proposed once it has code.
            replacement = address(new ERC1967Proxy(address(impl), ""));
            vm.prank(owner);
            vault.proposeDistributor(replacement);
        }
        vm.warp(block.timestamp + 2 days);
        vm.prank(owner);
        vault.acceptDistributor();
        assertEq(vault.distributor(), replacement);

        // Anyone may now try to initialise the replacement as its owner and signer. It must not work.
        vm.prank(attacker);
        (bool hijacked,) = replacement.call(
            abi.encodeCall(
                MiningSites.initialize,
                (IERC20(address(token)), vault, attacker, attacker, vm.addr(attackerKey), 1, 3_500e18, 35_000e18)
            )
        );
        assertFalse(hijacked, "a stranger initialised the replacement distributor");
        assertEq(MiningSites(replacement).owner(), owner, "the replacement distributor isn't the owner's");
    }

    /// The same race, followed through to the vault minting for the hijacker.
    function test_hijackerMintsFromTheVault() public {
        address replacement = address(new ERC1967Proxy(address(impl), ""));
        vm.prank(owner);
        vault.proposeDistributor(replacement);
        vm.warp(block.timestamp + 2 days);
        vm.prank(owner);
        (bool accepted,) = address(vault).call(abi.encodeCall(MineVault.acceptDistributor, ()));
        if (!accepted) return; // fixed: the vault refuses a distributor its owner doesn't own

        address signer = vm.addr(attackerKey);
        vm.prank(attacker);
        (bool hijacked,) = replacement.call(
            abi.encodeCall(
                MiningSites.initialize,
                (IERC20(address(token)), vault, attacker, attacker, signer, 1, 3_500e18, 35_000e18)
            )
        );
        if (!hijacked) return; // fixed: nothing to show

        MiningSites s = MiningSites(replacement);
        vm.deal(attacker, 1);
        vm.prank(attacker);
        s.openSite{value: 1}();
        bytes32 structHash = keccak256(
            abi.encode(s.EARNINGS_TYPEHASH(), attacker, uint256(1_000_000e18), uint64(block.timestamp + 1 hours))
        );
        (uint8 v, bytes32 r, bytes32 sg) =
            vm.sign(attackerKey, keccak256(abi.encodePacked("\x19\x01", s.domainSeparator(), structHash)));
        vm.prank(attacker);
        uint256 paid = s.claim(1_000_000e18, uint64(block.timestamp + 1 hours), abi.encodePacked(r, sg, v));
        assertEq(paid, 3_500e18);
        assertEq(token.balanceOf(attacker), 3_500e18);
        fail("the vault minted 3,500 $MINE to whoever initialised the replacement distributor");
    }

    /// Second re-check 52b534f9 #1: a proxy the owner proposed while it sat uninitialised can never be set up, by
    /// anyone: not a stranger naming the real vault, nor its owner, nor with a vault of its own; not the vault's owner
    /// either. The vault refuses it, and the owner proposes a proxy it deploys initialised instead.
    function test_aProxyLeftUninitialisedCanNeverBeSetUp() public {
        address replacement = address(new ERC1967Proxy(address(impl), ""));
        vm.prank(owner);
        vault.proposeDistributor(replacement);
        vm.prank(attacker);
        vm.expectRevert(OwnedUUPS.InitializeOutsideConstructor.selector);
        MiningSites(replacement)
            .initialize(IERC20(address(token)), vault, attacker, attacker, vm.addr(attackerKey), 1, 3_500e18, 35_000e18);
        vm.prank(attacker);
        vm.expectRevert(OwnedUUPS.InitializeOutsideConstructor.selector);
        MiningSites(replacement)
            .initialize(IERC20(address(token)), vault, owner, attacker, vm.addr(attackerKey), 1, 3_500e18, 35_000e18);
        MineVault own = new MineVault(token, attacker, replacement);
        vm.prank(attacker);
        vm.expectRevert(OwnedUUPS.InitializeOutsideConstructor.selector);
        MiningSites(replacement)
            .initialize(IERC20(address(token)), own, attacker, attacker, vm.addr(attackerKey), 1, 3_500e18, 35_000e18);
        vm.prank(owner);
        vm.expectRevert(OwnedUUPS.InitializeOutsideConstructor.selector);
        MiningSites(replacement).initialize(IERC20(address(token)), vault, owner, treasury, owner, 1, 1_500e18, 35_000e18);
        vm.warp(vm.getBlockTimestamp() + 2 days);
        vm.prank(owner);
        vm.expectRevert(MineVault.NotOwnersDistributor.selector);
        vault.acceptDistributor();
        assertTrue(vault.distributor() != replacement);
        assertEq(token.totalMinted(), 0);
    }

    /// The replacement procedure in MineVault's notes, end to end: propose the proxy's predicted address (nothing there
    /// yet), deploy the proxy with initialize in its constructor, wait two days, accept. It's never uninitialised, it
    /// sells and pays nothing while pending, and once accepted it pays and the old one is retired.
    function test_safeReplacementPath() public {
        address old = vault.distributor();
        MiningSites impl2 = new MiningSites();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        assertEq(predicted.code.length, 0);
        vm.prank(owner);
        vault.proposeDistributor(predicted);
        uint256 signerKey = 0x5160;
        MiningSites next = MiningSites(
            address(
                new ERC1967Proxy(
                    address(impl2),
                    abi.encodeCall(
                        MiningSites.initialize,
                        (IERC20(address(token)), vault, owner, treasury, vm.addr(signerKey), 1, 1_500e18, 35_000e18)
                    )
                )
            )
        );
        assertEq(address(next), predicted);
        assertEq(next.owner(), owner);
        assertEq(address(next.vault()), address(vault));
        assertEq(next.predecessor(), old);

        // Already set up: a stranger can't initialise it again.
        vm.prank(attacker);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        next.initialize(IERC20(address(token)), vault, attacker, attacker, vm.addr(attackerKey), 1, 3_500e18, 35_000e18);

        // While pending it sells and pays nothing.
        address player = makeAddr("player");
        vm.deal(player, 1);
        vm.prank(player);
        vm.expectRevert(MiningSites.NotActive.selector);
        next.openSite{value: 1}();
        uint64 deadline = uint64(vm.getBlockTimestamp() + 1 hours);
        bytes memory sig = _sign(next, signerKey, player, 1_000e18, deadline);
        vm.prank(player);
        vm.expectRevert(MiningSites.NotActive.selector);
        next.claim(1_000e18, deadline, sig);

        vm.warp(vm.getBlockTimestamp() + 2 days - 1);
        vm.prank(owner);
        vm.expectRevert(MineVault.TooEarly.selector);
        vault.acceptDistributor();
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(owner);
        vault.acceptDistributor();
        assertEq(vault.distributor(), address(next));

        vm.prank(player);
        next.openSite{value: 1}();
        deadline = uint64(vm.getBlockTimestamp() + 1 hours);
        sig = _sign(next, signerKey, player, 1_000e18, deadline);
        vm.prank(player);
        assertEq(next.claim(1_000e18, deadline, sig), 500e18); // half, at level 1
        assertEq(token.balanceOf(player), 500e18);
        vm.prank(old);
        vm.expectRevert(MineVault.NotDistributor.selector);
        vault.release(player, 1);
        vm.deal(player, 1);
        vm.prank(player);
        vm.expectRevert(MiningSites.NotActive.selector);
        MiningSites(old).openSite{value: 1}();
    }

    function _sign(MiningSites s, uint256 key, address player, uint256 total, uint64 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(s.EARNINGS_TYPEHASH(), player, total, deadline));
        (uint8 v, bytes32 r, bytes32 sg) =
            vm.sign(key, keccak256(abi.encodePacked("\x19\x01", s.domainSeparator(), structHash)));
        return abi.encodePacked(r, sg, v);
    }
}

/// Re-check 8c7ba957 #1, the auditor's proof as submitted. MineVault.acceptDistributor promised that "an uninitialised
/// proxy, or one a stranger initialised, is refused": it only checked `owner()`. A stranger who initialised the pending
/// proxy naming the vault's owner as owner, but itself as signer and treasury, passed that check. Now nobody but the
/// vault's owner can initialise a proxy outside its own constructor.
contract HijackNamesOwnerTest is Test {
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address attacker = makeAddr("attacker");
    uint256 attackerKey = 0xA77AC;

    MineToken token;
    MiningSites impl;
    MineVault vault;

    function setUp() public {
        token = new MineToken(address(this), address(0), 0);
        impl = new MiningSites();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        vault = new MineVault(token, owner, predicted);
        address sites = address(
            new ERC1967Proxy(
                address(impl),
                abi.encodeCall(
                    MiningSites.initialize,
                    (IERC20(address(token)), vault, owner, treasury, owner, 1, 1_500e18, 35_000e18)
                )
            )
        );
        assertEq(sites, predicted);
        token.setMinter(address(vault));
        token.renounceOwnership();
    }

    function test_HijackedProxyNamingTheOwnerIsAccepted() public {
        // The state the original finding and the fix's NatSpec describe: a replacement proxy on chain, uninitialised,
        // proposed by the owner.
        address replacement = address(new ERC1967Proxy(address(impl), ""));
        vm.prank(owner);
        vault.proposeDistributor(replacement);

        // A stranger initialises it during the wait: the vault's owner as owner (so acceptDistributor's check holds),
        // itself as treasury and signer, a 1 wei site, the caps at their maximum.
        address signer = vm.addr(attackerKey);
        vm.prank(attacker);
        (bool hijacked,) = replacement.call(
            abi.encodeCall(
                MiningSites.initialize,
                (IERC20(address(token)), vault, owner, attacker, signer, 1, 3_500e18, 35_000e18)
            )
        );

        vm.warp(vm.getBlockTimestamp() + 2 days);
        vm.prank(owner);
        (bool accepted,) = address(vault).call(abi.encodeCall(MineVault.acceptDistributor, ()));

        if (hijacked && accepted) {
            // Follow it through: the stranger signs its own voucher and the vault mints to it.
            MiningSites s = MiningSites(replacement);
            vm.deal(attacker, 1);
            vm.prank(attacker);
            s.openSite{value: 1}();
            uint64 deadline = uint64(vm.getBlockTimestamp() + 1 hours);
            bytes32 structHash = keccak256(abi.encode(s.EARNINGS_TYPEHASH(), attacker, uint256(1_000_000e18), deadline));
            (uint8 v, bytes32 r, bytes32 sg) =
                vm.sign(attackerKey, keccak256(abi.encodePacked("\x19\x01", s.domainSeparator(), structHash)));
            vm.prank(attacker);
            s.claim(1_000_000e18, deadline, abi.encodePacked(r, sg, v));
        }

        // What the fix claims: a proxy a stranger initialised is never accepted, and never mints.
        assertTrue(vault.distributor() != replacement, "the vault accepted a distributor a stranger set up");
        assertEq(token.balanceOf(attacker), 0, "the vault minted $MINE to the stranger");
    }
}

/// Re-check 8c7ba957 #3, the auditor's proof, with two changes for the fix's behaviour: alice's site carried over, so
/// opening it again on the replacement is a low-level call (it now reverts AlreadyOpen); and a claim that pays nothing
/// reverts NothingToClaim (as it always has) rather than returning 0, so the second claim is a low-level call too,
/// counted as 0 when it reverts with that error.
contract ReplacementResetsSettledTest is Test {
    uint256 constant KEY = 0xA11CE;
    address signer = vm.addr(KEY);
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    MineToken token;
    MineVault vault;
    MiningSites impl;

    function _proxy() internal returns (MiningSites) {
        return MiningSites(address(new ERC1967Proxy(address(impl), abi.encodeCall(
            MiningSites.initialize, (IERC20(address(token)), vault, owner, treasury, signer, 1, 1_500e18, 35_000e18)))));
    }

    function _sig(MiningSites s, uint256 total, uint64 dl) internal view returns (bytes memory) {
        bytes32 sh = keccak256(abi.encode(keccak256("Earnings(address player,uint256 total,uint64 deadline)"), alice, total, dl));
        bytes32 dom = keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("MineWorldCraft Mining"), keccak256("1"), block.chainid, address(s)));
        (uint8 v, bytes32 r, bytes32 x) = vm.sign(KEY, keccak256(abi.encodePacked("\x19\x01", dom, sh)));
        return abi.encodePacked(r, x, v);
    }

    function test_ReplacementPaysLifetimeEarningsAgain() public {
        vm.warp(20_000 days + 12 hours);
        token = new MineToken(address(this), address(0), 0);
        impl = new MiningSites();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        vault = new MineVault(token, owner, predicted);
        MiningSites oldSites = _proxy();
        token.setMinter(address(vault));
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        oldSites.openSite{value: 1}();
        // alice's lifetime earnings: 2,000; she converts them all on the old rules contract
        uint64 dl = uint64(vm.getBlockTimestamp() + 1 hours);
        vm.prank(alice);
        uint256 first = oldSites.claim(2_000e18, dl, _sig(oldSites, 2_000e18, dl));
        assertEq(oldSites.settled(alice), 2_000e18);

        // the documented replacement: propose the predicted address, deploy initialised, accept after 2 days
        address next = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.prank(owner);
        vault.proposeDistributor(next);
        MiningSites newSites = _proxy();
        vm.warp(vm.getBlockTimestamp() + 2 days);
        vm.prank(owner);
        vault.acceptDistributor();
        vm.prank(alice);
        (bool opened,) = address(newSites).call{value: 1}(abi.encodeCall(MiningSites.openSite, ()));
        opened; // (her site carried over: AlreadyOpen)

        // the server keeps signing her lifetime total (2,000, nothing new earned)
        dl = uint64(vm.getBlockTimestamp() + 1 hours);
        vm.prank(alice);
        (bool ok, bytes memory ret) =
            address(newSites).call(abi.encodeCall(MiningSites.claim, (2_000e18, dl, _sig(newSites, 2_000e18, dl))));
        if (!ok) assertEq(bytes4(ret), MiningSites.NothingToClaim.selector);
        uint256 again = ok ? abi.decode(ret, (uint256)) : 0;
        // expected: nothing to pay (already converted); actual: paid again
        assertEq(again, 0, "earnings already converted were paid a second time");
        assertEq(token.balanceOf(alice), first);
    }
}

/// Re-check 8c7ba957 #3 and #4: a replacement carries each player's site and books over from its predecessor (through
/// any chain of replacements), lazily, and the replaced one is retired: it sells and pays nothing.
contract ReplacementTest is Test {
    uint256 constant KEY = 0x5160;
    address signer = vm.addr(KEY);
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    MineToken token;
    MineVault vault;
    MiningSites impl;
    MiningSites first;

    function setUp() public {
        vm.warp(20_000 days + 12 hours);
        token = new MineToken(address(this), address(this), 1_000_000e18); // a stand-in pool to buy upgrades from
        impl = new MiningSites();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        vault = new MineVault(token, owner, predicted);
        first = _proxy();
        token.setMinter(address(vault));
        address[3] memory players = [alice, bob, carol];
        for (uint256 i; i < 3; i++) {
            vm.deal(players[i], 1 ether);
            token.transfer(players[i], 300_000e18);
        }
    }

    function _proxy() internal returns (MiningSites) {
        return MiningSites(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        MiningSites.initialize,
                        (IERC20(address(token)), vault, owner, treasury, signer, 1, 1_500e18, 35_000e18)
                    )
                )
            )
        );
    }

    /// MineVault's documented steps: propose the predicted address, deploy it initialised, accept two days later.
    function _replace() internal returns (MiningSites next) {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.prank(owner);
        vault.proposeDistributor(predicted);
        next = _proxy();
        vm.warp(vm.getBlockTimestamp() + 2 days);
        vm.prank(owner);
        vault.acceptDistributor();
    }

    function _voucher(MiningSites s, address who, uint256 total) internal view returns (uint64 dl, bytes memory sig) {
        dl = uint64(vm.getBlockTimestamp() + 1 hours);
        bytes32 sh = keccak256(abi.encode(s.EARNINGS_TYPEHASH(), who, total, dl));
        (uint8 v, bytes32 r, bytes32 x) = vm.sign(KEY, keccak256(abi.encodePacked("\x19\x01", s.domainSeparator(), sh)));
        sig = abi.encodePacked(r, x, v);
    }

    function _claim(MiningSites s, address who, uint256 total) internal returns (uint256) {
        (uint64 dl, bytes memory sig) = _voucher(s, who, total);
        vm.prank(who);
        return s.claim(total, dl, sig);
    }

    function _upgrade(MiningSites s, address who) internal {
        uint256 next = s.siteLevel(who) + 1;
        uint256 cost = s.upgradeCost(next);
        vm.startPrank(who);
        token.approve(address(s), cost);
        s.upgradeSite(cost, s.levelRateBps(next));
        vm.stopPrank();
    }

    /// Sites, levels, settled and claimed carry over: the views read through until the player acts, then the books
    /// are imported for good; lifetime vouchers pay only what's new; a player new to the replacement opens a site as
    /// usual; and a third contract reads through the second to the first.
    function test_TheBooksCarryOver() public {
        vm.prank(alice);
        first.openSite{value: 1}();
        _upgrade(first, alice);
        _upgrade(first, alice); // level 3: 70%
        assertEq(_claim(first, alice, 2_000e18), 1_400e18);
        vm.prank(carol);
        first.openSite{value: 1}();
        assertEq(_claim(first, carol, 1_000e18), 500e18);

        MiningSites second = _replace();
        assertEq(second.predecessor(), address(first));
        // Read through, before alice acts here.
        assertEq(second.siteLevel(alice), 3);
        assertTrue(second.hasSite(alice));
        assertEq(second.siteOf(alice), first.siteOf(alice));
        assertEq(second.rateBps(alice), 7_000);
        assertEq(second.settled(alice), 2_000e18);
        assertEq(second.claimed(alice), 1_400e18);
        assertEq(second.claimable(alice, 2_000e18), 0, "already converted");
        assertEq(second.claimable(alice, 2_500e18), 350e18);
        // Her first act imports them; the same lifetime total pays nothing, a higher one only what's new.
        vm.prank(alice);
        vm.expectRevert(MiningSites.AlreadyOpen.selector);
        second.openSite{value: 1}();
        (uint64 dl, bytes memory sig) = _voucher(second, alice, 2_500e18);
        vm.expectEmit(address(second));
        emit MiningSites.Imported(alice, 3, 2_000e18, 1_400e18);
        vm.prank(alice);
        assertEq(second.claim(2_500e18, dl, sig), 350e18);
        assertEq(second.settled(alice), 2_500e18);
        assertEq(second.claimed(alice), 1_750e18);
        _upgrade(second, alice); // level 4 on the replacement
        assertEq(second.siteLevel(alice), 4);
        // Bob never had a site: he opens one here as usual.
        assertFalse(second.hasSite(bob));
        vm.prank(bob);
        second.openSite{value: 1}();
        assertEq(second.siteLevel(bob), 1);

        // A third reads carol (who only ever used the first) through the second.
        MiningSites third = _replace();
        assertEq(third.predecessor(), address(second));
        assertEq(third.settled(carol), 1_000e18);
        assertEq(third.siteLevel(carol), 1);
        assertEq(third.siteLevel(alice), 4);
        assertEq(third.claimable(carol, 1_000e18), 0);
        assertEq(_claim(third, carol, 1_400e18), 200e18);
        vm.prank(carol);
        vm.expectRevert(MiningSites.NotActive.selector);
        first.openSite{value: 1}();
    }

    /// Like `_replace`, with `extra` levels added on the replacement (by its owner) before it's accepted.
    function _replaceWith(uint256 extra) internal returns (MiningSites next) {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.prank(owner);
        vault.proposeDistributor(predicted);
        next = _proxy();
        for (uint256 i; i < extra; i++) {
            vm.prank(owner);
            next.addLevel(1_000e18, 10_000);
        }
        vm.warp(vm.getBlockTimestamp() + 2 days);
        vm.prank(owner);
        vault.acceptDistributor();
    }

    /// alice at level 6 on a first contract whose top is 6 (the level bought with $MINE).
    function _aliceAtLevelSix() internal {
        vm.startPrank(owner);
        first.addLevel(1_000e18, 10_000); // level 6 on the first
        uint256[] memory cheap = new uint256[](5);
        for (uint256 i; i < 5; i++) {
            cheap[i] = 1e18;
        }
        first.setUpgradeCosts(cheap);
        vm.stopPrank();
        vm.prank(alice);
        first.openSite{value: 1}();
        for (uint256 i; i < 5; i++) {
            _upgrade(first, alice);
        }
        assertEq(first.siteLevel(alice), 6);
    }

    /// Second re-check 52b534f9 #3: a level bought above the replacement's top is kept as bought (it converts at the
    /// top level's rate meanwhile, and can't be raised past the top), and counts in full once the level is added.
    function test_ALevelAboveTheNewTopIsKept() public {
        _aliceAtLevelSix();
        MiningSites second = _replace();
        assertEq(second.maxLevel(), 5);
        assertEq(second.siteLevel(alice), 6);
        assertEq(second.rateBps(alice), 10_000, "the top level's rate");
        _claim(second, alice, 100e18); // imports
        assertEq(second.siteLevel(alice), 6);
        uint256 cost = second.upgradeCost(5);
        vm.startPrank(alice);
        token.approve(address(second), cost);
        vm.expectRevert(UpgradeCosts.MaxLevel.selector);
        second.upgradeSite(cost, 0);
        vm.stopPrank();
        // Once level 6 exists here (at 90%, say), alice converts at its rate and can buy level 7 when it's added.
        uint256[] memory r = new uint256[](5);
        (r[0], r[1], r[2], r[3], r[4]) = (5_000, 6_000, 7_000, 8_000, 8_500);
        vm.startPrank(owner);
        second.setRates(r);
        second.addLevel(1_000e18, 9_000);
        vm.stopPrank();
        assertEq(second.siteLevel(alice), 6);
        assertEq(second.rateBps(alice), 9_000);
        vm.prank(owner);
        second.addLevel(1_000e18, 9_500);
        _upgrade(second, alice);
        assertEq(second.siteLevel(alice), 7);
    }

    /// The auditor's scenario, asserting the fixed values: level 6 survives a hop through a contract whose top is 5,
    /// reads as 6 on a third whose top is 8, and stays 6 after the import and another addLevel (not to be bought
    /// again).
    function test_LevelPaidForIsKeptThroughAHopAndAfterAnImport() public {
        _aliceAtLevelSix();
        MiningSites second = _replace();
        assertEq(second.siteLevel(alice), 6);
        MiningSites third = _replaceWith(3);
        assertEq(third.maxLevel(), 8);
        assertEq(third.siteLevel(alice), 6, "lost through the middle hop");
        _claim(third, alice, 10e18);
        vm.prank(owner);
        third.addLevel(1_000e18, 10_000);
        assertEq(third.maxLevel(), 9);
        assertEq(third.siteLevel(alice), 6, "lost after the import");
        _upgrade(third, alice); // the next one she buys is 7
        assertEq(third.siteLevel(alice), 7);
    }

    /// Three hops: carol (only ever on the first, at level 6) reads 6 through two contracts whose top is 5.
    function test_ALevelSurvivesThreeHops() public {
        _aliceAtLevelSix();
        MiningSites second = _replace();
        MiningSites third = _replace();
        MiningSites fourth = _replaceWith(1);
        assertEq(second.maxLevel(), 5);
        assertEq(third.maxLevel(), 5);
        assertEq(fourth.maxLevel(), 6);
        assertEq(fourth.siteLevel(alice), 6);
        assertEq(fourth.rateBps(alice), 10_000);
        _claim(fourth, alice, 10e18);
        assertEq(fourth.siteLevel(alice), 6);
    }

    /// The per-day counters restart at a replacement (documented); the vault's 35,000 a day still holds across it.
    function test_PerDayCountersRestartButTheVaultsLimitHolds() public {
        vm.prank(alice);
        first.openSite{value: 1}();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.prank(owner);
        vault.proposeDistributor(predicted);
        MiningSites second = _proxy();
        vm.warp(vm.getBlockTimestamp() + 2 days);
        // The day of the switch: alice fills her 1,500 on the first, then the switch, then claims on the second.
        assertEq(_claim(first, alice, 3_000e18), 1_500e18);
        vm.prank(owner);
        vault.acceptDistributor();
        assertEq(second.walletPaidToday(alice), 0);
        assertEq(_claim(second, alice, 10_000e18), 1_500e18);
        assertEq(vault.releasedToday(), 3_000e18);
        assertLe(vault.releasedToday(), vault.DAILY_LIMIT());
    }

    /// Re-check 8c7ba957 #4: once replaced, the old contract sells no site or level and pays nothing, paused or not;
    /// a replacement does neither before it is accepted.
    function test_aRetiredDistributorSellsNothing() public {
        vm.prank(alice);
        first.openSite{value: 1}();
        _claim(first, alice, 2_000e18);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.prank(owner);
        vault.proposeDistributor(predicted);
        MiningSites second = _proxy();
        vm.prank(bob);
        vm.expectRevert(MiningSites.NotActive.selector);
        second.openSite{value: 1}(); // not accepted yet
        vm.warp(vm.getBlockTimestamp() + 2 days);
        vm.prank(owner);
        vault.acceptDistributor();
        vm.prank(owner);
        first.setPaused(true);

        uint256 cost = first.upgradeCost(2);
        uint256 before = token.balanceOf(alice);
        vm.startPrank(alice);
        token.approve(address(first), cost);
        vm.expectRevert(MiningSites.NotActive.selector);
        first.upgradeSite(cost, 0);
        vm.stopPrank();
        assertEq(token.balanceOf(alice), before, "nothing taken");
        assertEq(first.siteLevel(alice), 1);
        vm.prank(bob);
        vm.expectRevert(MiningSites.NotActive.selector);
        first.openSite{value: 1}();
        vm.prank(owner);
        first.setPaused(false);
        (uint64 dl, bytes memory sig) = _voucher(first, alice, 3_000e18);
        vm.prank(alice);
        vm.expectRevert(MiningSites.NotActive.selector);
        first.claim(3_000e18, dl, sig);
        assertEq(first.claimable(alice, 3_000e18), 0);
        // The replacement takes it from there.
        _upgrade(second, alice);
        assertEq(second.siteLevel(alice), 2);
    }

    /// A replacement must follow a distributor that answers `bookOf` (a MiningSites); anything else is refused.
    function test_APredecessorMustKeepBooks() public {
        MineToken other = new MineToken(address(this), address(0), 0);
        MineVault odd = new MineVault(other, owner, address(other)); // its distributor: a contract with no books
        ProxyMaker maker = new ProxyMaker();
        address predicted = vm.computeCreateAddress(address(maker), 1);
        vm.prank(owner);
        odd.proposeDistributor(predicted);
        vm.expectRevert(MiningSites.BadPredecessor.selector);
        maker.make(
            address(impl),
            abi.encodeCall(
                MiningSites.initialize, (IERC20(address(other)), odd, owner, treasury, signer, 1, 1_500e18, 35_000e18)
            )
        );
    }
}

/// Deploys a proxy from a fresh nonce, so its address is known before.
contract ProxyMaker {
    function make(address implementation, bytes calldata data) external returns (address) {
        return address(new ERC1967Proxy(implementation, data));
    }
}

/// Second re-check 52b534f9 #1, the auditor's proof as submitted.
/// A vault of the stranger's own making: it answers everything MiningSites.initialize asks of `vault_`.
contract FakeVault {
    address public owner;
    address public token;
    address public distributor;

    constructor(address owner_, address token_, address distributor_) {
        owner = owner_;
        token = token_;
        distributor = distributor_;
    }

    function pendingDistributor() external pure returns (address) {
        return address(0);
    }

    function DAILY_LIMIT() external pure returns (uint256) {
        return 35_000e18;
    }
}

/// The implementation the stranger upgrades the hijacked proxy to: it answers acceptDistributor's three reads with
/// the real vault's values and asks the real vault to mint.
contract EvilDistributor {
    address public immutable owner;
    address public immutable vault;
    address public immutable predecessor;

    constructor(address owner_, address vault_, address predecessor_) {
        owner = owner_;
        vault = vault_;
        predecessor = predecessor_;
    }

    function proxiableUUID() external pure returns (bytes32) {
        return 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    }

    function drain(address to, uint256 amount) external {
        MineVault(vault).release(to, amount);
    }
}

/// Re-check 8c7ba957 #1, the state its fix's NatSpec covers ("whatever state it is left in"): a replacement proxy on
/// chain, uninitialised, proposed by the owner, which the vault's owner means to initialise itself. The guard in
/// MiningSites.initialize compares msg.sender with the owner of the `vault_` the caller passes, so a stranger passes a
/// vault of its own and is let through; as the proxy's owner it then upgrades it to code that answers the vault's
/// three checks with the right values, and the vault accepts it and mints to the stranger.
contract FakeVaultHijackTest is Test {
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address attacker = makeAddr("attacker");

    MineToken token;
    MiningSites impl;
    MineVault vault;

    function setUp() public {
        token = new MineToken(address(this), address(0), 0);
        impl = new MiningSites();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        vault = new MineVault(token, owner, predicted);
        address sites = address(
            new ERC1967Proxy(
                address(impl),
                abi.encodeCall(
                    MiningSites.initialize,
                    (IERC20(address(token)), vault, owner, treasury, owner, 1, 1_500e18, 35_000e18)
                )
            )
        );
        assertEq(sites, predicted);
        token.setMinter(address(vault));
        token.renounceOwnership();
    }

    function test_StrangerInitialisesTheLateProxyWithItsOwnVault() public {
        // The owner deploys the replacement proxy uninitialised and proposes it, meaning to initialise it itself.
        address replacement = address(new ERC1967Proxy(address(impl), ""));
        vm.prank(owner);
        vault.proposeDistributor(replacement);

        // A stranger gets there first, with a vault of its own that names the stranger as owner.
        FakeVault fake = new FakeVault(attacker, address(token), replacement);
        vm.prank(attacker);
        (bool hijacked,) = replacement.call(
            abi.encodeCall(
                MiningSites.initialize,
                (IERC20(address(token)), MineVault(address(fake)), attacker, attacker, attacker, 1, 3_500e18, 35_000e18)
            )
        );

        if (hijacked) {
            // The stranger owns the proxy now: it upgrades it to code that answers the vault's checks correctly.
            EvilDistributor evil = new EvilDistributor(owner, address(vault), vault.distributor());
            vm.prank(attacker);
            UUPSUpgradeable(replacement).upgradeToAndCall(address(evil), "");

            // The owner's own initialise reverts, but its acceptDistributor two days later goes through.
            vm.warp(vm.getBlockTimestamp() + 2 days);
            vm.prank(owner);
            (bool accepted,) = address(vault).call(abi.encodeCall(MineVault.acceptDistributor, ()));
            if (accepted) {
                vm.prank(attacker);
                EvilDistributor(replacement).drain(attacker, 35_000e18);
            }
        }

        // What the fix claims: nobody but the vault's owner sets a proxy up, so one a stranger set up is never
        // accepted and never mints.
        assertEq(token.balanceOf(attacker), 0, "the vault minted $MINE to the stranger");
        assertTrue(vault.distributor() != replacement, "the vault accepted a distributor a stranger set up");
        assertFalse(hijacked, "a stranger initialised the late proxy by passing a vault of its own");
    }
}

/// Second re-check 52b534f9 #1, the economics specialist's variant (written from the report's description): the
/// stranger needs no fake at all, just a real MineVault of its own naming the late proxy its distributor.
contract StrangerInitializesWithOwnVaultTest is Test {
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address attacker = makeAddr("attacker");

    MineToken token;
    MiningSites impl;
    MineVault vault;

    function setUp() public {
        token = new MineToken(address(this), address(0), 0);
        impl = new MiningSites();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        vault = new MineVault(token, owner, predicted);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(MiningSites.initialize, (IERC20(address(token)), vault, owner, treasury, owner, 1, 1_500e18, 35_000e18))
        );
        token.setMinter(address(vault));
        token.renounceOwnership();
    }

    function test_StrangerInitializesTheProposedProxyWithItsOwnVault() public {
        address replacement = address(new ERC1967Proxy(address(impl), ""));
        vm.prank(owner);
        vault.proposeDistributor(replacement);
        // The stranger's own vault (for the same token; it never minted anything) names the proxy its distributor.
        vm.prank(attacker);
        MineVault own = new MineVault(token, attacker, replacement);
        vm.prank(attacker);
        (bool initialised,) = replacement.call(
            abi.encodeCall(MiningSites.initialize, (IERC20(address(token)), own, attacker, attacker, attacker, 1, 3_500e18, 35_000e18))
        );
        assertFalse(initialised, "a stranger initialised the proxy the owner proposed");
        assertEq(MiningSites(replacement).owner(), address(0));
    }
}

/// Third re-check 10d532d5 #1, the auditor's proof as submitted (moved into this file; imports above): a vault whose
/// distributor of the moment has no code (a predicted address nothing was deployed at) can still be given a working
/// distributor.
contract CodelessDistributorProofTest is Test {
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");

    /// A vault whose distributor of the moment has no code must still be replaceable by its owner (AUDIT.md section 4,
    /// guarantee 6: "a distributor can always be replaced").
    function test_AVaultWithACodelessDistributorCanStillBeReplaced() public {
        MineToken token = new MineToken(address(this), address(0), 0);
        MiningSites impl = new MiningSites();
        address never = makeAddr("neverDeployed");
        MineVault vault = new MineVault(token, owner, never);
        token.setMinter(address(vault));
        token.renounceOwnership();

        address next = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.prank(owner);
        vault.proposeDistributor(next);
        MiningSites replacement = MiningSites(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        MiningSites.initialize,
                        (IERC20(address(token)), vault, owner, treasury, owner, 1, 1_500e18, 35_000e18)
                    )
                )
            )
        );
        assertEq(address(replacement), next);
        vm.warp(block.timestamp + 2 days);
        vm.prank(owner);
        vault.acceptDistributor();
        assertEq(vault.distributor(), next, "the vault never got a working distributor");
    }
}

/// Third re-check 10d532d5 #1, end to end: the replacement records the codeless distributor as its predecessor
/// without calling it, reads its books as empty, and then sells sites and pays claims; a predecessor with code that
/// doesn't keep books is still refused.
contract CodelessPredecessorTest is Test {
    uint256 constant SIGNER_KEY = 0xC0DE;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address never = makeAddr("neverDeployed");

    MineToken token;
    MiningSites impl;
    MineVault vault;

    function setUp() public {
        vm.warp(20_000 days + 12 hours);
        token = new MineToken(address(this), address(0), 0);
        impl = new MiningSites();
        vault = new MineVault(token, owner, never);
        token.setMinter(address(vault));
        token.renounceOwnership();
    }

    function _replacement() internal returns (MiningSites) {
        address next = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.prank(owner);
        vault.proposeDistributor(next);
        return MiningSites(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        MiningSites.initialize,
                        (IERC20(address(token)), vault, owner, treasury, vm.addr(SIGNER_KEY), 1, 1_500e18, 35_000e18)
                    )
                )
            )
        );
    }

    function test_ACodelessPredecessorHasEmptyBooks() public {
        MiningSites sites = _replacement();
        assertEq(sites.predecessor(), never);
        (uint64 openedAt, uint256 level, uint256 settledTotal, uint256 claimedTotal) = sites.bookOf(alice);
        assertEq(openedAt, 0);
        assertEq(level, 0);
        assertEq(settledTotal, 0);
        assertEq(claimedTotal, 0);
        vm.warp(vm.getBlockTimestamp() + 2 days);
        vm.prank(owner);
        vault.acceptDistributor();

        vm.deal(alice, 1);
        vm.prank(alice);
        sites.openSite{value: 1}();
        assertEq(sites.siteLevel(alice), 1);
        uint64 deadline = uint64(vm.getBlockTimestamp() + 1 hours);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                sites.domainSeparator(),
                keccak256(abi.encode(keccak256("Earnings(address player,uint256 total,uint64 deadline)"), alice, 100e18, deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(SIGNER_KEY, digest);
        vm.prank(alice);
        sites.claim(100e18, deadline, abi.encodePacked(r, sg, v));
        assertEq(token.balanceOf(alice), 50e18, "level 1 converts half");
        assertEq(sites.settled(alice), 100e18);
    }

    function test_APredecessorWithCodeMustStillKeepBooks() public {
        // The vault named an address that turned out to hold some other contract (here one that reverts every call):
        // it must answer bookOf, as before.
        vm.etch(never, hex"60006000fd");
        address next = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.prank(owner);
        vault.proposeDistributor(next);
        vm.expectRevert(MiningSites.BadPredecessor.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                MiningSites.initialize,
                (IERC20(address(token)), vault, owner, treasury, vm.addr(SIGNER_KEY), 1, 1_500e18, 35_000e18)
            )
        );
    }
}

/// Third re-check 10d532d5 #2, the auditor's proof as submitted (moved into this file): CrafterLevels' and
/// MinePayments' proxies, like MiningSites', are set up only in their own constructor (OwnedUUPS.__Owned_init).
contract LateInitProofTest is Test {
    address stranger = makeAddr("stranger");

    /// CrafterLevels' and MinePayments' proxies, like MiningSites', must not be anyone's to set up after deployment.
    function test_StrangerCannotInitialiseLateLevelsOrPaymentsProxies() public {
        MineToken token = new MineToken(address(this), address(0), 0);
        address levels = address(new ERC1967Proxy(address(new CrafterLevels()), ""));
        address payments = address(new ERC1967Proxy(address(new MinePayments()), ""));

        vm.startPrank(stranger);
        (bool okLevels,) = levels.call(
            abi.encodeCall(CrafterLevels.initialize, (IERC20(address(token)), IERC721(address(token)), stranger, stranger))
        );
        (bool okPayments,) =
            payments.call(abi.encodeCall(MinePayments.initialize, (IERC20(address(token)), stranger, stranger)));
        vm.stopPrank();
        assertFalse(okLevels, "a stranger initialised a CrafterLevels proxy deployed uninitialised");
        assertFalse(okPayments, "a stranger initialised a MinePayments proxy deployed uninitialised");
        assertEq(CrafterLevels(levels).owner(), address(0));
        assertEq(MinePayments(payments).owner(), address(0));
    }

    /// And the reason is the shared guard, for the owner too: neither can be set up late by anyone.
    function test_TheGuardIsSharedByEveryProxyOfTheFamily() public {
        MineToken token = new MineToken(address(this), address(0), 0);
        address levels = address(new ERC1967Proxy(address(new CrafterLevels()), ""));
        address payments = address(new ERC1967Proxy(address(new MinePayments()), ""));
        vm.expectRevert(OwnedUUPS.InitializeOutsideConstructor.selector);
        CrafterLevels(levels).initialize(IERC20(address(token)), IERC721(address(token)), address(this), address(this));
        vm.expectRevert(OwnedUUPS.InitializeOutsideConstructor.selector);
        MinePayments(payments).initialize(IERC20(address(token)), address(this), address(this));
    }
}
