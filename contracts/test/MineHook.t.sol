// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MineHook} from "../src/MineHook.sol";
import {MineRouter, PermitHelper} from "../src/MineRouter.sol";
import {MineEthRouter} from "../src/MineEthRouter.sol";
import {MineToken} from "../src/MineToken.sol";
import {MiningSites} from "../src/MiningSites.sol";
import {DeployLib} from "../script/DeployLib.sol";
import {MineDeployer} from "../script/Deploy.s.sol";

contract MockIMD {
    string public name = "Identity.md";
    string public symbol = "IMD";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function approve(address s, uint256 amt) external returns (bool) {
        allowance[msg.sender][s] = amt;
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address f, address to, uint256 amt) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= amt;
        balanceOf[f] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

/// A token of any launch size, for the start-price bounds test (MineToken always launches 10.5M).
contract LaunchCoin is ERC20 {
    uint256 public constant MAX_SUPPLY = 21_000_000e18;

    constructor(address to, uint256 amount) ERC20("Launch", "LNCH") {
        _mint(to, amount);
    }
}

/// @dev Adapted from Courier World's StampHook tests. Runs twice (see the two contracts at the end): with IMD as the
///      pool's currency0 and as its currency1, since the order on mainnet depends on the $MINE address and every code
///      path has a branch for each. The vault half goes to a real MiningSites, as on mainnet.
abstract contract MineHookTest is Test, MineDeployer {
    using StateLibrary for IPoolManager;

    PoolManager pm;
    MockIMD imd;
    MineHook hook;
    MineToken stamp; // (named as in the StampHook tests, so the two diff cleanly)
    MiningSites sites;
    MineRouter router;
    MineEthRouter ethRouter;
    PoolSwapTest extRouter;
    PoolModifyLiquidityTest lp;

    address owner = makeAddr("owner");
    address feeRecipient = makeAddr("feeRecipient");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant LAUNCH = 10_500_000e18; // half the 21M supply
    uint256 constant TOTAL = 21_000_000e18;
    uint256 constant START_MCAP = 50_000e18; // IMD, for the full 21M
    uint256 constant SIGNER_KEY = 0x51634;
    int24 constant FULL_100 = 887_200;

    /// @dev Where the mock IMD lives: a low address makes it currency0, a high one currency1.
    function _imdAddress() internal pure virtual returns (address);

    function setUp() public {
        vm.warp(1_800_000_000);
        pm = new PoolManager(address(this));
        vm.etch(_imdAddress(), address(new MockIMD()).code);
        imd = MockIMD(_imdAddress());
        extRouter = new PoolSwapTest(pm);
        lp = new PoolModifyLiquidityTest(pm);
        vm.deal(address(this), 1_000_000 ether);
        imd.mint(address(this), 10_000_000e18);
        imd.approve(address(lp), type(uint256).max);

        // IMD/ETH at 1:1 for the ETH router.
        PoolKey memory imdEth = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(imd)), 10_000, 100, IHooks(address(0)));
        pm.initialize(imdEth, TickMath.getSqrtPriceAtTick(0));
        lp.modifyLiquidity{value: 20_000 ether}(imdEth, ModifyLiquidityParams(-FULL_100, FULL_100, 10_000e18, 0), "");

        // The hook lives at a mined address carrying its permission flags.
        hook = MineHook(_hookWith(feeRecipient, DeployLib.startTickForMarketCap(START_MCAP, TOTAL), LAUNCH));
        router = MineRouter(hook.router());
        ethRouter = MineEthRouter(payable(hook.ethRouter()));

        (stamp, sites) = _tokenFor(address(hook));
        vm.prank(owner);
        hook.openPool(address(stamp));
        assertEq(_imdIs0(), uint160(address(imd)) < uint160(address(stamp)), "ordering");

        for (uint256 i; i < 2; i++) {
            address u = i == 0 ? alice : bob;
            imd.mint(u, 100_000e18);
            vm.deal(u, 100 ether);
            vm.startPrank(u);
            imd.approve(address(router), type(uint256).max);
            imd.approve(address(extRouter), type(uint256).max);
            stamp.approve(address(router), type(uint256).max);
            stamp.approve(address(ethRouter), type(uint256).max);
            stamp.approve(address(extRouter), type(uint256).max);
            vm.stopPrank();
        }
    }

    receive() external payable {}

    /// @dev $MINE and the game as the deploy script makes them: the launch allocation to `pool`, the vault the one
    ///      minter, the token renounced.
    function _tokenFor(address pool) internal returns (MineToken t, MiningSites s) {
        Game memory g = _deployGame(
            address(this), owner, pool, Sites(feeRecipient, vm.addr(SIGNER_KEY), 0.005 ether, 1_500e18, 35_000e18)
        );
        return (MineToken(g.token), MiningSites(g.sites));
    }

    function _flags() internal pure returns (uint160) {
        return uint160(0x28CC); // beforeInitialize, beforeAddLiquidity, before/afterSwap, both return deltas
    }

    /// @dev A hook at a mined address. Different arguments give it a different address.
    function _hookWith(address feeTo, int24 startTick, uint256 launch) internal returns (address h) {
        bytes memory initCode = abi.encodePacked(
            type(MineHook).creationCode,
            abi.encode(pm, address(imd), owner, feeTo, startTick, launch, MineHook.ImdEthPool(10_000, 100, address(0)))
        );
        (bytes32 salt, address expected) = DeployLib.mineSalt(address(this), _flags(), initCode, 0);
        assembly {
            h := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }
        require(h == expected, "hook address");
    }

    function _key() internal view returns (PoolKey memory) {
        return hook.poolKey(address(stamp));
    }

    function _imdIs0() internal view returns (bool) {
        return Currency.unwrap(_key().currency0) == address(imd);
    }

    function _extSwap(address who, bool buy, int256 amountSpecified) internal {
        bool zeroForOne = buy == _imdIs0();
        _extSwapWithLimit(who, buy, amountSpecified, zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
    }

    function _extSwapWithLimit(address who, bool buy, int256 amountSpecified, uint160 limit) internal {
        bool zeroForOne = buy == _imdIs0();
        PoolKey memory key = _key();
        vm.prank(who, who);
        extRouter.swap(
            key,
            SwapParams(zeroForOne, amountSpecified, limit),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _fees() internal view returns (uint256) {
        return hook.pendingProtocolFees(address(imd));
    }

    /// @dev `fee` is 4% of `gross` rounded up: never less, at most 1 wei more.
    function _assertFourPercentUp(uint256 fee, uint256 gross, string memory mode) internal pure {
        assertGe(fee * 10_000, gross * 400, mode);
        assertLt((fee - 1) * 10_000, gross * 400, mode);
    }

    // ------------------------------------------------------------------ launch

    function test_LaunchLocksTheAllocation() public view {
        assertEq(stamp.balanceOf(address(hook)), 0);
        // Everything went into the pool except a rounding buffer (< 1.1e9 wei), which was burned.
        address dead = 0x000000000000000000000000000000000000dEaD;
        assertEq(stamp.balanceOf(address(pm)) + stamp.balanceOf(dead), LAUNCH);
        assertLt(stamp.balanceOf(dead), 1.1e9);
        assertEq(stamp.totalSupply(), LAUNCH, "the rest is minted only as players earn it");
        assertEq(stamp.MAX_SUPPLY(), TOTAL);
        assertEq(stamp.owner(), address(0));
        assertEq(hook.token(), address(stamp));
    }

    function test_TokenNameAndSymbol() public view {
        assertEq(stamp.name(), "MineWorldCraft");
        assertEq(stamp.symbol(), "MINE");
        (, string memory domainName,,,,,) = stamp.eip712Domain();
        assertEq(domainName, "MineWorldCraft"); // permit signatures are made for this name
    }

    function test_OpenPoolOnlyOnceAndOnlyOwner() public {
        vm.expectRevert(MineHook.NotOwner.selector);
        hook.openPool(address(stamp));
        vm.prank(owner);
        vm.expectRevert(MineHook.AlreadyLaunched.selector);
        hook.openPool(address(stamp));
    }

    function test_DonationBeforeLaunchCannotBlockOpenPool() public {
        address h = _hookWith(alice, DeployLib.startTickForMarketCap(START_MCAP, TOTAL), LAUNCH);
        (MineToken s2,) = _tokenFor(h);
        deal(address(s2), alice, 1);
        vm.prank(alice);
        s2.transfer(h, 1); // someone sends 1 wei to the hook before the launch

        vm.prank(owner);
        MineHook(h).openPool(address(s2));
        address dead = 0x000000000000000000000000000000000000dEaD;
        assertEq(s2.balanceOf(h), 0);
        assertEq(s2.balanceOf(address(pm)) + s2.balanceOf(dead), LAUNCH + 1);
    }

    /// Audit ea514609 finding 11 and re-check ca28d248 finding 1 (StampHook): every start price and allocation
    /// the constructor accepts opens. MineHook's tick bounds are CourierPad's (-300,000 to 400,000), and the
    /// allocation goes up to $MINE's whole 21M supply.
    /// @dev External, so `vm.expectRevert` checks this constructor call. (A `new` straight in the test body reverts
    ///      the test itself, which forge counts as the expected revert, so nothing after it would run.)
    function newHook(int24 tick, uint256 launch) external returns (address) {
        return address(new MineHook(pm, address(imd), owner, feeRecipient, tick, launch, MineHook.ImdEthPool(10_000, 100, address(0))));
    }

    function test_StartPriceIsBoundedSoOpenPoolAlwaysWorks() public {
        vm.expectRevert(MineHook.BadTick.selector);
        this.newHook(400_200, LAUNCH);
        vm.expectRevert(MineHook.BadTick.selector);
        this.newHook(-300_200, LAUNCH);
        vm.expectRevert(MineHook.BadTick.selector);
        this.newHook(100, LAUNCH); // off the tick spacing
        vm.expectRevert(MineHook.BadToken.selector);
        this.newHook(0, TOTAL + 1);
        vm.expectRevert(MineHook.BadToken.selector);
        this.newHook(400_000, 1e18 - 1); // a few wei: no liquidity

        // The extreme start prices, with the smallest, the planned and the largest allocation, all open.
        int24[2] memory ticks = [int24(-300_000), int24(400_000)];
        uint256[3] memory launches = [uint256(1e18), LAUNCH, TOTAL];
        for (uint256 i; i < 2; i++) {
            for (uint256 j; j < 3; j++) {
                address h = _hookWith(makeAddr(string(abi.encode(i, j))), ticks[i], launches[j]);
                LaunchCoin s = new LaunchCoin(h, launches[j]);
                vm.prank(owner);
                MineHook(h).openPool(address(s));
                assertEq(s.balanceOf(h), 0);
            }
        }
    }

    function test_NobodyCanAddLiquidityOrReuseTheHook() public {
        PoolKey memory k = _key();
        vm.expectRevert();
        lp.modifyLiquidity(k, ModifyLiquidityParams(-200, 200, 1e18, 0), "");
        PoolKey memory other = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(stamp)), 0, 200, IHooks(address(hook)));
        vm.expectRevert();
        pm.initialize(other, TickMath.getSqrtPriceAtTick(0));
    }

    // ------------------------------------------------------------------ the 4% tax

    function test_BuyPaysFourPercentToProtocol() public {
        vm.prank(alice);
        uint256 out = router.buy(address(stamp), 1_000e18, 1, block.timestamp);
        assertGt(out, 0);
        assertEq(stamp.balanceOf(alice), out);
        assertEq(_fees(), 40e18);
    }

    function test_SellPaysFourPercentOfTheOutput() public {
        vm.startPrank(alice);
        uint256 got = router.buy(address(stamp), 10_000e18, 1, block.timestamp);
        uint256 feesAfterBuy = _fees();
        uint256 imdBefore = imd.balanceOf(alice);
        router.sell(address(stamp), got / 2, 1, block.timestamp);
        vm.stopPrank();
        uint256 received = imd.balanceOf(alice) - imdBefore;
        _assertFourPercentUp(_fees() - feesAfterBuy, received + _fees() - feesAfterBuy, "router sell");
    }

    /// Exact fees in all four modes through a generic v4 router (audit ea514609 findings 6 and 12).
    function test_EveryModePaysExactlyFourPercentRoundedUp() public {
        // Exact-in buy: 4% of what the buyer pays.
        uint256 before = _fees();
        uint256 imdBefore = imd.balanceOf(alice);
        _extSwap(alice, true, -1_000e18);
        assertEq(imdBefore - imd.balanceOf(alice), 1_000e18);
        assertEq(_fees() - before, 40e18, "exact-in buy");

        // Exact-out buy (1,000 $MINE): 4% of what the buyer pays in total.
        before = _fees();
        imdBefore = imd.balanceOf(alice);
        _extSwap(alice, true, 1_000e18);
        _assertFourPercentUp(_fees() - before, imdBefore - imd.balanceOf(alice), "exact-out buy");

        // Exact-in sell (500 $MINE): 4% of the gross the pool pays.
        before = _fees();
        imdBefore = imd.balanceOf(alice);
        _extSwap(alice, false, -500e18);
        uint256 fee = _fees() - before;
        _assertFourPercentUp(fee, imd.balanceOf(alice) - imdBefore + fee, "exact-in sell");

        // Exact-out sell (1 IMD to the seller).
        before = _fees();
        imdBefore = imd.balanceOf(alice);
        _extSwap(alice, false, 1e18);
        assertEq(imd.balanceOf(alice) - imdBefore, 1e18);
        _assertFourPercentUp(_fees() - before, 1e18 + _fees() - before, "exact-out sell");
    }

    function test_DustSwapsStillPayTheFee() public {
        uint256 before = _fees();
        _extSwap(alice, true, -24); // 4% of 24 wei is 0.96 wei: rounds up to 1
        assertEq(_fees() - before, 1);
    }

    function test_PartialFillIsRejected() public {
        // An exact-in buy that would stop at a price limit after filling part of it.
        PoolKey memory key = _key();
        (uint160 sqrtP,,,) = IPoolManager(address(pm)).getSlot0(key.toId());
        bool zeroForOne = _imdIs0(); // a buy pays IMD in
        uint160 limit = zeroForOne ? sqrtP - sqrtP / 1000 : sqrtP + sqrtP / 1000;
        PoolSwapTest.TestSettings memory settings = PoolSwapTest.TestSettings(false, false);
        vm.prank(alice, alice);
        vm.expectRevert();
        extRouter.swap(key, SwapParams(zeroForOne, -10_000e18, limit), settings, "");

        // Without the limit the same buy fills completely.
        _extSwap(alice, true, -10_000e18);
    }

    function test_EthRouterBuysAndSellsThroughImd() public {
        vm.startPrank(alice);
        uint256 got = ethRouter.buyWithEth{value: 1 ether}(address(stamp), 1, block.timestamp);
        assertGt(got, 0);
        uint256 fee = _fees();
        assertGt(fee, 0);
        uint256 ethBefore = alice.balance;
        uint256 ethOut = ethRouter.sellForEth(address(stamp), got / 2, 1, block.timestamp);
        vm.stopPrank();
        assertEq(alice.balance - ethBefore, ethOut);
        assertGt(_fees(), fee);
    }

    function test_FeesGoToTheProtocolAddress() public {
        vm.prank(alice);
        router.buy(address(stamp), 5_000e18, 1, block.timestamp);
        hook.collectProtocolFees(address(imd));
        assertEq(imd.balanceOf(feeRecipient), 200e18);
        assertEq(_fees(), 0);
    }

    /// Collection also works while someone else holds the PoolManager's unlock (the hook settles its own deltas).
    function test_CollectInsideAnotherCallersUnlock() public {
        vm.prank(alice);
        router.buy(address(stamp), 1_000e18, 1, block.timestamp);
        pm.unlock("");
        assertEq(imd.balanceOf(feeRecipient), 40e18);
        assertEq(_fees(), 0);
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        hook.collectProtocolFees(address(imd));
        return "";
    }

    function test_SlippageAndDeadline() public {
        vm.startPrank(alice);
        vm.expectRevert(MineRouter.Slippage.selector);
        router.buy(address(stamp), 1e18, type(uint256).max, block.timestamp);
        vm.expectRevert(MineRouter.Expired.selector);
        router.buy(address(stamp), 1e18, 1, block.timestamp - 1);
        vm.stopPrank();
    }

    /// The MINE-only launch: the pool holds no IMD until someone buys, so an early sell can't fill.
    function test_SellsBeforeAnyBuyCannotFill() public {
        deal(address(stamp), bob, 100e18);
        vm.prank(bob);
        vm.expectRevert();
        router.sell(address(stamp), 100e18, 1, block.timestamp);

        // After a buy brings IMD in, the same sell goes through.
        vm.prank(alice);
        router.buy(address(stamp), 1_000e18, 1, block.timestamp);
        vm.prank(bob);
        assertGt(router.sell(address(stamp), 100e18, 1, block.timestamp), 0);
    }

    /// Audit ea514609 finding 3: a sell bigger than the pool's IMD stops at the launch price, and the price view
    /// never reads 0, even after another router walks the price to the end of the range.
    function test_PriceSurvivesSellsPastTheLaunchPrice() public {
        uint256 p0 = hook.price(address(stamp));
        vm.prank(alice);
        router.buy(address(stamp), 1e18, 1, block.timestamp);
        uint256 big = stamp.balanceOf(alice) * 10;
        deal(address(stamp), alice, big);

        vm.prank(alice);
        uint256 got = router.sell(address(stamp), big, 1, block.timestamp);
        assertGt(got, 0);
        assertGt(stamp.balanceOf(alice), 0, "only what the pool could pay for was sold");
        assertEq(hook.price(address(stamp)), p0);
        (uint160 sqrtP,,,) = IPoolManager(address(pm)).getSlot0(_key().toId());
        assertEq(sqrtP, hook.launchSqrtPrice(address(stamp)), "stopped at the launch price");

        vm.prank(alice);
        router.buy(address(stamp), 1e18, 1, block.timestamp);
        _extSwap(alice, false, -int256(stamp.balanceOf(alice)));
        assertEq(hook.price(address(stamp)), p0);
        assertGt(hook.marketCap(address(stamp)), 0);

        // And the pool still trades normally from there.
        vm.prank(bob);
        assertGt(router.buy(address(stamp), 1e18, 1, block.timestamp), 0);
    }

    // ------------------------------------------------------------------ permit sells

    function _permit(uint256 key, address holder, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                holder,
                spender,
                value,
                stamp.nonces(holder),
                deadline
            )
        );
        (v, r, s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", stamp.DOMAIN_SEPARATOR(), structHash)));
    }

    function test_SellsWithPermitNeedNoApproval() public {
        (address carol, uint256 carolKey) = makeAddrAndKey("carol");
        vm.prank(alice);
        uint256 got = router.buy(address(stamp), 10_000e18, 1, block.timestamp);
        vm.prank(alice);
        stamp.transfer(carol, got);

        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(carolKey, carol, address(router), got / 2, deadline);
        vm.prank(carol);
        assertGt(router.sellWithPermit(address(stamp), got / 2, 1, deadline, v, r, s), 0);

        uint256 rest = stamp.balanceOf(carol);
        (v, r, s) = _permit(carolKey, carol, address(ethRouter), rest, deadline);
        vm.prank(carol);
        assertGt(ethRouter.sellForEthWithPermit(address(stamp), rest, 1, deadline, v, r, s), 0);
        assertEq(stamp.balanceOf(carol), 0);
    }

    /// Audit ea514609 finding 5: the permit must be signed for exactly the amount sold (as documented).
    function test_PermitMustMatchTheAmountSold() public {
        (address carol, uint256 carolKey) = makeAddrAndKey("carol");
        vm.prank(alice);
        uint256 got = router.buy(address(stamp), 10_000e18, 1, block.timestamp);
        vm.prank(alice);
        stamp.transfer(carol, got);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(carolKey, carol, address(router), got, deadline);
        vm.prank(carol);
        vm.expectRevert(PermitHelper.PermitFailed.selector);
        router.sellWithPermit(address(stamp), got / 2, 1, deadline, v, r, s);
    }

    // ------------------------------------------------------------------ admin

    function test_FeeRecipientAndOwnership() public {
        vm.expectRevert(MineHook.NotOwner.selector);
        hook.setFeeRecipient(bob);
        vm.prank(owner);
        hook.setFeeRecipient(bob);
        assertEq(hook.feeRecipient(), bob);

        vm.prank(owner);
        hook.transferOwnership(alice);
        assertEq(hook.owner(), owner);
        vm.prank(alice);
        hook.acceptOwnership();
        assertEq(hook.owner(), alice);
    }

    function test_RenounceEndsTheOwnersPowers() public {
        vm.expectRevert(MineHook.NotOwner.selector);
        hook.renounceOwnership();
        vm.prank(owner);
        hook.renounceOwnership();
        assertEq(hook.owner(), address(0));

        vm.startPrank(owner);
        vm.expectRevert(MineHook.NotOwner.selector);
        hook.setFeeRecipient(bob);
        vm.expectRevert(MineHook.NotOwner.selector);
        hook.transferOwnership(bob);
        vm.stopPrank();
        assertEq(hook.feeRecipient(), feeRecipient);

        // Fees keep flowing to the same address.
        _extSwap(alice, true, -1_000e18);
        hook.collectProtocolFees(address(imd));
        assertEq(imd.balanceOf(feeRecipient), 40e18);
    }

    /// Final check 19b34b9b finding 3: after the renounce, only the fee recipient can move its own fees (say, if
    /// IMD's issuer blocks its address); nobody else can redirect them.
    function test_FeeRecipientCanMoveItsOwnFees() public {
        vm.prank(owner);
        hook.renounceOwnership();
        address next = makeAddr("next");
        vm.prank(owner);
        vm.expectRevert(MineHook.NotOwner.selector);
        hook.setFeeRecipient(owner);
        vm.prank(alice);
        vm.expectRevert(MineHook.NotOwner.selector);
        hook.setFeeRecipient(alice);

        vm.prank(feeRecipient);
        hook.setFeeRecipient(next);
        assertEq(hook.feeRecipient(), next);
        _extSwap(alice, true, -1_000e18);
        hook.collectProtocolFees(address(imd));
        assertEq(imd.balanceOf(next), 40e18);

        // The old recipient has no say any more.
        vm.prank(feeRecipient);
        vm.expectRevert(MineHook.NotOwner.selector);
        hook.setFeeRecipient(feeRecipient);
    }

    function test_CannotRenounceBeforeTheLaunch() public {
        MineHook h = MineHook(_hookWith(bob, DeployLib.startTickForMarketCap(START_MCAP, TOTAL), LAUNCH));
        vm.prank(owner);
        vm.expectRevert(MineHook.NotLaunched.selector);
        h.renounceOwnership();
    }

    // ------------------------------------------------------------------ with the game

    function _voucher(address player, uint256 total, uint64 deadline) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(sites.EARNINGS_TYPEHASH(), player, total, deadline));
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("MineWorldCraft Mining"),
                keccak256("1"),
                block.chainid,
                address(sites)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    /// Earnings paid from the vault and wallet-to-wallet transfers are never taxed; only the swap pays the 4%.
    function test_GamePayoutsAndTransfersAreNotTaxed() public {
        vm.prank(bob);
        sites.openSite{value: 0.005 ether}();
        assertEq(feeRecipient.balance, 0.005 ether, "the site price went to the treasury");
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory sig = _voucher(bob, 2_000e18, deadline);
        vm.prank(bob);
        sites.claim(2_000e18, deadline, sig); // a level 1 site converts half
        assertEq(stamp.balanceOf(bob), 1_000e18);

        vm.prank(bob);
        stamp.transfer(carolAddr(), 400e18);
        assertEq(stamp.balanceOf(carolAddr()), 400e18);
        assertEq(_fees(), 0, "no fee without a swap");

        // Bob sells the rest into the pool (after a buy brings IMD in): that pays the 4%.
        vm.prank(alice);
        router.buy(address(stamp), 1_000e18, 1, block.timestamp);
        uint256 before = _fees();
        vm.prank(bob);
        stamp.approve(address(router), type(uint256).max);
        vm.prank(bob);
        assertGt(router.sell(address(stamp), 600e18, 1, block.timestamp), 0);
        assertGt(_fees(), before);
    }

    function carolAddr() internal returns (address) {
        return makeAddr("carol");
    }

    /// The market cap is fully diluted over the whole 21M supply (the vault's half included), and the start tick
    /// from the deploy helper puts the launch at most ~2% above the target (the tick rounds down to the spacing:
    /// fewer $MINE per IMD, a slightly higher price), never below it.
    function test_MarketCapIsOverTheWholeSupply() public view {
        uint256 cap = hook.marketCap(address(stamp));
        assertApproxEqRel(cap, hook.price(address(stamp)) * TOTAL / 1e18, 1e9);
        assertGe(cap, START_MCAP - START_MCAP / 1e6, "not below the target");
        assertLe(cap, START_MCAP + START_MCAP * 21 / 1000, "at most ~2% above");
    }

    /// Burning $MINE (ERC20Burnable) doesn't move the price or the fully diluted market cap.
    function test_BurnsDontChangeTheMarketCap() public {
        uint256 cap = hook.marketCap(address(stamp));
        deal(address(stamp), alice, 1_000e18);
        vm.prank(alice);
        stamp.burn(1_000e18);
        assertEq(hook.marketCap(address(stamp)), cap);
    }
}

contract MineHookImdFirstTest is MineHookTest {
    function _imdAddress() internal pure override returns (address) {
        return address(0x1000);
    }
}

contract MineHookImdSecondTest is MineHookTest {
    function _imdAddress() internal pure override returns (address) {
        return address(uint160(type(uint160).max) - 0x1000);
    }
}
