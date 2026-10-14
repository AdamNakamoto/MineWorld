// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MineToken} from "../src/MineToken.sol";
import {MineVault} from "../src/MineVault.sol";
import {MiningSites} from "../src/MiningSites.sol";
import {MinePayments} from "../src/MinePayments.sol";
import {CrafterLevels} from "../src/CrafterLevels.sol";
import {CrafterArt} from "../src/CrafterArt.sol";
import {MineWorldCrafters} from "../src/MineWorldCrafters.sol";
import {MineDeployer} from "../script/Deploy.s.sol";
import {DevTransferValidator} from "../script/DevTransferValidator.sol";

/// $MINE is Courier World's $STAMP (StampToken) under another name: the same tests.
contract MineTokenTest is Test {
    MineToken token;
    address owner = makeAddr("owner");
    address pool = makeAddr("pool");
    address minter = makeAddr("minter");
    address alice = makeAddr("alice");

    uint256 constant LAUNCH = 10_500_000e18;

    function setUp() public {
        token = new MineToken(owner, pool, LAUNCH);
    }

    /// @dev External, so `vm.expectRevert` checks this constructor call.
    function newToken(address o, address liquidity, uint256 amount) external returns (address) {
        return address(new MineToken(o, liquidity, amount));
    }

    function test_LaunchAllocationOnly() public view {
        assertEq(token.MAX_SUPPLY(), 21_000_000e18);
        assertEq(token.totalSupply(), LAUNCH, "only the pool's half exists at launch");
        assertEq(token.totalMinted(), LAUNCH);
        assertEq(token.balanceOf(pool), LAUNCH);
        assertEq(token.totalBurned(), 0);
        assertEq(token.minter(), address(0));
        assertEq(token.owner(), owner);
    }

    function test_NameSymbolAndPermitDomain() public view {
        assertEq(token.name(), "MineWorldCraft");
        assertEq(token.symbol(), "MINE");
        assertEq(token.decimals(), 18);
        (, string memory domainName, string memory version,,,,) = token.eip712Domain();
        assertEq(domainName, "MineWorldCraft");
        assertEq(version, "1");
    }

    function test_ConstructorChecks() public {
        vm.expectRevert(MineToken.CapExceeded.selector);
        this.newToken(owner, pool, 21_000_000e18 + 1);
        vm.expectRevert(MineToken.ZeroAddress.selector);
        this.newToken(owner, address(0), 1);
        MineToken none = MineToken(this.newToken(owner, address(0), 0)); // nothing minted, nobody to mint to
        assertEq(none.totalSupply(), 0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        this.newToken(address(0), pool, LAUNCH);
    }

    /// The minter is set once, by the owner; then the owner renounces and nobody can ever change it.
    function test_MinterIsOneShotThenRenounced() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        token.setMinter(alice);
        vm.prank(owner);
        vm.expectRevert(MineToken.ZeroAddress.selector);
        token.setMinter(address(0));
        vm.expectEmit(address(token));
        emit MineToken.MinterSet(minter);
        vm.prank(owner);
        token.setMinter(minter);
        vm.prank(owner);
        vm.expectRevert(MineToken.MinterAlreadySet.selector);
        token.setMinter(alice);
        vm.prank(owner);
        token.renounceOwnership();
        assertEq(token.owner(), address(0));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        token.setMinter(alice);
        assertEq(token.minter(), minter);
    }

    /// Only the minter mints, never past 21M counting every mint: burned $MINE can't be minted again.
    function test_MintIsCappedAndBurnsArePermanent() public {
        vm.prank(owner);
        token.setMinter(minter);
        vm.prank(alice);
        vm.expectRevert(MineToken.NotMinter.selector);
        token.mint(alice, 1);
        vm.prank(owner);
        vm.expectRevert(MineToken.NotMinter.selector);
        token.mint(owner, 1);

        vm.prank(minter);
        token.mint(alice, 10_000_000e18);
        vm.prank(alice);
        token.burn(4_000e18);
        assertEq(token.totalBurned(), 4_000e18);
        assertEq(token.totalSupply(), 21_000_000e18 - 500_000e18 - 4_000e18);
        vm.prank(minter);
        token.mint(alice, 500_000e18); // exactly up to the cap
        assertEq(token.totalMinted(), 21_000_000e18);
        vm.prank(minter);
        vm.expectRevert(MineToken.CapExceeded.selector);
        token.mint(alice, 1); // even though 4,000 were burned
        assertEq(token.totalSupply(), 21_000_000e18 - 4_000e18);
    }

    /// No transfer tax: what's sent arrives, whoever sends it.
    function testFuzz_TransfersAreNeverTaxed(uint256 amount) public {
        amount = bound(amount, 0, LAUNCH);
        vm.prank(pool);
        token.transfer(alice, amount);
        assertEq(token.balanceOf(alice), amount);
        address bob = makeAddr("bob");
        vm.prank(alice);
        token.approve(address(this), amount);
        token.transferFrom(alice, bob, amount);
        assertEq(token.balanceOf(bob), amount);
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

    /// The same bytecode as Courier World's StampToken but for the name: the same functions, nothing more (no pause,
    /// no blocklist, no tax, no mint by anyone but the minter).
    function test_NoOtherPowers() public {
        bytes4[4] memory absent = [
            bytes4(keccak256("pause()")),
            bytes4(keccak256("blacklist(address)")),
            bytes4(keccak256("setFee(uint256)")),
            bytes4(keccak256("mint(uint256)"))
        ];
        for (uint256 i; i < absent.length; i++) {
            (bool ok,) = address(token).call(abi.encodeWithSelector(absent[i], 1));
            assertFalse(ok);
        }
    }
}

/// The deploy script's own steps: the token, the vault, MiningSites' proxy and the payments, wired and the token
/// renounced; CrafterLevels for the Crafters; owner-only settings from the environment.
contract GameDeployTest is Test, MineDeployer {
    address treasury = makeAddr("treasury");
    address owner = makeAddr("owner");

    function _sites() internal returns (Sites memory) {
        return Sites(treasury, makeAddr("signer"), 0.005 ether, 1_500e18, 35_000e18);
    }

    function test_TheGameIsWiredAndTheTokenRenounced() public {
        address pool = makeAddr("pool");
        Game memory g = _deployGame(address(this), owner, pool, _sites());
        MineToken token = MineToken(g.token);
        MineVault vault = MineVault(g.vault);
        MiningSites sites = MiningSites(g.sites);
        assertEq(token.owner(), address(0), "renounced, as Courier World does for $STAMP");
        assertEq(token.minter(), g.vault);
        assertEq(token.totalSupply(), 10_500_000e18);
        assertEq(token.balanceOf(pool), 10_500_000e18);
        assertEq(vault.distributor(), g.sites);
        assertEq(vault.owner(), owner);
        assertEq(sites.owner(), owner, "owned by OWNER from the start");
        assertEq(MinePayments(g.payments).owner(), owner);
        assertEq(address(sites.vault()), g.vault);
        assertEq(sites.treasury(), treasury);
        assertEq(MinePayments(g.payments).treasury(), treasury);
        assertEq(sites.dailyCap() * 300, vault.TOTAL_LIMIT(), "the default daily cap is the 300-day pace");
        assertEq(_implementation(g.sites), g.sitesImpl);
        assertEq(_implementation(g.payments), g.paymentsImpl);
        // Nobody holds the vault's half: it's minted only as players claim.
        assertEq(token.balanceOf(g.vault), 0);
        assertEq(token.balanceOf(g.sites), 0);
    }

    /// The defaults the deploy script falls back on when launch.env leaves them out.
    function test_DefaultSettings() public {
        vm.setEnv("MINING_SIGNER", vm.toString(makeAddr("signer")));
        Sites memory s = _sitesFromEnv(treasury);
        assertEq(s.sitePrice, 0.005 ether);
        assertEq(s.walletDailyCap, 1_500e18);
        assertEq(s.dailyCap, 35_000e18);
    }

    function test_LevelsForTheCrafters() public {
        Game memory g = _deployGame(address(this), owner, makeAddr("pool"), _sites());
        MineWorldCrafters crafters = new MineWorldCrafters(
            address(this), treasury, 0, bytes32(0), address(new DevTransferValidator()), new CrafterArt()
        );
        (CrafterLevels levels, address impl) = _deployLevels(owner, g.token, address(crafters), treasury);
        assertEq(_implementation(address(levels)), impl);
        assertEq(address(levels.token()), g.token);
        assertEq(address(levels.crafters()), address(crafters));
        assertEq(levels.owner(), owner);
        assertEq(levels.treasury(), treasury);
        _wireLevels(address(this), levels); // this contract owns the Crafters: it points them at the levels
        assertEq(crafters.attributesExtension(), address(levels));

        vm.expectRevert("no Crafters at CRAFTERS");
        this.deployLevels(g.token, makeAddr("nothing"));
        vm.expectRevert("no $MINE at MINE");
        this.deployLevels(makeAddr("nothing"), address(crafters));
    }

    function deployLevels(address token, address crafters) external returns (CrafterLevels levels) {
        (levels,) = _deployLevels(owner, token, crafters, treasury);
    }

    /// Custom upgrade costs: set when the deploying wallet owns the contract, else left for the owner (printed).
    function test_CostsFromTheEnvironment() public {
        Game memory g = _deployGame(address(this), address(this), makeAddr("pool"), _sites());
        MiningSites sites = MiningSites(g.sites);
        uint256[] memory before = sites.upgradeCosts();
        _costsFromEnv(sites, "NO_SUCH_COSTS_VAR", address(this));
        assertEq(abi.encode(sites.upgradeCosts()), abi.encode(before));
        vm.setEnv("TEST_UPGRADE_COSTS", "1000000000000000000,2000000000000000000,3000000000000000000,4000000000000000000");
        _costsFromEnv(sites, "TEST_UPGRADE_COSTS", address(this));
        assertEq(sites.upgradeCost(2), 1e18);
        assertEq(sites.upgradeCost(5), 4e18);

        Game memory g2 = _deployGame(address(this), owner, makeAddr("pool"), _sites());
        vm.setEnv("TEST_UPGRADE_COSTS2", "7000000000000000000,7000000000000000000,7000000000000000000,7000000000000000000");
        _costsFromEnv(MiningSites(g2.sites), "TEST_UPGRADE_COSTS2", address(this)); // not the owner: only printed
        assertEq(MiningSites(g2.sites).upgradeCost(2), 4_620e18);
    }
}
