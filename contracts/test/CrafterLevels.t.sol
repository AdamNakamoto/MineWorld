// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {MineToken} from "../src/MineToken.sol";
import {CrafterLevels} from "../src/CrafterLevels.sol";
import {UpgradeCosts} from "../src/UpgradeCosts.sol";
import {MinePayer} from "../src/MinePayer.sol";
import {OwnedUUPS} from "../src/lib/OwnedUUPS.sol";
import {CrafterArt} from "../src/CrafterArt.sol";
import {MineWorldCrafters} from "../src/MineWorldCrafters.sol";
import {StrictValidator, Json, NoEthTreasury} from "./MineWorldCrafters.t.sol";

/// An attributes extension whose attributesOf always reverts (the Crafters must still show their metadata).
contract BrokenExtension {
    function attributesOf(uint256) external pure returns (string memory) {
        revert("broken");
    }
}

/// Another extension: two traits at once.
contract TwoTraits {
    function attributesOf(uint256 id) external pure returns (string memory) {
        return id % 2 == 0
            ? '{"trait_type":"Mood","value":"Happy"},{"trait_type":"Power","value":7}'
            : '{"trait_type":"Mood","value":"Calm"},{"trait_type":"Power","value":3}';
    }
}

/// Deploys CrafterLevels' implementation and proxy from its own nonce, so the proxy's address is predictable.
contract LevelsFactory {
    function make(address t, address c, address o, address tr) external returns (address) {
        CrafterLevels impl = new CrafterLevels();
        return address(
            new ERC1967Proxy(address(impl), abi.encodeCall(CrafterLevels.initialize, (IERC20(t), IERC721(c), o, tr)))
        );
    }
}

/// CrafterLevels' next version, for the upgrade test.
contract CrafterLevelsV2 is CrafterLevels {
    function version() external pure returns (uint256) {
        return 2;
    }
}

contract CrafterLevelsTest is Test {
    MineToken token;
    MineWorldCrafters crafters;
    CrafterLevels levels;
    StrictValidator validator;

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address pool = makeAddr("pool"); // holds the launch allocation: stands in for buying $MINE
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address market = makeAddr("market");

    uint256 constant SECRET = 99;
    uint256 constant COST_2 = 2_310e18;
    uint256 constant COST_3 = 9_471e18;
    uint256 constant COST_4 = 38_831e18;
    uint256 constant COST_5 = 159_207e18;

    function setUp() public {
        token = new MineToken(address(this), pool, 10_500_000e18);
        validator = new StrictValidator();
        crafters = new MineWorldCrafters(owner, treasury, 0, keccak256(abi.encode(SECRET)), address(validator), new CrafterArt());
        levels = _newLevels(owner, treasury);
        vm.prank(owner);
        crafters.setSaleOpen(true);
        vm.prank(alice, alice);
        crafters.mint(3);
        vm.prank(bob, bob);
        crafters.mint(1);
        vm.startPrank(owner);
        crafters.setSaleOpen(false);
        crafters.reveal(SECRET);
        vm.roll(block.number + 2);
        crafters.seal();
        crafters.setAttributesExtension(address(levels));
        vm.stopPrank();
    }

    function _newLevels(address o, address tr) internal returns (CrafterLevels) {
        CrafterLevels impl = new CrafterLevels();
        return CrafterLevels(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(CrafterLevels.initialize, (IERC20(address(token)), IERC721(address(crafters)), o, tr))
                )
            )
        );
    }

    /// @dev External, so `vm.expectRevert` checks the deploy.
    function newLevels(address t, address c, address o, address tr) external returns (address) {
        CrafterLevels impl = new CrafterLevels();
        return address(
            new ERC1967Proxy(address(impl), abi.encodeCall(CrafterLevels.initialize, (IERC20(t), IERC721(c), o, tr)))
        );
    }

    function _list(uint256 a, uint256 b, uint256 c, uint256 d) internal pure returns (uint256[] memory l) {
        l = new uint256[](4);
        (l[0], l[1], l[2], l[3]) = (a, b, c, d);
    }

    /// `who` upgrades Crafter `id`: given the cost (as if bought), approving exactly that, as the game does.
    function _upgrade(address who, uint256 id) internal returns (uint256 cost) {
        cost = levels.upgradeCost(levels.levelOf(id) + 1);
        vm.prank(pool);
        token.transfer(who, cost);
        vm.startPrank(who);
        token.approve(address(levels), cost);
        levels.upgrade(id, cost);
        vm.stopPrank();
    }

    /// The "Level" trait in the token's metadata (after the traits and the rarity), and its top.
    function _levelInURI(uint256 id) internal view returns (uint256 level, uint256 top) {
        string memory json = Json.decodeURI(crafters.tokenURI(id));
        string memory at = _after(json, 1);
        assertEq(vm.parseJsonString(json, string.concat(at, ".trait_type")), "Level");
        return (vm.parseJsonUint(json, string.concat(at, ".value")), vm.parseJsonUint(json, string.concat(at, ".max_value")));
    }

    /// The path of the `n`th attribute after the rarity (the extension's).
    function _after(string memory json, uint256 n) internal pure returns (string memory) {
        return string.concat(".attributes[", vm.toString(Json.rarityAt(json) + n), "]");
    }

    // ---------------------------------------------------------------- deploy

    function test_DeployedAsSpecified() public view {
        assertEq(address(levels.token()), address(token));
        assertEq(address(levels.crafters()), address(crafters));
        assertEq(levels.owner(), owner);
        assertEq(levels.treasury(), treasury);
        assertEq(levels.maxLevel(), 5);
        assertEq(levels.MAX_LEVELS(), 20);
        assertEq(levels.MAX_UPGRADE_COST(), 2_000_000e18);
        assertEq(levels.upgradeBurnBps(), 7_500);
        assertEq(abi.encode(levels.upgradeCosts()), abi.encode(_list(COST_2, COST_3, COST_4, COST_5)));
        assertEq(COST_2 + COST_3 + COST_4 + COST_5, 209_819e18, "about $500 at a $50,000 market cap");
        assertEq(crafters.attributesExtension(), address(levels));
    }

    function test_InitializeChecks() public {
        vm.expectRevert(MinePayer.ZeroAddress.selector);
        this.newLevels(address(0), address(crafters), owner, treasury);
        vm.expectRevert(MinePayer.ZeroAddress.selector);
        this.newLevels(address(token), address(crafters), owner, address(0));
        vm.expectRevert(abi.encodeWithSelector(OwnedUUPS.OwnableInvalidOwner.selector, address(0)));
        this.newLevels(address(token), address(crafters), address(0), treasury);
        vm.expectRevert(CrafterLevels.NotAContract.selector);
        this.newLevels(makeAddr("eoa"), address(crafters), owner, treasury);
        vm.expectRevert(CrafterLevels.NotAContract.selector);
        this.newLevels(address(token), makeAddr("eoa"), owner, treasury);
        LevelsFactory f = new LevelsFactory();
        address next = vm.computeCreateAddress(address(f), vm.getNonce(address(f)) + 1); // its proxy
        vm.expectRevert(MinePayer.BadTreasury.selector);
        f.make(address(token), address(crafters), owner, next);
        // The implementation can't be set up on its own; the proxy can't be set up twice.
        CrafterLevels impl = new CrafterLevels();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(IERC20(address(token)), IERC721(address(crafters)), owner, treasury);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        levels.initialize(IERC20(address(token)), IERC721(address(crafters)), alice, alice);
    }

    // ---------------------------------------------------------------- levels

    function test_NewCraftersAreLevelOne() public view {
        assertEq(levels.levelOf(1), 1);
        assertEq(levels.levelOf(4), 1);
        assertEq(levels.attributesOf(1), '{"trait_type":"Level","value":1,"max_value":5}');
        (uint256 level, uint256 top) = _levelInURI(1);
        assertEq(level, 1);
        assertEq(top, 5);
    }

    /// 75% of the cost is burned from the holder's wallet and 25% goes from it to the treasury; marketplaces are told
    /// to re-read the Crafter.
    function test_UpgradeBurnsThreeQuartersAndPaysTheTreasuryTheRest() public {
        vm.prank(pool);
        token.transfer(alice, COST_2);
        vm.prank(alice);
        token.approve(address(levels), COST_2);
        uint256 supply = token.totalSupply();
        vm.expectEmit(address(levels));
        emit CrafterLevels.CrafterUpgraded(2, alice, 2, COST_2, 1_732.5e18);
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.MetadataUpdate(2);
        vm.prank(alice);
        assertEq(levels.upgrade(2, COST_2), 2);
        assertEq(levels.levelOf(2), 2);
        (uint256 level,) = _levelInURI(2);
        assertEq(level, 2);
        (level,) = _levelInURI(1);
        assertEq(level, 1, "only that Crafter");
        assertEq(supply - token.totalSupply(), 1_732.5e18, "75% burned");
        assertEq(token.totalBurned(), 1_732.5e18);
        assertEq(token.balanceOf(treasury), 577.5e18, "25% to the treasury");
        assertEq(token.balanceOf(alice), 0);
        assertEq(token.balanceOf(address(levels)), 0, "never holds $MINE");
    }

    function test_UpgradeAllTheWayToLevelFive() public {
        uint256 supply = token.totalSupply();
        uint256 spent;
        for (uint256 level = 2; level <= 5; level++) {
            spent += _upgrade(alice, 3);
            assertEq(levels.levelOf(3), level);
            (uint256 shown,) = _levelInURI(3);
            assertEq(shown, level);
        }
        assertEq(spent, 209_819e18);
        assertEq(supply - token.totalSupply(), spent * 3 / 4);
        assertEq(token.balanceOf(treasury), spent / 4);
        vm.prank(pool);
        token.transfer(alice, 2_000_000e18);
        vm.startPrank(alice);
        token.approve(address(levels), type(uint256).max);
        vm.expectRevert(UpgradeCosts.MaxLevel.selector);
        levels.upgrade(3, type(uint256).max);
        vm.stopPrank();
    }

    /// The owner adds levels on top (up to 20, never fewer); every Crafter's trait shows the new top.
    function test_AddLevels() public {
        _upgrade(alice, 1);
        vm.prank(owner);
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.BatchMetadataUpdate(1, 4);
        assertEq(levels.addLevel(500_000e18), 6);
        assertEq(levels.maxLevel(), 6);
        (uint256 level, uint256 top) = _levelInURI(1);
        assertEq(level, 2);
        assertEq(top, 6);
        while (levels.levelOf(1) < 6) _upgrade(alice, 1);
        assertEq(levels.levelOf(1), 6);
        vm.startPrank(owner);
        vm.expectRevert(UpgradeCosts.BadCosts.selector);
        levels.addLevel(2_000_000e18 + 1);
        for (uint256 l = 7; l <= 20; l++) {
            levels.addLevel(1e18);
        }
        vm.expectRevert(UpgradeCosts.TooManyLevels.selector);
        levels.addLevel(1e18);
        vm.stopPrank();
    }

    /// Only the Crafter's holder can upgrade it: not someone else, not an approved operator, not for a Crafter that
    /// doesn't exist.
    function test_OnlyTheHolderUpgrades() public {
        vm.prank(pool);
        token.transfer(bob, COST_2);
        vm.prank(bob);
        token.approve(address(levels), COST_2);
        vm.prank(bob);
        vm.expectRevert(CrafterLevels.NotHolder.selector);
        levels.upgrade(1, COST_2); // alice's
        vm.prank(alice);
        crafters.setApprovalForAll(market, true);
        vm.prank(market);
        vm.expectRevert(CrafterLevels.NotHolder.selector);
        levels.upgrade(1, COST_2);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 99));
        levels.upgrade(99, COST_2);
        vm.prank(bob);
        levels.upgrade(4, COST_2);
        assertEq(levels.levelOf(4), 2);
    }

    /// Audit 0792975e #5: a cost raise mined just before the upgrade can't charge more than the maxCost the holder
    /// sent, even with an unlimited allowance; the holder who agrees to the new cost pays it.
    function test_RaisedCostRevertsEvenWithAnUnlimitedApproval() public {
        vm.prank(pool);
        token.transfer(alice, 2_000_000e18);
        vm.prank(alice);
        token.approve(address(levels), type(uint256).max);
        assertEq(levels.upgradeCost(2), COST_2); // what the holder was shown
        vm.prank(owner);
        levels.setUpgradeCosts(_list(2_000_000e18, COST_3, COST_4, COST_5)); // mined first
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(UpgradeCosts.CostAboveMax.selector, 2_000_000e18, COST_2));
        levels.upgrade(1, COST_2);
        assertEq(token.balanceOf(alice), 2_000_000e18, "nothing taken");
        assertEq(levels.levelOf(1), 1);
        // Lowered below what was shown: the lower cost is charged.
        vm.prank(owner);
        levels.setUpgradeCosts(_list(1_000e18, COST_3, COST_4, COST_5));
        vm.prank(alice);
        assertEq(levels.upgrade(1, COST_2), 2);
        assertEq(token.balanceOf(alice), 2_000_000e18 - 1_000e18);
    }

    function test_UpgradeNeedsTheMineApproved() public {
        vm.prank(pool);
        token.transfer(alice, COST_2);
        vm.prank(alice);
        vm.expectRevert();
        levels.upgrade(1, COST_2);
        vm.prank(alice);
        token.approve(address(levels), COST_2 - 1);
        vm.prank(alice);
        vm.expectRevert();
        levels.upgrade(1, COST_2);
        assertEq(levels.levelOf(1), 1);
    }

    /// The level belongs to the token: it goes with the Crafter when it's sold or given, and the new holder can carry
    /// on.
    function test_LevelStaysWithTheCrafter() public {
        _upgrade(alice, 1);
        _upgrade(alice, 1);
        assertEq(levels.levelOf(1), 3);
        vm.prank(alice);
        crafters.transferFrom(alice, bob, 1);
        assertEq(levels.levelOf(1), 3);
        vm.prank(bob);
        crafters.setApprovalForAll(market, true);
        validator.authorize(market, true);
        vm.prank(market);
        crafters.transferFrom(bob, alice, 1); // a marketplace sale, through the fee check
        assertEq(levels.levelOf(1), 3);
        vm.prank(alice);
        crafters.transferFrom(alice, bob, 1);
        vm.prank(pool);
        token.transfer(alice, COST_4);
        vm.prank(alice);
        token.approve(address(levels), COST_4);
        vm.prank(alice);
        vm.expectRevert(CrafterLevels.NotHolder.selector);
        levels.upgrade(1, COST_4);
        _upgrade(bob, 1);
        assertEq(levels.levelOf(1), 4);
    }

    /// Upgrades work before the collection points here (no refresh then), and the levels show once it does.
    function test_UpgradesBeforeTheCollectionIsWired() public {
        vm.prank(owner);
        crafters.setAttributesExtension(address(0));
        vm.recordLogs();
        _upgrade(alice, 2);
        assertEq(levels.levelOf(2), 2);
        bytes32 refresh = keccak256("MetadataUpdate(uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            assertTrue(logs[i].topics.length == 0 || logs[i].topics[0] != refresh);
        }
        string memory json = Json.decodeURI(crafters.tokenURI(2));
        assertFalse(vm.keyExistsJson(json, _after(json, 1)));
        vm.prank(owner);
        crafters.setAttributesExtension(address(levels));
        (uint256 level,) = _levelInURI(2);
        assertEq(level, 2);
    }

    // ---------------------------------------------------------------- the collection's side

    function test_SetAttributesExtension() public {
        vm.startPrank(owner);
        vm.expectRevert(MineWorldCrafters.NotAContract.selector);
        crafters.setAttributesExtension(makeAddr("eoa"));
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.AttributesExtensionSet(address(0));
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.BatchMetadataUpdate(1, 4);
        crafters.setAttributesExtension(address(0));
        assertEq(crafters.extraAttributes(1), "");
        // Any extension: its traits follow the built-in ones.
        TwoTraits two = new TwoTraits();
        crafters.setAttributesExtension(address(two));
        vm.stopPrank();
        string memory json = Json.decodeURI(crafters.tokenURI(2));
        assertEq(vm.parseJsonString(json, string.concat(_after(json, 1), ".value")), "Happy");
        assertEq(vm.parseJsonUint(json, string.concat(_after(json, 2), ".value")), 7);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        crafters.setAttributesExtension(address(levels));
    }

    /// Only the extension or the owner asks marketplaces to re-read metadata; ranges are kept to minted Crafters.
    function test_RefreshMetadata() public {
        vm.prank(alice);
        vm.expectRevert(MineWorldCrafters.NotAllowed.selector);
        crafters.refreshMetadata(1, 1);
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.MetadataUpdate(1);
        vm.prank(address(levels));
        crafters.refreshMetadata(1, 1);
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.BatchMetadataUpdate(1, 4);
        vm.prank(owner);
        crafters.refreshMetadata(0, type(uint256).max);
        vm.recordLogs();
        vm.prank(owner);
        crafters.refreshMetadata(9, 20); // nothing minted there: nothing to refresh
        assertEq(vm.getRecordedLogs().length, 0);
    }

    /// An extension that can't be read never breaks the metadata: no extra traits then.
    function test_UnreadableExtensionAddsNothing() public {
        BrokenExtension broken = new BrokenExtension();
        vm.prank(owner);
        crafters.setAttributesExtension(address(broken));
        assertEq(crafters.extraAttributes(1), "");
        string memory json = Json.decodeURI(crafters.tokenURI(1));
        assertFalse(vm.keyExistsJson(json, _after(json, 1)));
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 99));
        crafters.extraAttributes(99);
    }

    // ---------------------------------------------------------------- the owner

    function test_UpgradeCostsAndBurnAreTheOwnersWithinBounds() public {
        vm.startPrank(owner);
        vm.expectRevert(UpgradeCosts.BadCosts.selector);
        levels.setUpgradeCosts(_list(1, 0, 1, 1));
        vm.expectRevert(UpgradeCosts.BadCosts.selector);
        levels.setUpgradeCosts(_list(1, 1, 1, 2_000_000e18 + 1));
        vm.expectEmit(address(levels));
        emit UpgradeCosts.UpgradeCostsSet(_list(2_000_000e18, 1, 2, 3));
        levels.setUpgradeCosts(_list(2_000_000e18, 1, 2, 3));
        vm.expectRevert(MinePayer.BadBurn.selector);
        levels.setUpgradeBurnBps(10_001);
        levels.setUpgradeBurnBps(5_000);
        levels.setUpgradeCosts(_list(100e18, 1, 2, 3));
        vm.stopPrank();
        assertEq(levels.upgradeCost(2), 100e18);
        _upgrade(alice, 1);
        assertEq(token.balanceOf(treasury), 50e18, "half burned, half to the treasury");
        vm.expectRevert(UpgradeCosts.BadLevel.selector);
        levels.upgradeCost(1);
        vm.expectRevert(UpgradeCosts.BadLevel.selector);
        levels.upgradeCost(6);
    }

    function test_TreasuryMoves() public {
        address next = makeAddr("next");
        vm.startPrank(owner);
        vm.expectRevert(MinePayer.ZeroAddress.selector);
        levels.setTreasury(address(0));
        vm.expectRevert(MinePayer.BadTreasury.selector);
        levels.setTreasury(address(levels));
        vm.expectEmit(address(levels));
        emit MinePayer.TreasurySet(next);
        levels.setTreasury(next);
        vm.stopPrank();
        _upgrade(alice, 1);
        assertEq(token.balanceOf(next), COST_2 / 4);
        // Upgrades pay in $MINE only, so a treasury that takes no ETH is fine here (audit 0792975e #4 is MiningSites'
        // and the Crafters').
        address noEth = address(new NoEthTreasury());
        vm.prank(owner);
        levels.setTreasury(noEth);
        _upgrade(alice, 1);
        assertEq(token.balanceOf(noEth), COST_3 / 4);
    }

    /// An upgrade of the code keeps every Crafter's level and the settings; only the owner can make one.
    function test_UpgradeKeepsEveryLevel() public {
        _upgrade(alice, 1);
        _upgrade(alice, 1);
        _upgrade(bob, 4);
        vm.prank(owner);
        levels.addLevel(300_000e18);
        CrafterLevelsV2 v2 = new CrafterLevelsV2();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        levels.upgradeToAndCall(address(v2), "");
        vm.prank(owner);
        levels.upgradeToAndCall(address(v2), "");
        assertEq(CrafterLevelsV2(address(levels)).version(), 2);
        assertEq(levels.levelOf(1), 3);
        assertEq(levels.levelOf(4), 2);
        assertEq(levels.levelOf(2), 1);
        assertEq(levels.maxLevel(), 6);
        assertEq(levels.upgradeCost(6), 300_000e18);
        assertEq(levels.owner(), owner);
        assertEq(levels.treasury(), treasury);
        (uint256 level, uint256 top) = _levelInURI(1);
        assertEq(level, 3);
        assertEq(top, 6);
        _upgrade(alice, 1);
        assertEq(levels.levelOf(1), 4);
    }

    function test_OwnerOnlyAndNoRenounce() public {
        bytes memory unauthorized = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice);
        vm.startPrank(alice);
        vm.expectRevert(unauthorized);
        levels.setUpgradeCosts(_list(1, 1, 1, 1));
        vm.expectRevert(unauthorized);
        levels.setUpgradeBurnBps(0);
        vm.expectRevert(unauthorized);
        levels.addLevel(1);
        vm.expectRevert(unauthorized);
        levels.setTreasury(alice);
        vm.expectRevert(unauthorized);
        levels.renounceOwnership();
        vm.stopPrank();
        vm.prank(owner);
        vm.expectRevert(OwnedUUPS.CannotRenounce.selector);
        levels.renounceOwnership();

        address next = makeAddr("next");
        vm.prank(owner);
        levels.transferOwnership(next);
        assertEq(levels.owner(), owner);
        assertEq(levels.pendingOwner(), next);
        vm.prank(alice);
        vm.expectRevert(unauthorized);
        levels.acceptOwnership();
        vm.prank(next);
        levels.acceptOwnership();
        assertEq(levels.owner(), next);
        vm.prank(next);
        levels.setTreasury(next);
    }
}
