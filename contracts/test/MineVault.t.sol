// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, stdStorage, StdStorage} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MineToken} from "../src/MineToken.sol";
import {MineVault} from "../src/MineVault.sol";

/// Stands in for MiningSites: asks the vault to mint. Owned by the vault's owner once wired (as a MiningSites proxy
/// initialised for that vault is), or by whoever `setOwner` names.
contract MockDistributor {
    MineVault public vault;
    address public owner;

    function setVault(MineVault v) external {
        vault = v;
        owner = v.owner();
    }

    function setOwner(address o) external {
        owner = o;
    }

    function pay(address to, uint256 amount) external {
        vault.release(to, amount);
    }
}

contract Stray is ERC20 {
    constructor(address to) ERC20("Stray", "STR") {
        _mint(to, 5e18);
    }
}

/// The token and the vault as the deploy script leaves them: the vault the one minter, the token renounced.
abstract contract VaultFixture is Test {
    uint256 constant LAUNCH = 10_500_000e18;

    function _vault(address owner, address distributor, address pool) internal returns (MineToken token, MineVault vault) {
        token = new MineToken(address(this), pool, LAUNCH);
        vault = new MineVault(token, owner, distributor);
        token.setMinter(address(vault));
        token.renounceOwnership();
    }
}

contract MineVaultTest is VaultFixture {
    using stdStorage for StdStorage;

    MineToken token;
    MineVault vault;
    MockDistributor sites;
    MockDistributor next;
    address owner = makeAddr("owner");
    address pool = makeAddr("pool");
    address alice = makeAddr("alice");

    function setUp() public {
        vm.warp(20_000 days + 12 hours);
        sites = new MockDistributor();
        next = new MockDistributor();
        (token, vault) = _vault(owner, address(sites), pool);
        sites.setVault(vault);
        next.setVault(vault);
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    /// @dev External, so `vm.expectRevert` checks this constructor call.
    function newVault(MineToken t, address o, address d) external returns (address) {
        return address(new MineVault(t, o, d));
    }

    function test_DeployedAsSpecified() public view {
        assertEq(address(vault.token()), address(token));
        assertEq(vault.owner(), owner);
        assertEq(vault.distributor(), address(sites));
        assertEq(vault.DAILY_LIMIT(), 35_000e18);
        assertEq(vault.TOTAL_LIMIT(), 10_500_000e18);
        assertEq(vault.DISTRIBUTOR_DELAY(), 2 days);
        assertEq(vault.released(), 0);
        assertEq(vault.remaining(), 10_500_000e18);
        assertEq(vault.roomToday(), 35_000e18);
        assertEq(token.minter(), address(vault));
        assertEq(token.balanceOf(address(vault)), 0, "the vault holds nothing: it mints on demand");
    }

    /// The 300-day promise: the daily limit mints the vault's whole share in exactly 300 days, never sooner.
    function test_ThreeHundredDays() public view {
        assertEq(vault.DAILY_LIMIT() * 300, vault.TOTAL_LIMIT());
        assertEq(vault.TOTAL_LIMIT(), 10_500_000e18);
        assertEq(vault.TOTAL_LIMIT(), token.MAX_SUPPLY() - LAUNCH);
    }

    function test_ConstructorChecks() public {
        vm.expectRevert(MineVault.ZeroAddress.selector);
        this.newVault(MineToken(address(0)), owner, address(sites));
        vm.expectRevert(MineVault.ZeroAddress.selector);
        this.newVault(token, owner, address(0));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        this.newVault(token, address(0), address(sites));
        // A token that minted more than its launch allocation leaves no room for the vault's whole share.
        MineToken greedy = new MineToken(address(this), pool, LAUNCH + 1);
        vm.expectRevert(MineVault.BadToken.selector);
        this.newVault(greedy, owner, address(sites));
    }

    function test_OnlyTheDistributorMints() public {
        vm.prank(owner);
        vm.expectRevert(MineVault.NotDistributor.selector);
        vault.release(owner, 1);
        vm.prank(alice);
        vm.expectRevert(MineVault.NotDistributor.selector);
        vault.release(alice, 1);
        vm.expectRevert(MineVault.NotDistributor.selector);
        next.pay(alice, 1);
        vm.expectEmit(address(vault));
        emit MineVault.Released(address(sites), alice, 1_000e18, 1_000e18);
        sites.pay(alice, 1_000e18);
        assertEq(token.balanceOf(alice), 1_000e18);
        assertEq(vault.released(), 1_000e18);
        assertEq(token.totalMinted(), LAUNCH + 1_000e18);
        // Nobody else can mint at all: the token is renounced and its one minter is the vault.
        vm.prank(alice);
        vm.expectRevert(MineToken.NotMinter.selector);
        token.mint(alice, 1);
    }

    function test_DailyLimit() public {
        sites.pay(alice, 20_000e18);
        sites.pay(alice, 15_000e18);
        assertEq(vault.releasedToday(), 35_000e18);
        assertEq(vault.roomToday(), 0);
        vm.expectRevert(MineVault.OverDailyLimit.selector);
        sites.pay(alice, 1);
        // A new UTC day: a new 35,000.
        vm.warp((_now() / 1 days + 1) * 1 days);
        assertEq(vault.releasedToday(), 0);
        vm.expectRevert(MineVault.OverDailyLimit.selector);
        sites.pay(alice, 35_000e18 + 1);
        sites.pay(alice, 35_000e18);
        assertEq(vault.released(), 70_000e18);
    }

    function test_TotalLimit() public {
        stdstore.target(address(vault)).sig("released()").checked_write(10_500_000e18 - 500e18);
        assertEq(vault.remaining(), 500e18);
        assertEq(vault.roomToday(), 500e18);
        vm.expectRevert(MineVault.OverTotalLimit.selector);
        sites.pay(alice, 501e18);
        sites.pay(alice, 500e18);
        assertEq(vault.remaining(), 0);
        vm.warp(_now() + 1 days);
        vm.expectRevert(MineVault.OverTotalLimit.selector);
        sites.pay(alice, 1);
    }

    /// A new distributor only takes over two days after it's proposed, in the open; the limits carry over.
    function test_DistributorChangeWaitsTwoDays() public {
        vm.startPrank(owner);
        vm.expectRevert(MineVault.NoProposal.selector);
        vault.acceptDistributor();
        vm.expectRevert(MineVault.ZeroAddress.selector);
        vault.proposeDistributor(address(0));
        vm.expectEmit(address(vault));
        emit MineVault.DistributorProposed(address(next), _now() + 2 days);
        vault.proposeDistributor(address(next));
        assertEq(vault.pendingDistributor(), address(next));
        assertEq(vault.pendingReadyAt(), _now() + 2 days);
        vm.warp(_now() + 2 days - 1);
        vm.expectRevert(MineVault.TooEarly.selector);
        vault.acceptDistributor();
        vm.stopPrank();

        // Meanwhile the old one still mints, and the new one can't.
        sites.pay(alice, 30_000e18);
        vm.expectRevert(MineVault.NotDistributor.selector);
        next.pay(alice, 1);

        vm.warp(_now() + 1);
        vm.expectEmit(address(vault));
        emit MineVault.DistributorSet(address(sites), address(next));
        vm.prank(owner);
        vault.acceptDistributor();
        assertEq(vault.distributor(), address(next));
        assertEq(vault.pendingDistributor(), address(0));
        vm.expectRevert(MineVault.NotDistributor.selector);
        sites.pay(alice, 1);
        // Today's 30,000 count against the new one: only 5,000 more today.
        vm.expectRevert(MineVault.OverDailyLimit.selector);
        next.pay(alice, 5_000e18 + 1);
        next.pay(alice, 5_000e18);
    }

    /// Audit 0792975e #2: a distributor can be proposed before it exists (a proxy's predicted address), but only a
    /// contract owned by the vault's owner can take over: never an empty address, an uninitialised proxy (no owner)
    /// or one someone else set up.
    function test_OnlyAContractTheOwnerOwnsTakesOver() public {
        // Proposed before it exists: fine. Accepted while it still doesn't: refused.
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.prank(owner);
        vault.proposeDistributor(predicted);
        assertEq(vault.pendingDistributor(), predicted);
        vm.warp(_now() + 2 days);
        vm.prank(owner);
        vm.expectRevert(MineVault.NotAContract.selector);
        vault.acceptDistributor();

        // Deployed there, but owned by nobody (as an uninitialised proxy is) or by a stranger: refused.
        MockDistributor d = new MockDistributor();
        assertEq(address(d), predicted);
        vm.prank(owner);
        vm.expectRevert(MineVault.NotOwnersDistributor.selector);
        vault.acceptDistributor();
        d.setOwner(alice);
        vm.prank(owner);
        vm.expectRevert(MineVault.NotOwnersDistributor.selector);
        vault.acceptDistributor();
        // A contract with no owner() at all: refused too.
        Stray noOwner = new Stray(alice);
        vm.startPrank(owner);
        vault.proposeDistributor(address(noOwner));
        vm.warp(_now() + 2 days);
        vm.expectRevert(MineVault.NotOwnersDistributor.selector);
        vault.acceptDistributor();
        vm.stopPrank();

        // The owner's own: accepted, and only it mints from then on.
        d.setVault(vault);
        assertEq(d.owner(), owner);
        vm.startPrank(owner);
        vault.proposeDistributor(address(d));
        vm.warp(_now() + 2 days);
        vault.acceptDistributor();
        vm.stopPrank();
        assertEq(vault.distributor(), address(d));
        d.pay(alice, 1e18);
        vm.expectRevert(MineVault.NotDistributor.selector);
        sites.pay(alice, 1);

        // If the vault changes hands, the next distributor must be the new owner's.
        vm.prank(owner);
        vault.transferOwnership(alice);
        vm.prank(alice);
        vault.acceptOwnership();
        vm.prank(alice);
        vault.proposeDistributor(address(next)); // still owned by `owner`
        vm.warp(_now() + 2 days);
        vm.prank(alice);
        vm.expectRevert(MineVault.NotOwnersDistributor.selector);
        vault.acceptDistributor();
        next.setOwner(alice);
        vm.prank(alice);
        vault.acceptDistributor();
        assertEq(vault.distributor(), address(next));
    }

    function test_ProposalsCanBeCancelledOrReplaced() public {
        vm.startPrank(owner);
        vm.expectRevert(MineVault.NoProposal.selector);
        vault.cancelDistributor();
        vault.proposeDistributor(address(next));
        vm.warp(_now() + 1 days);
        // A new proposal restarts the wait.
        MockDistributor third = new MockDistributor();
        vault.proposeDistributor(address(third));
        vm.warp(_now() + 1 days + 1);
        vm.expectRevert(MineVault.TooEarly.selector);
        vault.acceptDistributor();
        vm.expectEmit(address(vault));
        emit MineVault.DistributorProposalCancelled(address(third));
        vault.cancelDistributor();
        vm.warp(_now() + 3 days);
        vm.expectRevert(MineVault.NoProposal.selector);
        vault.acceptDistributor();
        vm.stopPrank();
        assertEq(vault.distributor(), address(sites));
    }

    function test_OwnerOnlyAndNoRenounce() public {
        bytes memory unauthorized = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice);
        vm.startPrank(alice);
        vm.expectRevert(unauthorized);
        vault.proposeDistributor(address(next));
        vm.expectRevert(unauthorized);
        vault.acceptDistributor();
        vm.expectRevert(unauthorized);
        vault.cancelDistributor();
        vm.expectRevert(unauthorized);
        vault.sweep(IERC20(address(token)), alice);
        vm.expectRevert(unauthorized);
        vault.renounceOwnership();
        vm.stopPrank();
        vm.prank(owner);
        vm.expectRevert(MineVault.CannotRenounce.selector);
        vault.renounceOwnership();
        // Two steps to a new owner (a multisig or a timelock, say).
        vm.prank(owner);
        vault.transferOwnership(alice);
        assertEq(vault.owner(), owner);
        vm.prank(alice);
        vault.acceptOwnership();
        assertEq(vault.owner(), alice);
    }

    /// Tokens sent to the vault by mistake can be sent on; it never holds anything of its own.
    function test_SweepStrays() public {
        Stray stray = new Stray(address(vault));
        sites.pay(alice, 10e18);
        vm.prank(alice);
        token.transfer(address(vault), 10e18);
        vm.startPrank(owner);
        vm.expectRevert(MineVault.ZeroAddress.selector);
        vault.sweep(IERC20(address(stray)), address(0));
        vault.sweep(IERC20(address(stray)), owner);
        vault.sweep(IERC20(address(token)), alice);
        vm.stopPrank();
        assertEq(stray.balanceOf(owner), 5e18);
        assertEq(token.balanceOf(alice), 10e18);
        assertEq(vault.released(), 10e18, "sweeping mints nothing");
    }
}

/// Random moves: the distributor (whoever it is at the time) and strangers asking for $MINE, the owner proposing,
/// cancelling and accepting new distributors, and time passing. The books are checked after every step.
contract VaultHandler is Test {
    MineVault public vault;
    MineToken public token;
    address internal owner;
    MockDistributor[3] public distributors;

    mapping(uint256 => uint256) public mintedOn;
    uint256[] public daysSeen;
    mapping(uint256 => bool) internal seen;
    uint256 public minted;
    uint256 public changes;
    bool public strangerMinted;
    bool public changedEarly;
    uint256 internal proposedAt;

    constructor(MineVault v, MineToken t, address o, MockDistributor[3] memory d) {
        vault = v;
        token = t;
        owner = o;
        distributors = d;
    }

    function daysSeenCount() external view returns (uint256) {
        return daysSeen.length;
    }

    /// One of the three distributors (the current one, or one that isn't) asks for $MINE.
    function release(uint8 which, uint256 amount, address to) external {
        if (to == address(0)) to = address(1);
        MockDistributor d = distributors[which % 3];
        amount = bound(amount, 0, 20_000e18);
        bool current = vault.distributor() == address(d);
        try d.pay(to, amount) {
            if (!current) strangerMinted = true;
            uint256 day = vm.getBlockTimestamp() / 1 days;
            if (!seen[day]) {
                seen[day] = true;
                daysSeen.push(day);
            }
            mintedOn[day] += amount;
            minted += amount;
        } catch {}
    }

    function propose(uint8 which) external {
        vm.prank(owner);
        vault.proposeDistributor(address(distributors[which % 3]));
        proposedAt = vm.getBlockTimestamp();
    }

    function cancel() external {
        vm.prank(owner);
        try vault.cancelDistributor() {} catch {}
    }

    function accept() external {
        address pending = vault.pendingDistributor();
        vm.prank(owner);
        try vault.acceptDistributor() {
            if (vm.getBlockTimestamp() < proposedAt + 2 days || pending == address(0)) changedEarly = true;
            changes++;
        } catch {}
    }

    function warp(uint256 secs) external {
        vm.warp(vm.getBlockTimestamp() + bound(secs, 1, 30 hours));
    }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 100
/// forge-config: default.invariant.fail-on-revert = false
contract MineVaultInvariantTest is VaultFixture {
    MineVault vault;
    MineToken token;
    VaultHandler handler;

    function setUp() public {
        vm.warp(20_000 days + 12 hours);
        MockDistributor[3] memory d = [new MockDistributor(), new MockDistributor(), new MockDistributor()];
        address owner = makeAddr("owner");
        (token, vault) = _vault(owner, address(d[0]), makeAddr("pool"));
        for (uint256 i; i < 3; i++) {
            d[i].setVault(vault);
        }
        handler = new VaultHandler(vault, token, owner, d);
        targetContract(address(handler));
    }

    /// Never more than 35,000 minted in a UTC day, whoever the distributor was, across every change.
    function invariant_NeverMoreThanTheDailyLimit() public view {
        for (uint256 k; k < handler.daysSeenCount(); k++) {
            assertLe(handler.mintedOn(handler.daysSeen(k)), 35_000e18);
        }
    }

    /// Only the distributor of the moment mints; distributors change only after their two days; the total stays
    /// within the vault's share and the token's 21M cap.
    function invariant_Books() public view {
        assertFalse(handler.strangerMinted(), "a distributor that wasn't the current one minted");
        assertFalse(handler.changedEarly(), "a distributor took over before its two days");
        assertEq(vault.released(), handler.minted());
        assertLe(vault.released(), vault.TOTAL_LIMIT());
        assertEq(token.totalMinted(), LAUNCH + vault.released());
        assertLe(token.totalMinted(), token.MAX_SUPPLY());
        assertEq(token.totalSupply(), token.totalMinted(), "nothing burned here");
    }

    /// The walk really mints, hits the daily limit and changes distributors.
    function test_WalkMintsAndChangesDistributors() public {
        uint256 r = 11;
        for (uint256 i; i < 600; i++) {
            r = uint256(keccak256(abi.encode(r)));
            uint256 move = r % 10;
            if (move < 5) handler.release(uint8(r >> 8), r >> 16, address(uint160(r >> 96)));
            else if (move < 6) handler.propose(uint8(r >> 8));
            else if (move < 7) handler.cancel();
            else if (move < 8) handler.accept();
            else handler.warp(r >> 8);
            if (i % 50 == 49) {
                invariant_NeverMoreThanTheDailyLimit();
                invariant_Books();
            }
        }
        emit log_named_uint("minted (MINE)", handler.minted() / 1e18);
        emit log_named_uint("distributor changes", handler.changes());
        assertGt(handler.minted(), 100_000e18, "the walk mints");
        assertGt(handler.changes(), 2, "the walk changes distributors");
        bool full;
        for (uint256 k; k < handler.daysSeenCount(); k++) {
            if (handler.mintedOn(handler.daysSeen(k)) > 30_000e18) full = true;
        }
        assertTrue(full, "some day comes close to the limit");
    }
}
