// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {OwnedUUPS} from "./lib/OwnedUUPS.sol";

/// @notice $MINE's burn (MineToken is ERC20Burnable).
interface IBurnableMine {
    function burnFrom(address account, uint256 value) external;
}

/// @title MinePayer
/// @notice How MineWorldCraft takes $MINE for what players buy (upgrades in MiningSites and CrafterLevels, the game's
///         shop and tickets in MinePayments): part of each payment is burned and the rest goes to the treasury, both
///         taken straight from the player's wallet (with their approval). The $MINE paid never passes through, or
///         mixes with anything held by, the contract that takes it, and never touches the mining vault.
/// @dev Upgradeable (see OwnedUUPS); state in ERC-7201 namespaced storage.
abstract contract MinePayer is OwnedUUPS {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;

    /// @custom:storage-location erc7201:mineworldcraft.storage.MinePayer
    struct MinePayerStorage {
        IERC20 token;
        address treasury;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("mineworldcraft.storage.MinePayer")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant MINE_PAYER_STORAGE = 0x74f15e19b025ca7fea1f6b3ca559dc8a3a24b77e2e16e24020a165c023c82d00;

    event TreasurySet(address indexed treasury);

    error ZeroAddress();
    /// @notice The treasury can't be this contract ($MINE sent here would be stuck, and it refuses ETH).
    error BadTreasury();
    /// @notice A burn share above 100%.
    error BadBurn();

    function _payer() private pure returns (MinePayerStorage storage $) {
        assembly {
            $.slot := MINE_PAYER_STORAGE
        }
    }

    function __MinePayer_init(IERC20 token_, address treasury_) internal onlyInitializing {
        if (address(token_) == address(0)) revert ZeroAddress();
        _payer().token = token_;
        _setTreasury(treasury_);
    }

    /// @notice $MINE.
    function token() public view returns (IERC20) {
        return _payer().token;
    }

    /// @notice Where what isn't burned goes.
    function treasury() public view returns (address) {
        return _payer().treasury;
    }

    function setTreasury(address treasury_) external onlyOwner {
        _setTreasury(treasury_);
    }

    function _setTreasury(address treasury_) private {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(this)) revert BadTreasury();
        _payer().treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function _checkBurn(uint256 burnBps) internal pure {
        if (burnBps > BPS) revert BadBurn();
    }

    /// @dev Takes `amount` $MINE from `payer`, who approved this contract for it: burns `burnBps` of it (rounded down)
    ///      from the payer's wallet and moves the rest from that wallet to the treasury.
    function _collect(address payer, uint256 amount, uint256 burnBps) internal returns (uint256 burned) {
        IERC20 mine = _payer().token;
        burned = amount * burnBps / BPS;
        if (burned != 0) IBurnableMine(address(mine)).burnFrom(payer, burned);
        if (amount != burned) mine.safeTransferFrom(payer, _payer().treasury, amount - burned);
    }
}
