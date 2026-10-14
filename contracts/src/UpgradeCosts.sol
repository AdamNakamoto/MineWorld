// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MinePayer} from "./MinePayer.sol";

/// @title UpgradeCosts
/// @notice Levels bought with $MINE (mining sites in MiningSites, Crafters in CrafterLevels): what each level costs and
///         how the payment is split (see MinePayer: `upgradeBurnBps` of it burned, 75% at launch, the rest to the
///         treasury). Levels start at 1; `upgradeCost(level)` is the price of reaching `level` from the one below.
///
///         The owner tunes it from players' feedback: the costs (each 1 wei to MAX_UPGRADE_COST, fixed per
///         contract), the burn share (0% to 100%), and more levels on top (up to MAX_LEVELS, never fewer: a level
///         once bought is never taken away). Every upgrade names the most it will pay (`maxCost`): a cost raised by a
///         change mined just before it makes it revert (`CostAboveMax`) instead of charging more, whatever the wallet
///         approved. The game passes the cost it shows, and approves exactly that much too.
/// @dev State in ERC-7201 namespaced storage.
abstract contract UpgradeCosts is MinePayer {
    /// @notice The most levels there can ever be.
    uint256 public constant MAX_LEVELS = 20;

    /// @custom:storage-location erc7201:mineworldcraft.storage.UpgradeCosts
    struct UpgradeCostsStorage {
        /// @dev costs[i]: the cost of reaching level i + 2.
        uint256[] costs;
        uint16 burnBps;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("mineworldcraft.storage.UpgradeCosts")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant UPGRADE_COSTS_STORAGE = 0x7f4940bc0a1f6d9e3488faac330c723b9928c3808d99c502b6421ef23cc88f00;

    /// @param costs the costs of reaching levels 2, 3, ... maxLevel()
    event UpgradeCostsSet(uint256[] costs);
    event LevelAdded(uint256 level, uint256 cost);
    event UpgradeBurnSet(uint256 burnBps);

    /// @notice A cost is 0 or above MAX_UPGRADE_COST, or there isn't one for each level above 1.
    error BadCosts();
    /// @notice There's no upgrade to that level (only to 2 through maxLevel()).
    error BadLevel();
    /// @notice Already at the top level.
    error MaxLevel();
    /// @notice MAX_LEVELS levels already.
    error TooManyLevels();
    /// @notice The next level costs more than the most the caller agreed to pay (the cost changed meanwhile).
    error CostAboveMax(uint256 cost, uint256 maxCost);

    function _costs() private pure returns (UpgradeCostsStorage storage $) {
        assembly {
            $.slot := UPGRADE_COSTS_STORAGE
        }
    }

    /// @dev The most one level can be set to cost (MAX_UPGRADE_COST).
    function _maxUpgradeCost() internal pure virtual returns (uint256);

    function __UpgradeCosts_init(uint256[] memory costs, uint256 burnBps) internal onlyInitializing {
        _setCosts(costs, costs.length);
        _setBurn(burnBps);
    }

    /// @notice The top level (the levels are 1 to this).
    function maxLevel() public view returns (uint256) {
        return _costs().costs.length + 1;
    }

    /// @notice What reaching `level` (2 to maxLevel()) from the level below costs, in $MINE wei.
    function upgradeCost(uint256 level) public view returns (uint256) {
        uint256[] storage costs = _costs().costs;
        if (level < 2 || level > costs.length + 1) revert BadLevel();
        return costs[level - 2];
    }

    /// @notice The costs of reaching levels 2, 3, ... maxLevel(), in $MINE wei.
    function upgradeCosts() external view returns (uint256[] memory) {
        return _costs().costs;
    }

    /// @notice The share of each upgrade payment burned, in basis points (the rest goes to the treasury).
    function upgradeBurnBps() public view returns (uint256) {
        return _costs().burnBps;
    }

    /// @notice Change the costs of reaching levels 2, 3, ... maxLevel() (one for each, 1 wei to MAX_UPGRADE_COST).
    ///         Levels already bought stay.
    function setUpgradeCosts(uint256[] calldata costs) external onlyOwner {
        _setCosts(costs, _costs().costs.length);
    }

    /// @notice The share of each upgrade payment burned, 0 to 10,000 basis points (100%).
    function setUpgradeBurnBps(uint256 burnBps) external onlyOwner {
        _setBurn(burnBps);
    }

    function _setCosts(uint256[] memory costs, uint256 count) private {
        if (costs.length != count || count + 1 > MAX_LEVELS) revert BadCosts();
        for (uint256 i; i < costs.length; ++i) {
            _checkCost(costs[i]);
        }
        _costs().costs = costs;
        emit UpgradeCostsSet(costs);
    }

    function _setBurn(uint256 burnBps) private {
        _checkBurn(burnBps);
        _costs().burnBps = uint16(burnBps);
        emit UpgradeBurnSet(burnBps);
    }

    function _checkCost(uint256 cost) private pure {
        if (cost == 0 || cost > _maxUpgradeCost()) revert BadCosts();
    }

    /// @dev A new top level, reached for `cost`.
    function _addLevel(uint256 cost) internal returns (uint256 level) {
        uint256[] storage costs = _costs().costs;
        if (costs.length + 1 >= MAX_LEVELS) revert TooManyLevels();
        _checkCost(cost);
        costs.push(cost);
        level = costs.length + 1;
        emit LevelAdded(level, cost);
    }

    /// @dev The level after `level`, and what reaching it costs (reverts at the top, and if that's above `maxCost`).
    function _nextLevel(uint256 level, uint256 maxCost) internal view returns (uint256 next, uint256 cost) {
        next = level + 1;
        if (next > maxLevel()) revert MaxLevel();
        cost = _costs().costs[next - 2];
        if (cost > maxCost) revert CostAboveMax(cost, maxCost);
    }

    /// @dev Takes `cost` from `payer`: the burn share burned, the rest to the treasury.
    function _payUpgrade(address payer, uint256 cost) internal returns (uint256 burned) {
        return _collect(payer, cost, _costs().burnBps);
    }

    /// @dev The part of `cost` an upgrade burns now.
    function _burnShare(uint256 cost) internal view returns (uint256) {
        return cost * _costs().burnBps / BPS;
    }
}
