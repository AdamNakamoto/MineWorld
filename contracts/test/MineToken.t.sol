// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MineToken} from "../src/MineToken.sol";
import {MiningSites} from "../src/MiningSites.sol";
import {MineDeployer} from "../script/Deploy.s.sol";

contract MineTokenTest is Test {
    MineToken token;
    address pool = makeAddr("pool");
    address vault = makeAddr("vault");
    address alice = makeAddr("alice");

    function setUp() public {
        token = new MineToken(pool, vault);
    }

    /// @dev External, so `vm.expectRevert` checks this constructor call.
    function newToken(address p, address v) external returns (address) {
        return address(new MineToken(p, v));
    }

    function test_SupplyIsSplitInHalf() public view {
        assertEq(token.TOTAL_SUPPLY(), 1_000_000_000e18);
        assertEq(token.POOL_SUPPLY(), 500_000_000e18);
        assertEq(token.VAULT_SUPPLY(), 500_000_000e18);
        assertEq(token.totalSupply(), 1_000_000_000e18);
        assertEq(token.balanceOf(pool), 500_000_000e18);
        assertEq(token.balanceOf(vault), 500_000_000e18);
        assertEq(token.pool(), pool);
        assertEq(token.vault(), vault);
    }

    function test_NameSymbolAndPermitDomain() public view {
        assertEq(token.name(), "MineWorldCraft");
        assertEq(token.symbol(), "MINE");
        assertEq(token.decimals(), 18);
        (, string memory domainName, string memory version,,,,) = token.eip712Domain();
        assertEq(domainName, "MineWorldCraft");
        assertEq(version, "1");
    }

    function test_NobodyOwnsItAndNothingMintsMore() public {
        assertEq(token.owner(), address(0));
        // No mint function of any common shape exists.
        (bool ok,) = address(token).call(abi.encodeWithSignature("mint(address,uint256)", alice, 1));
        assertFalse(ok);
        (ok,) = address(token).call(abi.encodeWithSignature("mint(uint256)", 1));
        assertFalse(ok);
        assertEq(token.totalSupply(), 1_000_000_000e18);
    }

    function test_ZeroAddressesAreRefused() public {
        vm.expectRevert(MineToken.ZeroAddress.selector);
        this.newToken(address(0), vault);
        vm.expectRevert(MineToken.ZeroAddress.selector);
        this.newToken(pool, address(0));
    }

    /// No transfer tax: what's sent arrives, whoever sends it.
    function testFuzz_TransfersAreNeverTaxed(uint256 amount) public {
        amount = bound(amount, 0, 500_000_000e18);
        vm.prank(vault);
        token.transfer(alice, amount);
        assertEq(token.balanceOf(alice), amount);
        address bob = makeAddr("bob");
        vm.prank(alice);
        token.approve(address(this), amount);
        token.transferFrom(alice, bob, amount);
        assertEq(token.balanceOf(bob), amount);
    }

    function test_BurnsLowerTheSupply() public {
        vm.prank(vault);
        token.transfer(alice, 1_000e18);
        vm.prank(alice);
        token.burn(400e18);
        assertEq(token.totalSupply(), 1_000_000_000e18 - 400e18);
        assertEq(token.TOTAL_SUPPLY(), 1_000_000_000e18); // the constant (and the hook's market cap) stays
    }

    function test_PermitApproves() public {
        (address carol, uint256 key) = makeAddrAndKey("carol");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                carol,
                alice,
                5e18,
                token.nonces(carol),
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
        token.permit(carol, alice, 5e18, deadline, v, r, s);
        assertEq(token.allowance(carol, alice), 5e18);
    }
}

/// The deploy script's own step: MiningSites at the token's predicted address, then the token funding it.
contract TokenAndSitesDeployTest is Test, MineDeployer {
    function test_SitesGetTheTokenTheyWereGiven() public {
        Sites memory s = Sites(makeAddr("treasury"), makeAddr("signer"), 0.005 ether, 5_000e18, 1_000_000e18);
        address pool = makeAddr("pool");
        (MineToken token, MiningSites sites) = _deployTokenAndSites(address(this), address(this), pool, s);
        assertEq(address(sites.token()), address(token));
        assertEq(sites.vaultBalance(), 500_000_000e18);
        assertEq(token.balanceOf(pool), 500_000_000e18);
        assertEq(sites.owner(), address(this));
        assertEq(sites.signer(), s.signer);
    }
}
