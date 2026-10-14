// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MineHook} from "../src/MineHook.sol";
import {MineToken} from "../src/MineToken.sol";
import {MineEthRouter} from "../src/MineEthRouter.sol";
import {MiningSites} from "../src/MiningSites.sol";
import {MineVault} from "../src/MineVault.sol";
import {DeployLib} from "../script/DeployLib.sol";
import {RobinhoodConfig, MineDeployer} from "../script/Deploy.s.sol";

/// IMD's own admin functions on Robinhood Chain (its owner is a single wallet).
interface IImdAdmin {
    function owner() external view returns (address);
    function setBlocked(address account, bool blocked) external;
}

/// @notice Runs the hook against the real Robinhood Chain PoolManager, IMD and IMD/ETH pool (adapted from Courier
///         World's StampHook fork tests).
///   forge test --match-contract MineHookForkTest --fork-url robinhood
/// Skipped when not forked.
contract MineHookForkTest is Test, MineDeployer {
    MineHook hook;
    MineToken mine;
    MiningSites sites;
    MineEthRouter ethRouter;
    address feeRecipient = makeAddr("feeRecipient");
    address alice = makeAddr("alice");

    function setUp() public {
        if (block.chainid != 4663) return;
        bytes memory initCode = abi.encodePacked(
            type(MineHook).creationCode,
            abi.encode(
                RobinhoodConfig.POOL_MANAGER, RobinhoodConfig.IMD, address(this), feeRecipient,
                DeployLib.startTickForMarketCap(5_000e18, 21_000_000e18), uint256(10_500_000e18),
                MineHook.ImdEthPool(RobinhoodConfig.IMD_ETH_FEE, RobinhoodConfig.IMD_ETH_SPACING, address(0))
            )
        );
        (bytes32 salt, address expected) = DeployLib.mineSalt(address(this), RobinhoodConfig.HOOK_FLAGS, initCode, 0);
        address deployed;
        assembly {
            deployed := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }
        require(deployed == expected, "hook address");
        hook = MineHook(deployed);
        ethRouter = MineEthRouter(payable(hook.ethRouter()));
        Game memory g = _deployGame(
            address(this), address(this), address(hook), Sites(feeRecipient, makeAddr("signer"), 0.005 ether, 1_500e18, 35_000e18)
        );
        mine = MineToken(g.token);
        sites = MiningSites(g.sites);
        hook.openPool(address(mine));
        vm.deal(alice, 1 ether);
    }

    function test_Fork_BuyAndSellWithEthThroughRealPools() public {
        vm.skip(block.chainid != 4663);
        vm.startPrank(alice);
        uint256 got = ethRouter.buyWithEth{value: 0.01 ether}(address(mine), 1, block.timestamp);
        assertGt(got, 0);
        uint256 fee = hook.pendingProtocolFees(RobinhoodConfig.IMD);
        assertGt(fee, 0);

        mine.approve(address(ethRouter), type(uint256).max);
        uint256 ethOut = ethRouter.sellForEth(address(mine), got / 2, 1, block.timestamp);
        vm.stopPrank();
        assertGt(ethOut, 0);
        assertGt(hook.pendingProtocolFees(RobinhoodConfig.IMD), fee);

        hook.collectProtocolFees(RobinhoodConfig.IMD);
        assertGt(IERC20(RobinhoodConfig.IMD).balanceOf(feeRecipient), 0);
    }

    /// Final check 19b34b9b finding 3 (StampHook): IMD's owner can block an address; a blocked fee recipient moves
    /// its own fees to a new one, with the hook already renounced.
    function test_Fork_BlockedFeeRecipientMovesItsFees() public {
        vm.skip(block.chainid != 4663);
        hook.renounceOwnership();
        vm.prank(alice);
        ethRouter.buyWithEth{value: 0.01 ether}(address(mine), 1, block.timestamp);
        IImdAdmin imd = IImdAdmin(RobinhoodConfig.IMD);
        vm.prank(imd.owner());
        imd.setBlocked(feeRecipient, true);
        vm.expectRevert();
        hook.collectProtocolFees(RobinhoodConfig.IMD);

        address next = makeAddr("next");
        vm.prank(feeRecipient);
        hook.setFeeRecipient(next);
        hook.collectProtocolFees(RobinhoodConfig.IMD);
        assertGt(IERC20(RobinhoodConfig.IMD).balanceOf(next), 0);
        assertEq(hook.pendingProtocolFees(RobinhoodConfig.IMD), 0);
    }
}

/// @notice The deploy script's own launch (MineDeployer._launch) against the live PoolManager, Chainlink ETH/USD and
///         the IMD/ETH pool: everything deployed, linked and renounced as on mainnet, then a trade and a claim.
///   forge test --match-contract LaunchForkTest --fork-url robinhood
/// Skipped when not forked.
contract LaunchForkTest is Test, MineDeployer {
    uint256 constant SIGNER_KEY = 0x5160;
    address treasury = makeAddr("treasury");
    address feeRecipient = makeAddr("feeRecipient");
    address alice = makeAddr("alice");

    function test_Fork_FullLaunch() public {
        vm.skip(block.chainid != 4663);
        uint256 startMcap = _usdToImd(5_000); // $5,000 for all 21M $MINE, in IMD at today's prices
        Sites memory s = Sites(treasury, vm.addr(SIGNER_KEY), 0.005 ether, 1_500e18, 35_000e18);
        address owner = makeAddr("owner");
        Launch memory l = _launch(address(this), owner, feeRecipient, startMcap, s);
        MineHook hook = MineHook(l.hook);
        MineToken mine = MineToken(l.game.token);
        MiningSites sites = MiningSites(l.game.sites);

        // Linked and renounced as planned.
        address token = l.game.token;
        assertEq(uint160(l.hook) & 0x3FFF, RobinhoodConfig.HOOK_FLAGS);
        assertEq(hook.owner(), address(0), "the hook is renounced");
        assertEq(hook.feeRecipient(), feeRecipient);
        assertEq(hook.token(), token);
        assertEq(mine.owner(), address(0), "the token is renounced");
        assertEq(mine.minter(), l.game.vault);
        assertEq(address(sites.token()), token);
        assertEq(sites.owner(), owner);
        assertEq(MineVault(l.game.vault).owner(), owner);
        assertEq(sites.treasury(), treasury);
        assertEq(mine.balanceOf(l.hook), 0, "the pool half is in the pool");
        assertEq(mine.balanceOf(address(RobinhoodConfig.POOL_MANAGER)) + mine.balanceOf(address(0xdEaD)), 10_500_000e18);
        assertEq(mine.totalSupply(), 10_500_000e18, "nothing else minted yet");
        assertEq(sites.vaultBalance(), 10_500_000e18);
        assertApproxEqRel(hook.marketCap(token), startMcap, 0.025e18);

        // A buy with ETH through the real IMD/ETH pool pays the 4% to the fee recipient.
        vm.deal(alice, 1 ether);
        MineEthRouter ethRouter = MineEthRouter(payable(hook.ethRouter())); // (read before the prank, which it would use up)
        vm.prank(alice);
        uint256 got = ethRouter.buyWithEth{value: 0.01 ether}(token, 1, block.timestamp);
        assertGt(got, 0);
        hook.collectProtocolFees(RobinhoodConfig.IMD);
        assertGt(IERC20(RobinhoodConfig.IMD).balanceOf(feeRecipient), 0);

        // A site (paid to the treasury) and a claim from the vault.
        vm.prank(alice);
        sites.openSite{value: 0.005 ether}();
        assertEq(treasury.balance, 0.005 ether);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                keccak256(
                    abi.encode(
                        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                        keccak256("MineWorldCraft Mining"), keccak256("1"), block.chainid, l.game.sites
                    )
                ),
                keccak256(abi.encode(sites.EARNINGS_TYPEHASH(), alice, 1_234e18, deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(SIGNER_KEY, digest);
        vm.prank(alice);
        assertEq(sites.claim(1_234e18, deadline, abi.encodePacked(r, sg, v)), 617e18); // half, at level 1, minted
        assertEq(mine.balanceOf(alice), got + 617e18);
        assertEq(mine.totalMinted(), 10_500_000e18 + 617e18);

        // An upgrade paid with $MINE bought through the pool: 75% burned, 25% to the treasury.
        uint256 cost = sites.upgradeCost(2);
        deal(token, alice, cost);
        vm.startPrank(alice);
        mine.approve(l.game.sites, cost);
        sites.upgradeSite(cost, sites.levelRateBps(2));
        vm.stopPrank();
        assertEq(sites.rateBps(alice), 6_000);
        assertEq(mine.balanceOf(treasury), cost / 4);
        assertEq(mine.totalBurned(), cost * 3 / 4);
    }
}
