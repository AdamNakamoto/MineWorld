// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

/// @title OwnedUUPS
/// @notice The owner of an upgradeable MineWorldCraft contract, behind a UUPS proxy (ERC-1967): the owner alone can
///         upgrade it and change its settings. Ownership moves in two steps (`transferOwnership`, then
///         `acceptOwnership` by the new owner), so a typo can't lose it, and can't be renounced, so the settings
///         and the code stay manageable. The owner can be handed to a multisig or a timelock at any time, which then
///         puts every upgrade and setting behind its signers or its delay.
/// @dev OpenZeppelin's Ownable2Step, with its state in ERC-7201 namespaced storage (OpenZeppelin's own upgradeable
///      package isn't installed here). Same events and errors, so tools and tests read it the same way.
abstract contract OwnedUUPS is Initializable, UUPSUpgradeable {
    /// @custom:storage-location erc7201:mineworldcraft.storage.Owned
    struct OwnedStorage {
        address owner;
        address pendingOwner;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("mineworldcraft.storage.Owned")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant OWNED_STORAGE = 0xf76a6bf6b01b1456d605310624268399969c1df982b72809888831a00ceb4b00;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error OwnableUnauthorizedAccount(address account);
    error OwnableInvalidOwner(address owner);
    /// @notice Ownership can only be handed over (two-step), never renounced.
    error CannotRenounce();

    modifier onlyOwner() {
        if (msg.sender != _owned().owner) revert OwnableUnauthorizedAccount(msg.sender);
        _;
    }

    function _owned() private pure returns (OwnedStorage storage $) {
        assembly {
            $.slot := OWNED_STORAGE
        }
    }

    function __Owned_init(address owner_) internal onlyInitializing {
        if (owner_ == address(0)) revert OwnableInvalidOwner(address(0));
        _owned().owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function owner() public view returns (address) {
        return _owned().owner;
    }

    function pendingOwner() public view returns (address) {
        return _owned().pendingOwner;
    }

    /// @notice Start handing ownership to `newOwner` (a multisig or a timelock, say); it takes over once it accepts.
    function transferOwnership(address newOwner) external onlyOwner {
        _owned().pendingOwner = newOwner;
        emit OwnershipTransferStarted(msg.sender, newOwner);
    }

    function acceptOwnership() external {
        OwnedStorage storage $ = _owned();
        if (msg.sender != $.pendingOwner) revert OwnableUnauthorizedAccount(msg.sender);
        emit OwnershipTransferred($.owner, msg.sender);
        $.owner = msg.sender;
        $.pendingOwner = address(0);
    }

    /// @notice Ownership can't be renounced: the settings and the code must stay manageable.
    function renounceOwnership() external view onlyOwner {
        revert CannotRenounce();
    }

    /// @dev Only the owner upgrades (UUPSUpgradeable.upgradeToAndCall).
    function _authorizeUpgrade(address) internal view override onlyOwner {}
}
