// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {MinePayer} from "./MinePayer.sol";

/// @title MinePayments
/// @notice What players pay the game in $MINE: the shop, tickets, and whatever kinds come later. `pay` takes the
///         amount from the player's wallet (with their approval), burns the kind's burn share and sends the rest to
///         the treasury (see MinePayer), and records it in a `Paid` event with the game's reference, which the game's
///         server checks before it hands over what was bought. Prices live in the game's own config, not here, so
///         they change without touching the chain.
///
///         Kinds at launch: 0 "shop" (75% burned), 1 "ticket" and 2 "revive" (a revive on the spot after dying on the
///         home planet; both burn nothing: all to the treasury). The owner can change a kind's burn share (0% to 100%)
///         and add kinds (up to MAX_KINDS); kinds are never removed.
/// @dev Behind a UUPS proxy (see OwnedUUPS); state in ERC-7201 namespaced storage. Trust: the owner sets the burn
///      shares and the treasury and can upgrade the code; this contract never holds anyone's $MINE (payments go
///      straight from the player's wallet). A player approves exactly what they pay.
contract MinePayments is MinePayer, ReentrancyGuardTransient {
    /// @notice The most kinds there can be.
    uint256 public constant MAX_KINDS = 32;
    uint256 public constant KIND_SHOP = 0;
    uint256 public constant KIND_TICKET = 1;
    uint256 public constant KIND_REVIVE = 2;

    struct Kind {
        string name;
        uint16 burnBps;
    }

    /// @custom:storage-location erc7201:mineworldcraft.storage.MinePayments
    struct PaymentsStorage {
        Kind[] kinds;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("mineworldcraft.storage.MinePayments")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant PAYMENTS_STORAGE = 0xba35f12e5ac9557c7ad18bdb329ca09fcdbd411d9cbd7d9c10a0623b3b0df300;

    /// @param amount $MINE paid; `burned` of it was burned, the rest went to the treasury
    /// @param ref the game's reference for what was bought (an order id)
    event Paid(address indexed player, uint256 indexed kind, uint256 amount, uint256 burned, bytes32 indexed ref);
    event KindAdded(uint256 indexed kind, string name, uint256 burnBps);
    event KindBurnSet(uint256 indexed kind, uint256 burnBps);

    error NoSuchKind();
    error ZeroAmount();
    /// @notice A kind's name must be 1 to 32 bytes.
    error BadName();
    error TooManyKinds();

    /// @dev The implementation is only ever used through a proxy.
    constructor() {
        _disableInitializers();
    }

    /// @notice Set up the proxy, with the launch's kinds: "shop" (75% burned), "ticket" and "revive" (all to the
    ///         treasury). Only in the proxy's own constructor (OwnedUUPS: `InitializeOutsideConstructor`), never later,
    ///         by anyone.
    function initialize(IERC20 token_, address owner_, address treasury_) external initializer {
        __Owned_init(owner_);
        __MinePayer_init(token_, treasury_);
        _addKind("shop", 7_500);
        _addKind("ticket", 0);
        _addKind("revive", 0);
    }

    function _payments() private pure returns (PaymentsStorage storage $) {
        assembly {
            $.slot := PAYMENTS_STORAGE
        }
    }

    /// @notice Pay `amount` $MINE for something of kind `kindIndex` the game sells, under the game's reference
    ///         `ref`. Approve this contract for exactly `amount` first.
    function pay(uint256 kindIndex, uint256 amount, bytes32 ref) external nonReentrant returns (uint256 burned) {
        Kind[] storage kinds = _payments().kinds;
        if (kindIndex >= kinds.length) revert NoSuchKind();
        if (amount == 0) revert ZeroAmount();
        burned = _collect(msg.sender, amount, kinds[kindIndex].burnBps);
        emit Paid(msg.sender, kindIndex, amount, burned, ref);
    }

    function kindCount() external view returns (uint256) {
        return _payments().kinds.length;
    }

    /// @notice A kind's name and burn share (basis points).
    function kind(uint256 index) external view returns (string memory name, uint256 burnBps) {
        Kind[] storage kinds = _payments().kinds;
        if (index >= kinds.length) revert NoSuchKind();
        return (kinds[index].name, kinds[index].burnBps);
    }

    /// @notice A new kind of payment, with its burn share (0 to 10,000 basis points). Returns its number.
    function addKind(string calldata name, uint256 burnBps) external onlyOwner returns (uint256) {
        return _addKind(name, burnBps);
    }

    /// @notice Change a kind's burn share (0 to 10,000 basis points).
    function setKindBurn(uint256 index, uint256 burnBps) external onlyOwner {
        Kind[] storage kinds = _payments().kinds;
        if (index >= kinds.length) revert NoSuchKind();
        _checkBurn(burnBps);
        kinds[index].burnBps = uint16(burnBps);
        emit KindBurnSet(index, burnBps);
    }

    function _addKind(string memory name, uint256 burnBps) private returns (uint256 index) {
        Kind[] storage kinds = _payments().kinds;
        if (kinds.length >= MAX_KINDS) revert TooManyKinds();
        if (bytes(name).length == 0 || bytes(name).length > 32) revert BadName();
        _checkBurn(burnBps);
        index = kinds.length;
        kinds.push(Kind(name, uint16(burnBps)));
        emit KindAdded(index, name, burnBps);
    }
}
