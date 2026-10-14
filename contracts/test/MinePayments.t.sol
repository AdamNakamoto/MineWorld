// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {MineToken} from "../src/MineToken.sol";
import {MinePayments} from "../src/MinePayments.sol";
import {MinePayer} from "../src/MinePayer.sol";
import {OwnedUUPS} from "../src/lib/OwnedUUPS.sol";

contract MinePaymentsV2 is MinePayments {
    function version() external pure returns (uint256) {
        return 2;
    }
}

/// A contract with no receive or fallback (it takes no ETH).
contract NoEthHere {}

contract MinePaymentsTest is Test {
    MineToken token;
    MinePayments payments;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address pool = makeAddr("pool");
    address alice = makeAddr("alice");

    function setUp() public {
        token = new MineToken(address(this), pool, 10_500_000e18);
        payments = MinePayments(
            address(
                new ERC1967Proxy(
                    address(new MinePayments()),
                    abi.encodeCall(MinePayments.initialize, (IERC20(address(token)), owner, treasury))
                )
            )
        );
        vm.prank(pool);
        token.transfer(alice, 100_000e18);
    }

    function _pay(uint256 kind, uint256 amount, bytes32 ref) internal returns (uint256) {
        vm.startPrank(alice);
        token.approve(address(payments), amount);
        uint256 burned = payments.pay(kind, amount, ref);
        vm.stopPrank();
        return burned;
    }

    function test_DeployedAsSpecified() public view {
        assertEq(address(payments.token()), address(token));
        assertEq(payments.owner(), owner);
        assertEq(payments.treasury(), treasury);
        assertEq(payments.kindCount(), 2);
        (string memory name, uint256 burn) = payments.kind(payments.KIND_SHOP());
        assertEq(name, "shop");
        assertEq(burn, 7_500);
        (name, burn) = payments.kind(payments.KIND_TICKET());
        assertEq(name, "ticket");
        assertEq(burn, 0);
    }

    /// The shop: 75% burned, 25% to the treasury, both straight from the player's wallet; the receipt the game checks.
    function test_ShopBurnsThreeQuarters() public {
        bytes32 ref = keccak256("order 1");
        vm.startPrank(alice);
        token.approve(address(payments), 1_000e18);
        vm.expectEmit(address(payments));
        emit MinePayments.Paid(alice, 0, 1_000e18, 750e18, ref);
        assertEq(payments.pay(0, 1_000e18, ref), 750e18);
        vm.stopPrank();
        assertEq(token.balanceOf(alice), 99_000e18);
        assertEq(token.balanceOf(treasury), 250e18);
        assertEq(token.totalBurned(), 750e18);
        assertEq(token.balanceOf(address(payments)), 0, "never holds $MINE");
    }

    /// Tickets: nothing burned, all to the treasury.
    function test_TicketsGoToTheTreasury() public {
        assertEq(_pay(1, 100e18, bytes32("ticket 7")), 0);
        assertEq(token.balanceOf(treasury), 100e18);
        assertEq(token.totalBurned(), 0);
    }

    function test_PayChecks() public {
        vm.startPrank(alice);
        vm.expectRevert(MinePayments.NoSuchKind.selector);
        payments.pay(2, 1e18, 0);
        vm.expectRevert(MinePayments.ZeroAmount.selector);
        payments.pay(0, 0, 0);
        vm.expectRevert(); // not approved
        payments.pay(0, 1e18, 0);
        token.approve(address(payments), 1e18 - 1);
        vm.expectRevert(); // approved too little
        payments.pay(0, 1e18, 0);
        vm.stopPrank();
    }

    /// The owner adds kinds and sets each one's burn share (0% to 100%).
    function test_KindsAreTheOwners() public {
        vm.startPrank(owner);
        vm.expectEmit(address(payments));
        emit MinePayments.KindAdded(2, "boost", 10_000);
        assertEq(payments.addKind("boost", 10_000), 2);
        vm.expectRevert(MinePayer.BadBurn.selector);
        payments.addKind("too much", 10_001);
        vm.expectRevert(MinePayments.BadName.selector);
        payments.addKind("", 0);
        vm.expectRevert(MinePayments.BadName.selector);
        payments.addKind("a name longer than thirty-two bytes", 0);
        vm.expectEmit(address(payments));
        emit MinePayments.KindBurnSet(1, 2_000);
        payments.setKindBurn(1, 2_000);
        vm.expectRevert(MinePayer.BadBurn.selector);
        payments.setKindBurn(1, 10_001);
        vm.expectRevert(MinePayments.NoSuchKind.selector);
        payments.setKindBurn(3, 0);
        vm.stopPrank();
        assertEq(_pay(2, 10e18, 0), 10e18, "all burned");
        assertEq(_pay(1, 10e18, 0), 2e18);
        assertEq(token.balanceOf(treasury), 8e18);
        // Up to 32 kinds.
        vm.startPrank(owner);
        for (uint256 i = 3; i < 32; i++) {
            payments.addKind("more", 0);
        }
        vm.expectRevert(MinePayments.TooManyKinds.selector);
        payments.addKind("one more", 0);
        vm.stopPrank();
    }

    function test_TreasuryMoves() public {
        address next = makeAddr("next");
        vm.prank(owner);
        payments.setTreasury(next);
        _pay(0, 100e18, 0);
        assertEq(token.balanceOf(next), 25e18);
        // Payments are $MINE only, so a treasury contract that takes no ETH is fine here (audit 0792975e #4's check
        // is only where ETH is sent: MiningSites and the Crafters).
        address noEth = address(new NoEthHere());
        vm.prank(owner);
        payments.setTreasury(noEth);
        _pay(0, 100e18, 0);
        assertEq(token.balanceOf(noEth), 25e18);
    }

    function test_UpgradeKeepsKindsAndOnlyTheOwnerUpgrades() public {
        vm.prank(owner);
        payments.addKind("boost", 5_000);
        MinePaymentsV2 v2 = new MinePaymentsV2();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        payments.upgradeToAndCall(address(v2), "");
        vm.prank(owner);
        payments.upgradeToAndCall(address(v2), "");
        assertEq(MinePaymentsV2(address(payments)).version(), 2);
        assertEq(payments.kindCount(), 3);
        (string memory name, uint256 burn) = payments.kind(2);
        assertEq(name, "boost");
        assertEq(burn, 5_000);
        assertEq(payments.treasury(), treasury);
        assertEq(_pay(0, 100e18, 0), 75e18);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        payments.initialize(IERC20(address(token)), alice, alice);
    }

    function test_OwnerOnlyAndNoRenounce() public {
        bytes memory unauthorized = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice);
        vm.startPrank(alice);
        vm.expectRevert(unauthorized);
        payments.addKind("x", 0);
        vm.expectRevert(unauthorized);
        payments.setKindBurn(0, 0);
        vm.expectRevert(unauthorized);
        payments.setTreasury(alice);
        vm.stopPrank();
        vm.prank(owner);
        vm.expectRevert(OwnedUUPS.CannotRenounce.selector);
        payments.renounceOwnership();
        MinePayments impl = new MinePayments();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(IERC20(address(token)), owner, treasury);
    }

    /// Any amount, any burn share: burned plus the treasury's part is exactly what was paid.
    function testFuzz_SplitAddsUp(uint256 amount, uint256 burnBps) public {
        amount = bound(amount, 1, 100_000e18);
        burnBps = bound(burnBps, 0, 10_000);
        vm.prank(owner);
        payments.setKindBurn(0, burnBps);
        uint256 supply = token.totalSupply();
        uint256 burned = _pay(0, amount, 0);
        assertEq(burned, amount * burnBps / 10_000);
        assertEq(supply - token.totalSupply(), burned);
        assertEq(token.balanceOf(treasury), amount - burned);
    }
}
