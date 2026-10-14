// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {UpgradeCosts} from "./UpgradeCosts.sol";
import {ICrafterAttributes, ICrafterMetadata} from "./ICrafterAttributes.sol";

/// @title CrafterLevels
/// @notice Levels for MineWorld Crafters, bought with $MINE. Every Crafter starts at level 1; its holder raises it a
///         level at a time for `upgradeCost(level)` (see UpgradeCosts: 75% burned at launch, the rest to the treasury,
///         taken straight from the holder's wallet). The level belongs to the token, so it stays when the Crafter is
///         sold or given away. It shows on marketplaces as the "Level" trait: MineWorldCrafters reads it through
///         `attributesOf` once its owner points it here (`setAttributesExtension`).
///
///         Behind a UUPS proxy: the owner can tune the costs, the burn share, add levels (up to 20, never fewer) and
///         upgrade the code; every Crafter's level carries across upgrades.
/// @dev Trust: the owner sets the costs (1 wei to MAX_UPGRADE_COST each), the burn share and the treasury, adds levels
///      and upgrades the code (so it could change levels in a new version); it never holds anyone's $MINE (payments go
///      straight from the holder's wallet). A cost raised just before an upgrade can't charge more than the holder's
///      `maxCost` (and the game also approves exactly the cost it shows). The owner can hand ownership to a multisig
///      or a timelock (see OwnedUUPS).
contract CrafterLevels is UpgradeCosts, ReentrancyGuardTransient, ICrafterAttributes {
    using Strings for uint256;

    /// @notice The most one level can be set to cost (2,000,000 $MINE).
    uint256 public constant MAX_UPGRADE_COST = 2_000_000e18;

    /// @custom:storage-location erc7201:mineworldcraft.storage.CrafterLevels
    struct LevelsStorage {
        IERC721 crafters;
        /// @dev Each Crafter's level; 0 reads as 1.
        mapping(uint256 tokenId => uint8) levels;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("mineworldcraft.storage.CrafterLevels")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant LEVELS_STORAGE = 0xe0a943f71e53fafb9d333d84c4ad333a9962fba804a4b3a6ad3558ab82f56700;

    /// @param cost $MINE paid for the new level; `burned` of it was burned, the rest went to the treasury.
    event CrafterUpgraded(uint256 indexed tokenId, address indexed holder, uint256 level, uint256 cost, uint256 burned);

    error NotAContract();
    /// @notice Only the Crafter's current holder can upgrade it.
    error NotHolder();

    /// @dev The implementation is only ever used through a proxy.
    constructor() {
        _disableInitializers();
    }

    /// @notice Set up the proxy, with the launch's levels: 2,310, 9,471, 38,831 and 159,207 $MINE to reach levels 2 to
    ///         5 (half a mining site's: about $500 in all at a $50,000 market cap), 75% of each upgrade burned.
    function initialize(IERC20 token_, IERC721 crafters_, address owner_, address treasury_) external initializer {
        __Owned_init(owner_);
        __MinePayer_init(token_, treasury_);
        uint256[] memory costs = new uint256[](4);
        (costs[0], costs[1], costs[2], costs[3]) = (2_310e18, 9_471e18, 38_831e18, 159_207e18);
        __UpgradeCosts_init(costs, 7_500);
        if (address(token_).code.length == 0 || address(crafters_).code.length == 0) revert NotAContract();
        _levelsStorage().crafters = crafters_;
    }

    function _levelsStorage() private pure returns (LevelsStorage storage $) {
        assembly {
            $.slot := LEVELS_STORAGE
        }
    }

    function _maxUpgradeCost() internal pure override returns (uint256) {
        return MAX_UPGRADE_COST;
    }

    /// @notice MineWorld Crafters.
    function crafters() public view returns (IERC721) {
        return _levelsStorage().crafters;
    }

    /// @notice A Crafter's level: 1 to maxLevel() (1 until it's upgraded).
    function levelOf(uint256 tokenId) public view returns (uint256) {
        uint256 level = _levelsStorage().levels[tokenId];
        return level == 0 ? 1 : level;
    }

    /// @notice Raise Crafter `tokenId`, which you hold, one level (up to maxLevel()) for `upgradeCost(level)` $MINE
    ///         from your wallet: the burn share burned, the rest to the treasury. Reverts `CostAboveMax` if that's
    ///         more than `maxCost` (pass the cost you were shown: a cost raised meanwhile then fails instead of
    ///         charging more, whatever you approved). Approve this contract for exactly that much first.
    function upgrade(uint256 tokenId, uint256 maxCost) external nonReentrant returns (uint256 level) {
        LevelsStorage storage $ = _levelsStorage();
        if ($.crafters.ownerOf(tokenId) != msg.sender) revert NotHolder();
        uint256 cost;
        (level, cost) = _nextLevel(levelOf(tokenId), maxCost);
        $.levels[tokenId] = uint8(level);
        emit CrafterUpgraded(tokenId, msg.sender, level, cost, _burnShare(cost));
        _payUpgrade(msg.sender, cost);
        _refresh(tokenId, tokenId);
    }

    /// @notice A new top level, reached for `cost` $MINE (1 wei to MAX_UPGRADE_COST). Up to MAX_LEVELS; levels are
    ///         never removed. Every Crafter's "Level" trait shows the new top.
    function addLevel(uint256 cost) external onlyOwner returns (uint256 level) {
        level = _addLevel(cost);
        _refresh(1, type(uint256).max);
    }

    /// @notice The "Level" trait MineWorldCrafters adds to the Crafter's metadata: its level, out of maxLevel().
    function attributesOf(uint256 tokenId) external view returns (string memory) {
        return string.concat(
            '{"trait_type":"Level","value":',
            levelOf(tokenId).toString(),
            ',"max_value":',
            maxLevel().toString(),
            "}"
        );
    }

    /// @dev Tell marketplaces to re-read these Crafters (ERC-4906). Only works while the collection points here, and a
    ///      refresh is never worth failing for.
    function _refresh(uint256 fromTokenId, uint256 toTokenId) private {
        try ICrafterMetadata(address(_levelsStorage().crafters)).refreshMetadata(fromTokenId, toTokenId) {} catch {}
    }
}
