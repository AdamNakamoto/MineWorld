// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MineToken} from "./MineToken.sol";

/// @notice What the vault reads from a distributor before it takes over: who owns it, which vault it pays from, and
///         which distributor it follows (whose books it carries over: MiningSites imports each player's site, settled
///         and claimed from it).
interface IDistributor {
    function owner() external view returns (address);
    function vault() external view returns (address);
    function predecessor() external view returns (address);
}

/// @title MineVault
/// @notice The mining vault: $MINE's one minter (MineToken.setMinter, set once at deploy), kept apart from the game's
///         rules, which can change. It holds nothing: it mints $MINE straight to players as they claim what they
///         earned, and only when its distributor (MiningSites, the rules) asks, never more than DAILY_LIMIT (35,000) in
///         a UTC day and never more than TOTAL_LIMIT (10,500,000, the 21M cap less the pool's launch allocation) in
///         all, whoever the distributor is. 35,000 a day is the 10,500,000 over 300 days: it can never all be minted in
///         less. No one else can make it mint, the owner included.
///
///         The first distributor is named at deploy (MiningSites' proxy, deployed right after the vault). The owner
///         can only replace it in the open: `proposeDistributor`, then `acceptDistributor` at least
///         DISTRIBUTOR_DELAY (2 days) later, so players see a change coming. Only a contract that names this vault's
///         owner as its owner, this vault as its vault, and the current distributor as its predecessor can take over.
///
///         Replacing MiningSites with a new proxy, step by step:
///         1. Deploy the new implementation (its constructor locks it).
///         2. `proposeDistributor(P)`, where P is the address the new ERC1967Proxy will get (for a wallet, its next
///            CREATE address: nothing need be there yet).
///         3. Deploy the proxy at P with `initialize` in its constructor, naming this vault and this vault's owner.
///            MiningSites.initialize accepts this vault's pending distributor as well as its distributor, but only in
///            the proxy's own constructor or from this vault's owner, so nobody else can ever set a proxy up; it
///            records the current distributor as its predecessor and imports each player's books from it.
///         4. Two days later, `acceptDistributor()`: it checks P has code, and that P's `owner()` is this vault's
///            owner, P's `vault()` this vault and P's `predecessor()` the current distributor, and reverts otherwise
///            (then propose again). A pending distributor can't mint: only `distributor` can.
/// @dev Not upgradeable and not a proxy, on purpose: this and the token are the parts that stay fixed. Trust, plainly:
///      the distributor decides who is paid (within the limits), so a bad distributor could mint up to 35,000 a day to
///      whomever it likes; that is no more than an owner who made itself MiningSites' signer could already take. The
///      owner can hand ownership to a multisig or a timelock (two steps; it can't be renounced, so a distributor can
///      always be replaced).
contract MineVault is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The most $MINE that can be minted in a UTC day: TOTAL_LIMIT over 300 days. Fixed forever.
    uint256 public constant DAILY_LIMIT = 35_000e18;
    /// @notice The most $MINE this vault can ever mint: half the 21M supply (the other half is the pool's).
    uint256 public constant TOTAL_LIMIT = 10_500_000e18;
    /// @notice How long a proposed distributor waits before it can take over.
    uint256 public constant DISTRIBUTOR_DELAY = 2 days;

    /// @notice $MINE.
    MineToken public immutable token;

    /// @notice The one contract that can ask for $MINE (MiningSites).
    address public distributor;
    /// @notice A distributor proposed by the owner, and when it can take over.
    address public pendingDistributor;
    uint256 public pendingReadyAt;
    /// @notice $MINE minted by the vault so far, in all.
    uint256 public released;

    /// @dev What was minted on `_day`; a record from an earlier day reads as nothing minted today.
    uint64 internal _day;
    uint192 internal _today;

    event Released(address indexed distributor, address indexed to, uint256 amount, uint256 releasedToday);
    event DistributorProposed(address indexed distributor, uint256 readyAt);
    event DistributorProposalCancelled(address indexed distributor);
    event DistributorSet(address indexed previous, address indexed distributor);
    event Swept(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error NotAContract();
    /// @notice The proposed distributor isn't owned by this vault's owner (or doesn't say who owns it): an
    ///         uninitialised or hijacked proxy, say. It can't take over.
    error NotOwnersDistributor();
    /// @notice The proposed distributor pays from another vault, or doesn't say which.
    error WrongVault();
    /// @notice The proposed distributor doesn't follow the current one (its `predecessor()`), so it wouldn't carry
    ///         the players' books over.
    error NotASuccessor();
    /// @notice Only the distributor can have $MINE minted.
    error NotDistributor();
    /// @notice The mint would take today past DAILY_LIMIT.
    error OverDailyLimit();
    /// @notice The mint would take the vault past TOTAL_LIMIT.
    error OverTotalLimit();
    /// @notice The token has already minted more than its cap leaves for the vault's TOTAL_LIMIT.
    error BadToken();
    error NoProposal();
    /// @notice DISTRIBUTOR_DELAY hasn't passed since the proposal.
    error TooEarly();
    /// @notice Ownership can only be handed over (two-step), never renounced.
    error CannotRenounce();

    /// @param token_ $MINE, with only its launch allocation minted, so all of TOTAL_LIMIT fits under its cap. The
    ///        token's owner then makes this vault its minter and renounces.
    /// @param distributor_ The first distributor: MiningSites' proxy, deployed right after this, so a predicted
    ///        address the deploy script checks.
    constructor(MineToken token_, address owner_, address distributor_) Ownable(owner_) {
        if (address(token_) == address(0) || distributor_ == address(0)) revert ZeroAddress();
        if (token_.totalMinted() + TOTAL_LIMIT > token_.MAX_SUPPLY()) revert BadToken();
        token = token_;
        distributor = distributor_;
        emit DistributorSet(address(0), distributor_);
    }

    // ---------------------------------------------------------------- minting

    /// @notice Mint `amount` $MINE to `to` (a player claiming what they earned); only the distributor can ask, within
    ///         today's limit and the vault's total.
    function release(address to, uint256 amount) external nonReentrant {
        if (msg.sender != distributor) revert NotDistributor();
        uint64 day = uint64(block.timestamp / 1 days);
        uint256 today_ = (_day == day ? _today : 0) + amount;
        if (today_ > DAILY_LIMIT) revert OverDailyLimit();
        uint256 total = released + amount;
        if (total > TOTAL_LIMIT) revert OverTotalLimit();
        (_day, _today) = (day, uint192(today_));
        released = total;
        emit Released(msg.sender, to, amount, today_);
        token.mint(to, amount);
    }

    /// @notice $MINE minted today (UTC), by any distributor.
    function releasedToday() public view returns (uint256) {
        return _day == uint64(block.timestamp / 1 days) ? _today : 0;
    }

    /// @notice $MINE the vault can still mint, in all.
    function remaining() public view returns (uint256) {
        return TOTAL_LIMIT - released;
    }

    /// @notice $MINE that can still be minted today: the rest of the daily limit, or of the total if that's less.
    function roomToday() external view returns (uint256 room) {
        room = DAILY_LIMIT - releasedToday();
        uint256 left = remaining();
        if (left < room) room = left;
    }

    // ---------------------------------------------------------------- the distributor

    /// @notice Propose a new distributor (a new rules contract); it can take over DISTRIBUTOR_DELAY from now. A new
    ///         proposal replaces the last one and restarts the wait. It needn't exist yet: propose a proxy's predicted
    ///         address, then deploy it initialised (see the steps above); `acceptDistributor` checks it.
    function proposeDistributor(address distributor_) external onlyOwner {
        if (distributor_ == address(0)) revert ZeroAddress();
        pendingDistributor = distributor_;
        pendingReadyAt = block.timestamp + DISTRIBUTOR_DELAY;
        emit DistributorProposed(distributor_, pendingReadyAt);
    }

    function cancelDistributor() external onlyOwner {
        address pending = pendingDistributor;
        if (pending == address(0)) revert NoProposal();
        delete pendingDistributor;
        delete pendingReadyAt;
        emit DistributorProposalCancelled(pending);
    }

    /// @notice Make the proposed distributor the distributor, once its wait is over, if it is a contract whose
    ///         `owner()` is this vault's owner, whose `vault()` is this vault and whose `predecessor()` is the current
    ///         distributor. An uninitialised proxy is refused, and none can be set up by anyone but this vault's owner
    ///         (see MiningSites.initialize). The limits carry over: what the old one had minted today counts against
    ///         the new one.
    function acceptDistributor() external onlyOwner {
        address pending = pendingDistributor;
        if (pending == address(0)) revert NoProposal();
        if (block.timestamp < pendingReadyAt) revert TooEarly();
        if (pending.code.length == 0) revert NotAContract();
        if (_read(pending, IDistributor.owner.selector) != owner()) revert NotOwnersDistributor();
        if (_read(pending, IDistributor.vault.selector) != address(this)) revert WrongVault();
        if (_read(pending, IDistributor.predecessor.selector) != distributor) revert NotASuccessor();
        emit DistributorSet(distributor, pending);
        distributor = pending;
        delete pendingDistributor;
        delete pendingReadyAt;
    }

    /// @dev An address `target` returns for the view `selector` (one word, an address); 0 if the call fails or
    ///      answers anything else, which never matches what the vault expects.
    function _read(address target, bytes4 selector) private view returns (address) {
        (bool ok, bytes memory data) = target.staticcall(abi.encodePacked(selector));
        if (!ok || data.length != 32) return address(0);
        uint256 word = abi.decode(data, (uint256));
        return word >> 160 == 0 ? address(uint160(word)) : address(0);
    }

    // ---------------------------------------------------------------- the owner

    /// @notice Send a token that reached the vault by mistake to `to` (the vault never holds anything of its own).
    function sweep(IERC20 token_, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = token_.balanceOf(address(this));
        token_.safeTransfer(to, amount);
        emit Swept(address(token_), to, amount);
    }

    /// @notice Ownership can't be renounced: the distributor must stay replaceable.
    function renounceOwnership() public view override onlyOwner {
        revert CannotRenounce();
    }
}
