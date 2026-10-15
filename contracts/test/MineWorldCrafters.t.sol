// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {MineWorldCrafters, ICreatorToken} from "../src/MineWorldCrafters.sol";
import {CrafterArt, Traits} from "../src/CrafterArt.sol";

/// Acts like OpenSea's strict registry: owners may move their own Crafters; any other caller needs the
/// marketplace's fee check (here, `authorize`) for that transfer.
contract StrictValidator {
    error UnauthorizedTransfer();

    mapping(address => bool) public authorized;

    function authorize(address operator, bool ok) external {
        authorized[operator] = ok;
    }

    function validateTransfer(address caller, address from, address, uint256) external view {
        if (caller != from && !authorized[caller]) revert UnauthorizedTransfer();
    }
}

/// Puts ETH into an address without calling it (SELFDESTRUCT in the creating transaction).
contract ForceSend {
    constructor(address payable to) payable {
        selfdestruct(to);
    }
}

/// Reads the metadata JSON out of a `data:application/json;base64,` URI.
library Json {
    function decodeURI(string memory uri) internal pure returns (string memory) {
        bytes memory u = bytes(uri);
        bytes memory prefix = bytes("data:application/json;base64,");
        for (uint256 i; i < prefix.length; i++) require(u[i] == prefix[i], "not a base64 JSON data URI");
        bytes memory b64 = new bytes(u.length - prefix.length);
        for (uint256 i = 0; i < b64.length; i++) b64[i] = u[i + prefix.length];
        return string(decode(string(b64)));
    }

    function decode(string memory s) internal pure returns (bytes memory) {
        bytes memory table = bytes("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
        bytes memory input = bytes(s);
        uint8[128] memory rev;
        for (uint8 i = 0; i < 64; i++) rev[uint8(table[i])] = i;
        uint256 pad = 0;
        if (input.length > 0 && input[input.length - 1] == "=") pad++;
        if (input.length > 1 && input[input.length - 2] == "=") pad++;
        bytes memory out = new bytes((input.length / 4) * 3 - pad);
        uint256 o;
        for (uint256 i = 0; i < input.length; i += 4) {
            uint256 n = (uint256(rev[uint8(input[i])]) << 18) | (uint256(rev[uint8(input[i + 1])]) << 12)
                | (uint256(input[i + 2] == "=" ? 0 : rev[uint8(input[i + 2])]) << 6)
                | uint256(input[i + 3] == "=" ? 0 : rev[uint8(input[i + 3])]);
            if (o < out.length) out[o++] = bytes1(uint8(n >> 16));
            if (o < out.length) out[o++] = bytes1(uint8(n >> 8));
            if (o < out.length) out[o++] = bytes1(uint8(n));
        }
        return out;
    }

    function has(string memory hay, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(hay);
        bytes memory n = bytes(needle);
        if (n.length > h.length) return false;
        for (uint256 i = 0; i <= h.length - n.length; i++) {
            bool ok = true;
            for (uint256 j = 0; j < n.length && ok; j++) {
                if (h[i + j] != n[j]) ok = false;
            }
            if (ok) return true;
        }
        return false;
    }
}

/// Adapted from Courier World's Courier Skins tests: the same sale, reveal, royalty enforcement and links, now with a
/// free mint by default, five a transaction, a per-wallet limit, and the pictures drawn on chain. The art itself is
/// checked against the JS in CrafterArt.t.sol.
contract MineWorldCraftersTest is Test {
    MineWorldCrafters crafters;
    StrictValidator validator;
    CrafterArt art;

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address market = makeAddr("market");

    uint256 constant PRICE = 0.002 ether; // (when the owner sets one; free at launch)
    uint256 constant SECRET = 424242;

    function setUp() public {
        validator = new StrictValidator();
        art = new CrafterArt();
        crafters = new MineWorldCrafters(owner, treasury, 0, keccak256(abi.encode(SECRET)), address(validator), art);
        vm.prank(owner);
        crafters.setSaleOpen(true);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function _mint(address who, uint256 n) internal {
        uint256 value = crafters.price() * n;
        vm.prank(who);
        crafters.mint{value: value}(n);
    }

    function _setPrice(uint256 p) internal {
        vm.prank(owner);
        crafters.setPrice(p);
    }

    /// Close the sale (if it's open), publish the secret, and once the next block is over, seal (anyone can): the
    /// order the contract requires.
    function _reveal() internal {
        if (crafters.saleOpen()) {
            vm.prank(owner);
            crafters.setSaleOpen(false);
        }
        vm.prank(owner);
        crafters.reveal(SECRET);
        vm.roll(vm.getBlockNumber() + 2);
        vm.prank(bob);
        crafters.seal();
    }

    /// Puts the test ArbSys at 0x64 (the Arbitrum path), at L2 block `n`.
    function _arbitrum(uint256 n) internal returns (MockArbSys sys) {
        vm.etch(address(100), address(new MockArbSys()).code);
        sys = MockArbSys(address(100));
        sys.setNumber(n);
    }

    /// blockhash(n) now, read in its own call (via-IR may otherwise move a blockhash or block.number read across a
    /// vm.roll).
    function hashOf(uint256 n) external view returns (bytes32) {
        return blockhash(n);
    }

    // ---------------------------------------------------------------- mint

    function test_TheCollection() public view {
        assertEq(crafters.name(), "I'M DIO");
        assertEq(crafters.symbol(), "DIO");
        assertEq(crafters.MAX_SUPPLY(), 3333);
        assertEq(crafters.MAX_PER_TX(), 5);
        assertEq(crafters.walletLimit(), 3);
        assertEq(crafters.price(), 0);
        assertEq(address(crafters.art()), address(art));
        assertEq(crafters.owner(), owner);
        assertEq(crafters.treasury(), treasury);
    }

    function test_FreeMintByDefault() public {
        _mint(alice, 3);
        assertEq(crafters.balanceOf(alice), 3);
        assertEq(crafters.ownerOf(3), alice);
        assertEq(crafters.totalMinted(), 3);
        assertEq(crafters.mintedBy(alice), 3);
        assertEq(treasury.balance, 0);
        assertEq(address(crafters).balance, 0);
        // While free, sending ETH is a mistake: refused.
        vm.prank(bob);
        vm.expectRevert(MineWorldCrafters.WrongPayment.selector);
        crafters.mint{value: 1}(1);
    }

    function test_PaidMintPaysTheTreasury() public {
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.PriceSet(PRICE);
        _setPrice(PRICE);
        _mint(alice, 3);
        assertEq(crafters.balanceOf(alice), 3);
        assertEq(treasury.balance, 3 * PRICE);
        assertEq(address(crafters).balance, 0);
        // Back to free (0 is allowed).
        _setPrice(0);
        _mint(bob, 2);
        assertEq(treasury.balance, 3 * PRICE);
        assertEq(crafters.balanceOf(bob), 2);
    }

    function test_MintRules() public {
        _setPrice(PRICE);
        vm.prank(owner);
        crafters.setWalletLimit(10); // (the per-transaction rules, above the launch's 3 a wallet)
        vm.startPrank(alice);
        vm.expectRevert(MineWorldCrafters.WrongPayment.selector);
        crafters.mint{value: PRICE}(2);
        vm.expectRevert(MineWorldCrafters.WrongPayment.selector);
        crafters.mint{value: PRICE * 3}(2);
        vm.expectRevert(MineWorldCrafters.BadQuantity.selector);
        crafters.mint{value: 0}(0);
        vm.expectRevert(MineWorldCrafters.BadQuantity.selector);
        crafters.mint{value: PRICE * 6}(6);
        crafters.mint{value: PRICE * 5}(5);
        vm.stopPrank();
        vm.prank(owner);
        crafters.setSaleOpen(false);
        vm.prank(alice);
        vm.expectRevert(MineWorldCrafters.SaleClosed.selector);
        crafters.mint{value: PRICE}(1);
    }

    /// At the launch default a wallet mints 3 in all, free, and a 4th is refused.
    function test_ThreePerWalletAtLaunch() public {
        assertEq(crafters.price(), 0);
        assertEq(crafters.walletLimit(), 3);
        _mint(alice, 1);
        _mint(alice, 2);
        assertEq(crafters.balanceOf(alice), 3);
        vm.prank(alice);
        vm.expectRevert(MineWorldCrafters.WalletLimit.selector);
        crafters.mint(1);
        // Three at once from a fresh wallet: fine; four at once: refused whole.
        _mint(bob, 3);
        address carol = makeAddr("carol");
        vm.prank(carol);
        vm.expectRevert(MineWorldCrafters.WalletLimit.selector);
        crafters.mint(4);
        assertEq(crafters.balanceOf(carol), 0);
    }

    /// Each wallet mints at most `walletLimit` in all (3 at launch), counted by what it minted, not what it holds.
    function test_WalletLimit() public {
        _mint(alice, 3);
        vm.prank(alice);
        vm.expectRevert(MineWorldCrafters.WalletLimit.selector);
        crafters.mint(1);
        // Giving them away doesn't make room.
        vm.prank(alice);
        crafters.transferFrom(alice, bob, 1);
        vm.prank(alice);
        vm.expectRevert(MineWorldCrafters.WalletLimit.selector);
        crafters.mint(1);
        assertEq(crafters.mintedBy(alice), 3);
        // A partial mint over the limit is refused whole.
        _mint(bob, 2);
        vm.prank(bob);
        vm.expectRevert(MineWorldCrafters.WalletLimit.selector);
        crafters.mint(2);
        _mint(bob, 1);

        // The owner raises it (up to 50) or lowers it (to 1).
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.WalletLimitSet(12);
        vm.prank(owner);
        crafters.setWalletLimit(12);
        _mint(alice, 5);
        _mint(alice, 4);
        assertEq(crafters.mintedBy(alice), 12);
        vm.startPrank(owner);
        vm.expectRevert(MineWorldCrafters.BadWalletLimit.selector);
        crafters.setWalletLimit(0);
        vm.expectRevert(MineWorldCrafters.BadWalletLimit.selector);
        crafters.setWalletLimit(51);
        crafters.setWalletLimit(50);
        crafters.setWalletLimit(1);
        vm.stopPrank();
        assertEq(crafters.walletLimit(), 1);
        address carol = makeAddr("carol");
        _mint(carol, 1);
        vm.prank(carol);
        vm.expectRevert(MineWorldCrafters.WalletLimit.selector);
        crafters.mint(1);
    }

    function test_SellsOutAt3333() public {
        vm.prank(owner);
        crafters.setWalletLimit(50);
        for (uint256 w; w < 66; w++) {
            address who = address(uint160(0x10000 + w));
            for (uint256 i; i < 10; i++) _mint(who, 5);
        }
        assertEq(crafters.totalMinted(), 3300);
        address last = makeAddr("last");
        for (uint256 i; i < 6; i++) _mint(last, 5);
        vm.prank(last);
        vm.expectRevert(MineWorldCrafters.SoldOut.selector);
        crafters.mint(4);
        _mint(last, 3);
        assertEq(crafters.totalMinted(), 3333);
        assertEq(crafters.ownerOf(3333), last);
        vm.prank(bob);
        vm.expectRevert(MineWorldCrafters.SoldOut.selector);
        crafters.mint(1);
    }

    /// Audit 25e6a0b3 #6 (Courier Skins): ETH forced in without a call leaves with the next mint, free or paid.
    function test_ForcedEthGoesToTheTreasury() public {
        new ForceSend{value: 1 ether}(payable(address(crafters)));
        assertEq(address(crafters).balance, 1 ether);
        _mint(alice, 1);
        assertEq(address(crafters).balance, 0);
        assertEq(treasury.balance, 1 ether);
        _setPrice(PRICE);
        new ForceSend{value: 1 ether}(payable(address(crafters)));
        _mint(alice, 1);
        assertEq(address(crafters).balance, 0);
        assertEq(treasury.balance, 2 ether + PRICE);
    }

    function test_TokensOfOwner() public {
        _mint(alice, 2);
        _mint(bob, 1);
        _mint(alice, 1);
        uint256[] memory ids = crafters.tokensOfOwner(alice);
        assertEq(ids.length, 3);
        assertEq(ids[0], 1);
        assertEq(ids[1], 2);
        assertEq(ids[2], 4);
        assertEq(crafters.tokensOfOwner(makeAddr("nobody")).length, 0);
    }

    /// tokensOfOwner scans every minted id: still cheap enough for an eth_call when sold out.
    function test_TokensOfOwnerGasWhenSoldOut() public {
        vm.prank(owner);
        crafters.setWalletLimit(50);
        for (uint256 w; w < 67; w++) {
            address who = address(uint160(0x10000 + w));
            for (uint256 i; i < 10 && crafters.totalMinted() < 3333; i++) {
                uint256 n = 3333 - crafters.totalMinted();
                _mint(who, n < 5 ? n : 5);
            }
        }
        vm.prank(address(uint160(0x10000 + 66)));
        crafters.transferFrom(address(uint160(0x10000 + 66)), alice, 3333);
        vm.cool(address(crafters));
        uint256 g = gasleft();
        uint256[] memory ids = crafters.tokensOfOwner(alice);
        g -= gasleft();
        assertEq(ids.length, 1);
        assertEq(ids[0], 3333);
        emit log_named_uint("tokensOfOwner gas, last id of 3,333", g);
        assertLt(g, 15_000_000);
    }

    // ---------------------------------------------------------------- reveal

    function test_RevealNeedsTheSecretAndEndsTheSale() public {
        _mint(alice, 2);
        vm.expectRevert(MineWorldCrafters.NotRevealed.selector);
        crafters.traitsOf(1);
        vm.prank(owner);
        vm.expectRevert(MineWorldCrafters.SaleStillOpen.selector);
        crafters.reveal(SECRET);
        vm.prank(owner);
        crafters.setSaleOpen(false);
        vm.prank(owner);
        vm.expectRevert(MineWorldCrafters.BadSecret.selector);
        crafters.reveal(1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        crafters.reveal(SECRET);

        _reveal();
        assertFalse(crafters.saleOpen());
        assertTrue(crafters.seed() != 0);
        assertEq(crafters.revealedSecret(), SECRET);
        vm.startPrank(owner);
        vm.expectRevert(MineWorldCrafters.AlreadyRevealed.selector);
        crafters.reveal(SECRET);
        vm.expectRevert(MineWorldCrafters.AlreadyRevealed.selector);
        crafters.setSaleOpen(true);
        vm.expectRevert(MineWorldCrafters.AlreadyRevealed.selector);
        crafters.seal();
        vm.stopPrank();
        crafters.traitsOf(1);
        // Only minted tokens have traits.
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 3));
        crafters.traitsOf(3);
    }

    /// Until the secret is out, closing the sale is a pause: it reopens and the mint carries on. Once the secret is
    /// out, the sale never reopens.
    function test_TheSaleIsAPauseUntilTheSecretIsOut() public {
        _mint(alice, 1);
        vm.startPrank(owner);
        crafters.setSaleOpen(false);
        vm.roll(vm.getBlockNumber() + 300);
        crafters.setSaleOpen(true);
        vm.stopPrank();
        _mint(bob, 2);
        vm.prank(owner);
        crafters.setSaleOpen(false);
        assertEq(uint8(crafters.revealStatus()), uint8(MineWorldCrafters.RevealStatus.None));
        vm.prank(bob);
        vm.expectRevert(MineWorldCrafters.NoSecret.selector);
        crafters.seal();
        vm.prank(owner);
        crafters.reveal(SECRET);
        vm.startPrank(owner);
        vm.expectRevert(MineWorldCrafters.AlreadyRevealed.selector);
        crafters.setSaleOpen(true);
        vm.expectRevert(MineWorldCrafters.AlreadyRevealed.selector);
        crafters.setSaleOpen(false);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(MineWorldCrafters.SaleClosed.selector);
        crafters.mint(1);
        assertEq(crafters.totalMinted(), 3);
    }

    /// Audit 25e6a0b3 #1, in the current flow: the owner mints, closes the sale and publishes the secret in the same
    /// block, but the seed then waits for the next block's hash, which doesn't exist yet: nothing it minted had a
    /// look anyone could know, and the sale can't reopen to mint more.
    function test_OwnerCantMintKnowingTheLooks() public {
        _mint(alice, 3);
        uint256 b = vm.getBlockNumber() + 10;
        vm.roll(b);
        vm.startPrank(owner);
        crafters.mint(3);
        vm.expectRevert(MineWorldCrafters.SaleStillOpen.selector);
        crafters.reveal(SECRET);
        crafters.setSaleOpen(false);
        crafters.reveal(SECRET);
        assertEq(crafters.entropyBlock(), b + 1);
        assertEq(this.hashOf(b + 1), 0, "the entropy block's hash doesn't exist yet");
        vm.expectRevert(MineWorldCrafters.RevealTooSoon.selector);
        crafters.seal();
        vm.roll(b + 1); // the entropy block itself: its hash still doesn't exist
        assertEq(this.hashOf(b + 1), 0);
        vm.expectRevert(MineWorldCrafters.RevealTooSoon.selector);
        crafters.seal();
        vm.expectRevert(MineWorldCrafters.AlreadyRevealed.selector);
        crafters.setSaleOpen(true);
        vm.stopPrank();
        vm.expectRevert(MineWorldCrafters.NotRevealed.selector);
        crafters.rarityOf(1);
    }

    /// The seed is the public secret mixed with the hash of the block after the reveal's, set by whoever seals,
    /// whenever within the window, and never 0. Sealing tells marketplaces to re-read every Crafter.
    function test_SeedComesFromTheSecretAndTheNextBlock() public {
        _mint(alice, 1);
        vm.prank(owner);
        crafters.setSaleOpen(false);
        uint256 b = vm.getBlockNumber();
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.SecretRevealed(SECRET, b + 1);
        vm.prank(owner);
        crafters.reveal(SECRET);
        assertEq(crafters.entropyBlock(), b + 1);
        assertEq(crafters.revealedSecret(), SECRET);
        assertEq(crafters.seed(), 0);
        assertEq(uint8(crafters.revealStatus()), uint8(MineWorldCrafters.RevealStatus.Waiting));
        vm.roll(b + 5);
        assertEq(uint8(crafters.revealStatus()), uint8(MineWorldCrafters.RevealStatus.Sealable));
        bytes32 h = this.hashOf(b + 1);
        assertTrue(h != 0);
        uint256 expected = uint256(keccak256(abi.encode(SECRET, h)));
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.Revealed(expected);
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.BatchMetadataUpdate(1, 1);
        vm.prank(bob);
        assertEq(crafters.seal(), expected);
        assertEq(crafters.seed(), expected);
        assertEq(uint8(crafters.revealStatus()), uint8(MineWorldCrafters.RevealStatus.Revealed));
    }

    /// Re-check 8c7ba957 #6: no party knows the looks before everyone can, and the owner can't hold them back. Until
    /// the owner publishes the secret, only it knows the secret but nobody knows the entropy; when it publishes, the
    /// entropy block doesn't exist yet; once that block is over, everyone holds the same two public inputs, and anyone
    /// can seal, without the owner, until the window's last block.
    function test_NoPartyKnowsTheLooksBeforeEveryoneCan() public {
        _mint(alice, 3);
        vm.prank(owner);
        crafters.setSaleOpen(false);
        uint256 b = vm.getBlockNumber();
        vm.prank(owner);
        crafters.reveal(SECRET);
        uint256 e = crafters.entropyBlock();
        // In the reveal's block and in the entropy block itself, the entropy doesn't exist for anyone.
        assertEq(this.hashOf(e), 0);
        vm.roll(b + 1);
        assertEq(this.hashOf(e), 0);
        vm.expectRevert(MineWorldCrafters.NotRevealed.selector);
        crafters.rarityOf(1);
        // From the next block, a stranger works the seed out from public data alone, then anyone seals it.
        vm.roll(b + 2);
        uint256 worked = uint256(keccak256(abi.encode(crafters.revealedSecret(), this.hashOf(e))));
        vm.prank(alice);
        crafters.seal();
        assertEq(crafters.seed(), worked);

        // The owner going silent after its reveal holds nothing up within the window: a stranger seals on its last
        // block.
        MineWorldCrafters other =
            new MineWorldCrafters(owner, treasury, 0, keccak256(abi.encode(SECRET)), address(validator), art);
        vm.prank(owner);
        other.reveal(SECRET);
        uint256 e2 = other.entropyBlock();
        vm.roll(e2 + 256);
        vm.prank(alice);
        assertTrue(other.seal() != 0);
    }

    /// Second re-check 52b534f9 #2: a window nobody sealed in is no free re-roll. A stranger can neither seal it
    /// (`EntropyExpired`) nor move it on (owner only); the owner can move it on, in public, and anyone then seals
    /// the new block.
    function test_AStrangerCantMoveTheEntropyBlockOn() public {
        _mint(alice, 2);
        vm.prank(owner);
        crafters.setSaleOpen(false);
        vm.prank(owner);
        crafters.reveal(SECRET);
        uint256 e = crafters.entropyBlock();
        vm.prank(owner);
        vm.expectRevert(MineWorldCrafters.NotExpired.selector);
        crafters.moveEntropyOn(); // (only after the window, even for the owner)
        vm.roll(e + 257);
        assertEq(uint8(crafters.revealStatus()), uint8(MineWorldCrafters.RevealStatus.Expired));
        vm.prank(bob);
        vm.expectRevert(MineWorldCrafters.EntropyExpired.selector);
        crafters.seal();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        crafters.moveEntropyOn();
        assertEq(crafters.entropyBlock(), e);
        assertEq(crafters.entropyMoves(), 0);

        uint256 next = e + 258;
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.EntropyBlockMoved(next, 1);
        vm.prank(owner);
        assertEq(crafters.moveEntropyOn(), next);
        assertEq(crafters.entropyMoves(), 1);
        assertEq(uint8(crafters.revealStatus()), uint8(MineWorldCrafters.RevealStatus.Waiting));
        vm.roll(next + 1);
        bytes32 h = this.hashOf(next);
        vm.prank(bob);
        crafters.seal();
        assertEq(crafters.seed(), uint256(keccak256(abi.encode(SECRET, h))));
    }

    /// The owner moves the entropy block on at most MAX_ENTROPY_MOVES (3) times, each only after a window nobody
    /// sealed in; after the third, a window left unsealed leaves the Crafters sealed for good (`Stuck`).
    function test_TheOwnerMovesOnAtMostThreeTimes() public {
        _mint(alice, 2);
        vm.prank(owner);
        crafters.setSaleOpen(false);
        vm.prank(owner);
        crafters.reveal(SECRET);
        assertEq(crafters.MAX_ENTROPY_MOVES(), 3);
        for (uint256 i = 1; i <= 3; i++) {
            uint256 e = crafters.entropyBlock();
            vm.roll(e + 200);
            vm.prank(owner);
            vm.expectRevert(MineWorldCrafters.NotExpired.selector);
            crafters.moveEntropyOn();
            vm.roll(e + 257);
            vm.prank(owner);
            crafters.moveEntropyOn();
            assertEq(crafters.entropyMoves(), i);
        }
        uint256 last = crafters.entropyBlock();
        vm.roll(last + 257);
        assertEq(uint8(crafters.revealStatus()), uint8(MineWorldCrafters.RevealStatus.Stuck));
        vm.prank(owner);
        vm.expectRevert(MineWorldCrafters.NoMovesLeft.selector);
        crafters.moveEntropyOn();
        vm.prank(bob);
        vm.expectRevert(MineWorldCrafters.EntropyExpired.selector);
        crafters.seal();
        assertEq(crafters.seed(), 0);
        // (Within the third move's window it could still be sealed, by anyone.)
    }

    /// Any seal that lands within the window fixes the seed for good, whoever sends it and at whichever block; after
    /// it nothing moves.
    function testFuzz_ASealWithinTheWindowAlwaysFixesIt(uint256 offset) public {
        offset = bound(offset, 1, 256);
        _mint(alice, 1);
        vm.prank(owner);
        crafters.setSaleOpen(false);
        vm.prank(owner);
        crafters.reveal(SECRET);
        uint256 e = crafters.entropyBlock();
        vm.roll(e + offset);
        bytes32 h = this.hashOf(e);
        vm.prank(bob);
        crafters.seal();
        assertEq(crafters.seed(), uint256(keccak256(abi.encode(SECRET, h))));
        vm.roll(e + 1_000);
        vm.prank(owner);
        vm.expectRevert(MineWorldCrafters.AlreadyRevealed.selector);
        crafters.moveEntropyOn();
        vm.prank(bob);
        vm.expectRevert(MineWorldCrafters.AlreadyRevealed.selector);
        crafters.seal();
    }

    /// If nobody seals within 256 blocks the hash can't be read any more: `seal` reverts, the owner moves the entropy
    /// block on to the next block, in public, and sealing once that block is over sets the seed from it. Second
    /// re-check 52b534f9 #4: the status says Sealable only with a block to spare (a seal landing on the window's last
    /// block still works).
    function test_AnExpiredEntropyBlockMovesOn() public {
        _mint(alice, 2);
        vm.prank(owner);
        crafters.setSaleOpen(false);
        uint256 b = vm.getBlockNumber();
        vm.prank(owner);
        crafters.reveal(SECRET);
        uint256 e = b + 1;
        vm.roll(e + 255);
        assertEq(uint8(crafters.revealStatus()), uint8(MineWorldCrafters.RevealStatus.Sealable));
        vm.roll(e + 256); // the last block its hash can be read in: a seal sent now would land after it
        assertEq(uint8(crafters.revealStatus()), uint8(MineWorldCrafters.RevealStatus.Expired));
        uint256 snap = vm.snapshotState();
        vm.prank(bob);
        crafters.seal(); // (one already landing in it still works)
        assertEq(crafters.seed(), uint256(keccak256(abi.encode(SECRET, this.hashOf(e)))));
        vm.revertToState(snap);
        vm.prank(owner);
        vm.expectRevert(MineWorldCrafters.NotExpired.selector);
        crafters.moveEntropyOn();

        vm.roll(e + 257);
        assertEq(uint8(crafters.revealStatus()), uint8(MineWorldCrafters.RevealStatus.Expired));
        vm.prank(bob);
        vm.expectRevert(MineWorldCrafters.EntropyExpired.selector);
        crafters.seal();
        uint256 next = e + 258;
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.EntropyBlockMoved(next, 1);
        vm.prank(owner);
        assertEq(crafters.moveEntropyOn(), next);
        assertEq(crafters.entropyBlock(), next);
        assertEq(crafters.seed(), 0);
        assertEq(uint8(crafters.revealStatus()), uint8(MineWorldCrafters.RevealStatus.Waiting));
        vm.prank(bob);
        vm.expectRevert(MineWorldCrafters.RevealTooSoon.selector);
        crafters.seal();
        vm.roll(next + 1);
        bytes32 h = this.hashOf(next);
        assertTrue(h != 0);
        vm.prank(alice);
        crafters.seal();
        assertEq(crafters.seed(), uint256(keccak256(abi.encode(SECRET, h))));
    }

    // ---------------------------------------------------------------- the reveal on an Arbitrum chain (ArbSys)

    /// Re-check 8c7ba957 #2: with ArbSys at 0x64 (Robinhood Chain), the entropy block is the L2 block after the
    /// reveal's, and its hash comes from ArbSys, not from `block.number` / `blockhash` (the parent chain's).
    function test_Arbitrum_TheEntropyIsTheNextL2Block() public {
        MockArbSys sys = _arbitrum(88_719_100);
        vm.roll(26_193_685); // the parent chain's number, as block.number reads on Robinhood Chain
        _mint(alice, 3);
        vm.prank(owner);
        crafters.setSaleOpen(false);
        assertEq(crafters.chainBlock(), 88_719_100);
        vm.prank(owner);
        crafters.reveal(SECRET);
        assertEq(crafters.entropyBlock(), 88_719_101);
        vm.prank(bob);
        vm.expectRevert(MineWorldCrafters.RevealTooSoon.selector);
        crafters.seal();
        sys.setNumber(88_719_101);
        assertEq(uint8(crafters.revealStatus()), uint8(MineWorldCrafters.RevealStatus.Waiting));
        vm.prank(bob);
        vm.expectRevert(MineWorldCrafters.RevealTooSoon.selector);
        crafters.seal();
        sys.setNumber(88_719_102);
        assertEq(uint8(crafters.revealStatus()), uint8(MineWorldCrafters.RevealStatus.Sealable));
        vm.prank(bob);
        crafters.seal();
        assertEq(crafters.seed(), uint256(keccak256(abi.encode(SECRET, sys.l2Hash(88_719_101)))));
    }

    /// Re-check 8c7ba957 #2, the skip: when the parent chain's number jumps by two, Nitro's `blockhash` for the
    /// number skipped over returns the value written 256 parent blocks earlier, known in advance. The seal doesn't
    /// read it: the parent numbers can skip and their hashes be anything, the seed is the L2 block's.
    function test_Arbitrum_AParentChainSkipChangesNothing() public {
        MockArbSys sys = _arbitrum(88_719_163);
        uint256 parent = 26_193_685;
        vm.roll(parent);
        bytes32 stale = keccak256("blockhash(B - 256): readable for 256 parent blocks before the close");
        vm.setBlockhash(parent - 256, stale);
        vm.prank(owner);
        crafters.setSaleOpen(false);
        vm.prank(owner);
        crafters.reveal(SECRET);
        // The next L2 block carries the parent number B + 2 (a skip); slot B still holds the stale value.
        vm.roll(parent + 2);
        vm.setBlockhash(parent, stale);
        vm.setBlockhash(parent + 1, keccak256("the last L2 block's hash, filed under B + 1"));
        sys.setNumber(88_719_165);
        vm.prank(alice);
        crafters.seal();
        uint256 s = crafters.seed();
        assertEq(s, uint256(keccak256(abi.encode(SECRET, sys.l2Hash(88_719_164)))));
        assertTrue(s != uint256(keccak256(abi.encode(SECRET, stale))), "the stale parent-chain hash was used");
    }

    /// On ArbSys too, an entropy block left unsealed for more than 256 L2 blocks can't be sealed, and the owner moves
    /// it on to the next L2 block.
    function test_Arbitrum_ExpiryMovesTheEntropyBlockOn() public {
        MockArbSys sys = _arbitrum(1_000);
        vm.prank(owner);
        crafters.setSaleOpen(false);
        vm.prank(owner);
        crafters.reveal(SECRET);
        sys.setNumber(1_001 + 255);
        assertEq(uint8(crafters.revealStatus()), uint8(MineWorldCrafters.RevealStatus.Sealable));
        sys.setNumber(1_001 + 257);
        assertEq(uint8(crafters.revealStatus()), uint8(MineWorldCrafters.RevealStatus.Expired));
        vm.prank(bob);
        vm.expectRevert(MineWorldCrafters.EntropyExpired.selector);
        crafters.seal();
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.EntropyBlockMoved(1_259, 1);
        vm.prank(owner);
        assertEq(crafters.moveEntropyOn(), 1_259);
        sys.setNumber(1_260);
        vm.prank(bob);
        crafters.seal();
        assertEq(crafters.seed(), uint256(keccak256(abi.encode(SECRET, sys.l2Hash(1_259)))));
    }

    /// Expiry is read from block numbers, never from a failing call: if ArbSys fails within the window (as a call
    /// starved of gas would), the whole seal reverts and the entropy block stays put.
    function test_Arbitrum_AFailingCallNeverMovesTheEntropyBlockOn() public {
        MockArbSys sys = _arbitrum(7_000);
        vm.prank(owner);
        crafters.setSaleOpen(false);
        vm.prank(owner);
        crafters.reveal(SECRET);
        sys.setNumber(7_002);
        sys.setBroken(true);
        vm.prank(bob);
        vm.expectRevert(bytes("broken"));
        crafters.seal();
        assertEq(crafters.entropyBlock(), 7_001);
        // Starved of gas: the call fails as a whole, nothing moves.
        sys.setBroken(false);
        vm.prank(bob);
        (bool ok,) = address(crafters).call{gas: 20_000}(abi.encodeCall(MineWorldCrafters.seal, ()));
        assertFalse(ok);
        assertEq(crafters.entropyBlock(), 7_001);
        assertEq(crafters.seed(), 0);
        vm.prank(bob);
        crafters.seal();
        assertEq(crafters.seed(), uint256(keccak256(abi.encode(SECRET, sys.l2Hash(7_001)))));
    }

    function testFuzz_DifferentSeedsGiveValidTraits(uint256 secret) public {
        MineWorldCrafters s = new MineWorldCrafters(owner, treasury, 0, keccak256(abi.encode(secret)), address(validator), art);
        vm.prank(owner);
        s.setSaleOpen(true);
        vm.prank(alice);
        s.mint(3);
        vm.prank(owner);
        s.setSaleOpen(false);
        vm.prank(owner);
        s.reveal(secret);
        vm.roll(vm.getBlockNumber() + 2);
        s.seal();
        for (uint256 id = 1; id <= 3; id++) {
            Traits memory t = s.traitsOf(id);
            assertLt(t.hair, 36);
            assertLt(t.outfit, 16);
            assertLt(t.eyes, 6);
            assertLt(t.gaze, 2);
            assertLt(t.background, 8);
            assertLt(t.skin, 5);
            assertLt(t.hat, 10);
            assertLt(t.blush, 2);
        }
    }

    // ---------------------------------------------------------------- metadata

    function test_TokenURIBeforeAndAfterReveal() public {
        _mint(alice, 1);
        string memory sealedJson = Json.decodeURI(crafters.tokenURI(1));
        assertEq(vm.parseJsonString(sealedJson, ".name"), "I'M DIO #1");
        assertEq(vm.parseJsonString(sealedJson, ".description"), "A sealed I'M DIO. Its look is revealed after the mint.");
        assertEq(vm.parseJsonString(sealedJson, ".image"), string.concat("data:image/svg+xml;base64,", vm.toBase64(art.sealedSvg())));
        assertEq(vm.parseJsonString(sealedJson, ".attributes[0].value"), "Sealed");
        _reveal();
        string memory json = Json.decodeURI(crafters.tokenURI(1));
        Traits memory t = crafters.traitsOf(1);
        assertEq(vm.parseJsonString(json, ".name"), "I'M DIO #1");
        assertEq(vm.parseJsonString(json, ".image"), string.concat("data:image/svg+xml;base64,", vm.toBase64(art.render(t))));
        assertEq(vm.parseJsonString(json, ".attributes[0].trait_type"), "Background");
        assertEq(vm.parseJsonString(json, ".attributes[0].value"), art.traitName(0, t.background));
        assertEq(vm.parseJsonString(json, ".attributes[7].trait_type"), "Outfit");
        assertEq(vm.parseJsonString(json, ".attributes[7].value"), art.traitName(7, t.outfit));
        assertEq(vm.parseJsonString(json, ".attributes[8].trait_type"), "Rarity");
        assertFalse(vm.keyExistsJson(json, ".attributes[9]"), "no extra traits without an extension");
        assertTrue(Json.has(vm.parseJsonString(json, ".description"), "No two DIOs look alike. Each DIO boosts its owner's mining in MineWorldCraft by its rarity and level"));
        assertFalse(Json.has(json, "Cosmetic"));
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 2));
        crafters.tokenURI(2);
    }

    /// Audit 25e6a0b3 #3: the reveal (the seal, which sets the seed) tells marketplaces to re-read every token.
    function test_RevealRefreshesMarketplaces() public {
        _mint(alice, 3);
        assertTrue(crafters.supportsInterface(0x49064906));
        vm.prank(owner);
        crafters.setSaleOpen(false);
        vm.prank(owner);
        crafters.reveal(SECRET);
        vm.roll(vm.getBlockNumber() + 2);
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.BatchMetadataUpdate(1, 3);
        crafters.seal();
    }

    /// Before any link or picture is set, the collection page has only its name and description.
    function test_CollectionMetadataWithoutLinks() public view {
        string memory json = Json.decodeURI(crafters.contractURI());
        assertEq(vm.parseJsonString(json, ".name"), "I'M DIO");
        assertTrue(Json.has(vm.parseJsonString(json, ".description"), "3,333 pixel-art characters for MineWorldCraft"));
        assertFalse(Json.has(json, "external_link"));
        assertFalse(Json.has(json, '"image"'));
        assertFalse(Json.has(json, "banner_image"));
        assertFalse(Json.has(json, "Website:"));
        assertFalse(Json.has(json, "Social:"));
        assertTrue(Json.has(json, 'Each DIO boosts its owner\'s mining in MineWorldCraft by its rarity and level: faster mining, more $MINE per block and a higher daily cap, for active play only."'));
        assertFalse(Json.has(json, "Cosmetic"));
        assertEq(crafters.website(), "");
        assertEq(crafters.social(), "");
        assertEq(crafters.collectionImage(), "");
        assertEq(crafters.bannerImage(), "");
    }

    /// The owner can set and change the website and social links shown on marketplaces at any time.
    function test_OwnerUpdatesTheLinks() public {
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.LinksSet("https://mineworldcraft.fun/", "https://x.com/MineWorldCraft");
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.ContractURIUpdated();
        vm.prank(owner);
        crafters.setLinks("https://mineworldcraft.fun/", "https://x.com/MineWorldCraft");
        string memory json = Json.decodeURI(crafters.contractURI());
        assertEq(vm.parseJsonString(json, ".external_link"), "https://mineworldcraft.fun/");
        assertTrue(Json.has(json, "play only. Website: https://mineworldcraft.fun/ Social: https://x.com/MineWorldCraft\""));

        // Later: a new domain, no social link.
        vm.prank(owner);
        crafters.setLinks("https://play.mineworldcraft.xyz/", "");
        json = Json.decodeURI(crafters.contractURI());
        assertEq(vm.parseJsonString(json, ".external_link"), "https://play.mineworldcraft.xyz/");
        assertTrue(Json.has(json, "Website: https://play.mineworldcraft.xyz/\""));
        assertFalse(Json.has(json, "Social:"));

        // Only a social link: it shows in the description, with no external_link.
        vm.prank(owner);
        crafters.setLinks("", "https://discord.gg/mineworldcraft");
        json = Json.decodeURI(crafters.contractURI());
        assertFalse(Json.has(json, "external_link"));
        assertFalse(Json.has(json, "Website:"));
        assertTrue(Json.has(json, "play only. Social: https://discord.gg/mineworldcraft\""));

        // Links still change after the reveal.
        _mint(alice, 1);
        _reveal();
        vm.prank(owner);
        crafters.setLinks("https://mineworldcraft.fun/", "https://x.com/MineWorldCraft");
        assertEq(crafters.website(), "https://mineworldcraft.fun/");
        assertEq(crafters.social(), "https://x.com/MineWorldCraft");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        crafters.setLinks("https://evil.example/", "");
    }

    /// The collection's picture and banner: URLs the owner can set and change at any time.
    function test_OwnerSetsTheCollectionImages() public {
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.CollectionImagesSet("https://mineworldcraft.fun/crafters/collection.png", "https://mineworldcraft.fun/crafters/banner.png");
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.ContractURIUpdated();
        vm.prank(owner);
        crafters.setCollectionImages("https://mineworldcraft.fun/crafters/collection.png", "https://mineworldcraft.fun/crafters/banner.png");
        string memory json = Json.decodeURI(crafters.contractURI());
        assertEq(vm.parseJsonString(json, ".image"), "https://mineworldcraft.fun/crafters/collection.png");
        assertEq(vm.parseJsonString(json, ".featured_image"), "https://mineworldcraft.fun/crafters/collection.png");
        assertEq(vm.parseJsonString(json, ".banner_image"), "https://mineworldcraft.fun/crafters/banner.png");

        // Only a picture, then only a banner, with the links too.
        vm.startPrank(owner);
        crafters.setLinks("https://mineworldcraft.fun/", "");
        crafters.setCollectionImages("ipfs://bafy/collection.png", "");
        vm.stopPrank();
        json = Json.decodeURI(crafters.contractURI());
        assertEq(vm.parseJsonString(json, ".image"), "ipfs://bafy/collection.png");
        assertFalse(Json.has(json, "banner_image"));
        assertEq(vm.parseJsonString(json, ".external_link"), "https://mineworldcraft.fun/");
        vm.prank(owner);
        crafters.setCollectionImages("", "ipfs://bafy/banner.png");
        json = Json.decodeURI(crafters.contractURI());
        assertFalse(Json.has(json, '"image"'));
        assertEq(vm.parseJsonString(json, ".banner_image"), "ipfs://bafy/banner.png");

        vm.startPrank(owner);
        vm.expectRevert(MineWorldCrafters.BadLink.selector);
        crafters.setCollectionImages('https://a.example/x.png","name":"Fake', "");
        vm.expectRevert(MineWorldCrafters.BadLink.selector);
        crafters.setCollectionImages("", string(abi.encodePacked("https://a.example/", bytes1(0x0a))));
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        crafters.setCollectionImages("https://evil.example/x.png", "");
    }

    /// Links are written into the collection's JSON, so anything that would break it is refused.
    function test_LinksThatWouldBreakTheJsonAreRefused() public {
        vm.startPrank(owner);
        vm.expectRevert(MineWorldCrafters.BadLink.selector);
        crafters.setLinks('https://a.example/","name":"Fake', "");
        vm.expectRevert(MineWorldCrafters.BadLink.selector);
        crafters.setLinks("", "https://a.example/\\");
        vm.expectRevert(MineWorldCrafters.BadLink.selector);
        crafters.setLinks(string(abi.encodePacked("https://a.example/", bytes1(0x0a))), "");
        vm.expectRevert(MineWorldCrafters.BadLink.selector);
        crafters.setLinks("", string(abi.encodePacked("https://a.example/", bytes1(0x7f))));
        bytes memory long = new bytes(257);
        for (uint256 i; i < long.length; i++) long[i] = "a";
        vm.expectRevert(MineWorldCrafters.BadLink.selector);
        crafters.setLinks(string(long), "");
        vm.expectRevert(MineWorldCrafters.BadLink.selector);
        crafters.setCollectionImages(string(long), "");
        // 256 bytes is fine, and the page still decodes.
        bytes memory max = new bytes(256);
        for (uint256 i; i < max.length; i++) max[i] = "a";
        crafters.setLinks(string(max), string(max));
        crafters.setCollectionImages(string(max), string(max));
        vm.stopPrank();
        string memory json = Json.decodeURI(crafters.contractURI());
        assertEq(vm.parseJsonString(json, ".external_link"), string(max));
        assertEq(vm.parseJsonString(json, ".banner_image"), string(max));
    }

    /// setContractURI still replaces the whole page (and "" brings the built-in one, with the links, back).
    function test_ContractURIOverride() public {
        vm.prank(owner);
        crafters.setLinks("https://mineworldcraft.fun/", "");
        vm.prank(owner);
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.ContractURIUpdated();
        crafters.setContractURI("ipfs://collection.json");
        assertEq(crafters.contractURI(), "ipfs://collection.json");
        vm.prank(owner);
        crafters.setContractURI("");
        assertEq(vm.parseJsonString(Json.decodeURI(crafters.contractURI()), ".external_link"), "https://mineworldcraft.fun/");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        crafters.setContractURI("x");
    }

    /// The links, pictures and page never lock: the owner changes them after the whole collection is minted and
    /// revealed, and the 5% royalty and its enforcement are just as they were.
    function test_LinksStayChangeableAndRoyaltyEnforcedWhenSoldOut() public {
        vm.prank(owner);
        crafters.setWalletLimit(50);
        for (uint256 w; w < 67; w++) {
            address who = address(uint160(0x10000 + w));
            for (uint256 i; i < 10 && crafters.totalMinted() < 3333; i++) {
                uint256 n = 3333 - crafters.totalMinted();
                _mint(who, n < 5 ? n : 5);
            }
        }
        assertEq(crafters.totalMinted(), crafters.MAX_SUPPLY());
        vm.prank(alice);
        vm.expectRevert(MineWorldCrafters.SoldOut.selector);
        crafters.mint(1);
        _reveal();

        vm.startPrank(owner);
        crafters.setLinks("https://mineworldcraft.fun/", "https://x.com/MineWorldCraft");
        crafters.setCollectionImages("https://mineworldcraft.fun/c.png", "https://mineworldcraft.fun/b.png");
        crafters.setLinks("https://play.mineworldcraft.xyz/", "");
        crafters.setContractURI("ipfs://collection.json");
        crafters.setContractURI("");
        vm.stopPrank();
        string memory json = Json.decodeURI(crafters.contractURI());
        assertEq(vm.parseJsonString(json, ".external_link"), "https://play.mineworldcraft.xyz/");
        assertEq(vm.parseJsonString(json, ".image"), "https://mineworldcraft.fun/c.png");
        assertEq(vm.parseJsonString(json, ".banner_image"), "https://mineworldcraft.fun/b.png");

        // The royalty: 5% to the treasury, wherever it moves.
        (address to, uint256 amount) = crafters.royaltyInfo(3333, 1 ether);
        assertEq(to, treasury);
        assertEq(amount, 0.05 ether);
        address next = makeAddr("next");
        vm.prank(owner);
        crafters.setTreasury(next);
        (to, amount) = crafters.royaltyInfo(1, 2 ether);
        assertEq(to, next);
        assertEq(amount, 0.1 ether);
        // Its enforcement: holders move their own, marketplaces only through the fee check.
        address holder = address(uint160(0x10000));
        vm.prank(holder);
        crafters.transferFrom(holder, bob, 1);
        vm.prank(bob);
        crafters.setApprovalForAll(market, true);
        vm.prank(market);
        vm.expectRevert(StrictValidator.UnauthorizedTransfer.selector);
        crafters.transferFrom(bob, alice, 1);
        validator.authorize(market, true);
        vm.prank(market);
        crafters.transferFrom(bob, alice, 1);
        assertEq(crafters.getTransferValidator(), address(validator));
        vm.prank(owner);
        vm.expectRevert(MineWorldCrafters.NotAContract.selector);
        crafters.setTransferValidator(address(0));
    }

    /// Rarity once revealed, from the background and hat (CrafterArt.t.sol checks it against the JS for every one).
    function test_RarityOf() public {
        _mint(alice, 3);
        _mint(bob, 2);
        vm.expectRevert(MineWorldCrafters.NotRevealed.selector);
        crafters.rarityOf(1);
        _reveal();
        for (uint256 id = 1; id <= 5; id++) {
            Traits memory t = crafters.traitsOf(id);
            uint8 r = crafters.rarityOf(id);
            assertEq(r, art.rarityOf(t));
            assertEq(r, t.background == 7 ? 2 : (t.background == 6 || t.hat >= 7 ? 1 : 0));
            string memory json = Json.decodeURI(crafters.tokenURI(id));
            assertEq(vm.parseJsonString(json, ".attributes[8].value"), art.traitName(8, r));
        }
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 6));
        crafters.rarityOf(6);
    }

    // ---------------------------------------------------------------- royalty

    /// @dev External, so `vm.expectRevert` checks this constructor call. (A `new` straight in the test body reverts
    ///      the test itself, which forge counts as the expected revert, so nothing after it would run.)
    function newCrafters(address treasury_, address validator_, address art_) external returns (address) {
        return address(new MineWorldCrafters(owner, treasury_, 0, bytes32(0), validator_, CrafterArt(art_)));
    }

    function test_RoyaltyIsFivePercentToTheTreasury() public {
        _mint(alice, 1);
        (address to, uint256 amount) = crafters.royaltyInfo(1, 1 ether);
        assertEq(to, treasury);
        assertEq(amount, 0.05 ether);
        address newTreasury = makeAddr("newTreasury");
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.TreasurySet(newTreasury);
        vm.prank(owner);
        crafters.setTreasury(newTreasury);
        (to, amount) = crafters.royaltyInfo(1, 1 ether);
        assertEq(to, newTreasury);
        assertEq(amount, 0.05 ether);
        // Mint money follows it too.
        _setPrice(PRICE);
        _mint(bob, 1);
        assertEq(newTreasury.balance, PRICE);
        assertEq(crafters.ROYALTY_BPS(), 500);
    }

    function test_InterfacesForMarketplaces() public view {
        assertTrue(crafters.supportsInterface(type(IERC721).interfaceId));
        assertTrue(crafters.supportsInterface(type(IERC2981).interfaceId));
        assertTrue(crafters.supportsInterface(0xad0d7f6c)); // ICreatorToken
        assertEq(type(ICreatorToken).interfaceId, bytes4(0xad0d7f6c));
        assertTrue(crafters.supportsInterface(0x49064906)); // ERC-4906
        (bytes4 fn, bool isView) = crafters.getTransferValidationFunction();
        assertEq(fn, bytes4(keccak256("validateTransfer(address,address,address,uint256)")));
        assertEq(fn, bytes4(0xcaee23ea));
        assertTrue(isView);
        assertEq(crafters.getTransferValidator(), address(validator));
    }

    // ---------------------------------------------------------------- enforcement

    function test_HoldersCanMoveTheirOwnCrafters() public {
        _mint(alice, 1);
        vm.prank(alice);
        crafters.transferFrom(alice, bob, 1);
        assertEq(crafters.ownerOf(1), bob);
        vm.prank(bob);
        crafters.safeTransferFrom(bob, alice, 1);
        assertEq(crafters.ownerOf(1), alice);
    }

    function test_MarketplacesNeedTheFeeCheck() public {
        _mint(alice, 1);
        vm.prank(alice);
        crafters.setApprovalForAll(market, true);
        // An approved marketplace that skips the royalty can't move the Crafter.
        vm.prank(market);
        vm.expectRevert(StrictValidator.UnauthorizedTransfer.selector);
        crafters.transferFrom(alice, bob, 1);
        // Once the sale goes through the fee check, it can.
        validator.authorize(market, true);
        vm.prank(market);
        crafters.transferFrom(alice, bob, 1);
        assertEq(crafters.ownerOf(1), bob);
    }

    function test_SafeTransfersWithDataAreCheckedToo() public {
        _mint(alice, 1);
        vm.prank(alice);
        crafters.setApprovalForAll(market, true);
        vm.prank(market);
        vm.expectRevert(StrictValidator.UnauthorizedTransfer.selector);
        crafters.safeTransferFrom(alice, bob, 1, "sale");
        vm.prank(alice);
        crafters.safeTransferFrom(alice, bob, 1, "gift");
        assertEq(crafters.ownerOf(1), bob);
    }

    /// Mints never call the validator (one that refuses everything can't stop a mint).
    function test_MintsSkipTheValidator() public {
        RefuseAll refuse = new RefuseAll();
        vm.prank(owner);
        crafters.setTransferValidator(address(refuse));
        _mint(alice, 2);
        assertEq(crafters.balanceOf(alice), 2);
        vm.prank(alice);
        vm.expectRevert(RefuseAll.No.selector);
        crafters.transferFrom(alice, bob, 1);
    }

    function test_EnforcementCanMoveButNeverBeSwitchedOff() public {
        vm.startPrank(owner);
        vm.expectRevert(MineWorldCrafters.NotAContract.selector);
        crafters.setTransferValidator(address(0));
        vm.expectRevert(MineWorldCrafters.NotAContract.selector);
        crafters.setTransferValidator(makeAddr("eoa"));
        StrictValidator next = new StrictValidator();
        vm.expectEmit(address(crafters));
        emit ICreatorToken.TransferValidatorUpdated(address(validator), address(next));
        crafters.setTransferValidator(address(next));
        vm.stopPrank();
        assertEq(crafters.getTransferValidator(), address(next));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        crafters.setTransferValidator(address(validator));

        vm.expectRevert(MineWorldCrafters.NotAContract.selector);
        this.newCrafters(treasury, address(0), address(art));
        // The art must be a contract too.
        vm.expectRevert(MineWorldCrafters.NotAContract.selector);
        this.newCrafters(treasury, address(validator), makeAddr("noArt"));
    }

    // ---------------------------------------------------------------- owner

    /// Ownership can never be renounced (not before the reveal, not after), so the links can always be updated and
    /// OpenSea Studio, which lets only owner() edit the collection, always has an owner to let in. It moves only in two
    /// steps, so a transfer to 0 (or to anyone) changes nothing until that address accepts.
    function test_RenounceReverts() public {
        _mint(alice, 1);
        vm.prank(owner);
        vm.expectRevert(MineWorldCrafters.CannotRenounce.selector);
        crafters.renounceOwnership();
        assertEq(crafters.owner(), owner);
        vm.prank(owner);
        crafters.transferOwnership(address(0));
        assertEq(crafters.owner(), owner, "a transfer to 0 renounced it");
        assertEq(crafters.pendingOwner(), address(0));
        _reveal();
        vm.prank(owner);
        vm.expectRevert(MineWorldCrafters.CannotRenounce.selector);
        crafters.renounceOwnership();
        assertEq(crafters.owner(), owner);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        crafters.renounceOwnership();

        address next = makeAddr("next");
        vm.prank(owner);
        crafters.transferOwnership(next);
        assertEq(crafters.owner(), owner);
        vm.prank(next);
        crafters.acceptOwnership();
        assertEq(crafters.owner(), next);
        vm.prank(next);
        crafters.setLinks("https://mineworldcraft.fun/", "");
        vm.prank(next);
        crafters.setCollectionImages("https://mineworldcraft.fun/c.png", "");
    }

    /// The treasury can't be the collection itself (it refuses ETH, so every paid mint would fail).
    function test_TreasuryCantBeTheCollection() public {
        vm.prank(owner);
        vm.expectRevert(MineWorldCrafters.BadTreasury.selector);
        crafters.setTreasury(address(crafters));
        vm.prank(owner);
        vm.expectRevert(MineWorldCrafters.ZeroAddress.selector);
        crafters.setTreasury(address(0));
        vm.expectRevert(MineWorldCrafters.ZeroAddress.selector);
        this.newCrafters(address(0), address(validator), address(art));
    }

    /// Audit 0792975e #4: a treasury that refuses ETH would stop every paid mint (and a free one, once ETH is forced
    /// in), so it's refused up front, at deploy and in setTreasury. A wallet or a contract that takes ETH is fine.
    function test_TreasuryMustTakeEth() public {
        NoEthTreasury no = new NoEthTreasury();
        vm.prank(owner);
        vm.expectRevert(MineWorldCrafters.TreasuryRefusesEth.selector);
        crafters.setTreasury(address(no));
        vm.expectRevert(MineWorldCrafters.TreasuryRefusesEth.selector);
        this.newCrafters(address(no), address(validator), address(art));
        assertEq(crafters.treasury(), treasury);

        EthTreasury yes = new EthTreasury();
        vm.prank(owner);
        crafters.setTreasury(address(yes));
        _setPrice(PRICE);
        _mint(alice, 2);
        assertEq(address(yes).balance, 2 * PRICE);
        (address to,) = crafters.royaltyInfo(1, 1 ether);
        assertEq(to, address(yes));
        address wallet = makeAddr("wallet");
        vm.prank(owner);
        crafters.setTreasury(wallet);
        _mint(bob, 1);
        assertEq(wallet.balance, PRICE);
        this.newCrafters(address(yes), address(validator), address(art));
        this.newCrafters(wallet, address(validator), address(art));
    }

    /// Audit 0792975e #6, a trust assumption stated plainly: the owner can relax enforcement by pointing the
    /// collection at a validator that allows everything. It shows on chain; the 5% rate itself never changes.
    function test_OwnerCanRelaxEnforcementInTheOpen() public {
        _mint(alice, 1);
        vm.prank(alice);
        crafters.setApprovalForAll(market, true);
        vm.prank(market);
        vm.expectRevert(StrictValidator.UnauthorizedTransfer.selector);
        crafters.transferFrom(alice, bob, 1);
        PassValidator lax = new PassValidator();
        vm.expectEmit(address(crafters));
        emit ICreatorToken.TransferValidatorUpdated(address(validator), address(lax));
        vm.prank(owner);
        crafters.setTransferValidator(address(lax));
        vm.prank(market);
        crafters.transferFrom(alice, bob, 1);
        assertEq(crafters.ownerOf(1), bob);
        (, uint256 royalty) = crafters.royaltyInfo(1, 1 ether);
        assertEq(royalty, 0.05 ether);
    }

    // ---------------------------------------------------------------- the attributes extension (audit 0792975e #3)

    /// tokenURI(id) read the way a marketplace's eth_call reads it, with `gas`: whether it worked, and its JSON.
    function _readURI(uint256 id, uint256 gas) internal view returns (bool ok, string memory json) {
        bytes memory ret;
        (ok, ret) = address(crafters).staticcall{gas: gas}(abi.encodeCall(MineWorldCrafters.tokenURI, (id)));
        if (ok) json = Json.decodeURI(abi.decode(ret, (string)));
    }

    function _useExtension(address x) internal {
        vm.prank(owner);
        crafters.setAttributesExtension(x);
    }

    /// The eight traits and the rarity, and nothing from the extension after them.
    function _assertNoExtra(string memory json) internal view {
        assertEq(vm.parseJsonString(json, ".attributes[8].trait_type"), "Rarity");
        assertFalse(vm.keyExistsJson(json, ".attributes[9]"), "the extension's answer should have been left out");
    }

    /// An extension stuck in a loop gets EXTENSION_GAS, not all the gas: tokenURI still renders, sealed or revealed,
    /// under an RPC's usual eth_call budgets (10M and 30M), with no extra traits.
    function test_GasHungryExtensionCantBreakTokenURI() public {
        _mint(alice, 1);
        _useExtension(address(new GasHogExtension()));
        (bool ok, string memory json) = _readURI(1, 10_000_000);
        assertTrue(ok, "sealed: tokenURI ran out of gas");
        assertEq(vm.parseJsonString(json, ".attributes[0].value"), "Sealed");
        assertFalse(vm.keyExistsJson(json, ".attributes[1]"));
        _reveal();
        assertEq(crafters.extraAttributes(1), "");
        uint256[2] memory budgets = [uint256(10_000_000), 30_000_000];
        for (uint256 i; i < budgets.length; i++) {
            (ok, json) = _readURI(1, budgets[i]);
            assertTrue(ok, "revealed: tokenURI ran out of gas");
            _assertNoExtra(json);
        }
        assertEq(crafters.EXTENSION_GAS(), 300_000);
    }

    /// An extension that reverts, or returns nothing at all, adds nothing.
    function test_RevertingOrSilentExtensionAddsNothing() public {
        _mint(alice, 1);
        _reveal();
        address[2] memory xs = [address(new RevertingExtension()), address(new SilentExtension())];
        for (uint256 i; i < xs.length; i++) {
            _useExtension(xs[i]);
            assertEq(crafters.extraAttributes(1), "");
            (bool ok, string memory json) = _readURI(1, 10_000_000);
            assertTrue(ok);
            _assertNoExtra(json);
        }
    }

    /// Only one well-formed ABI string is used: the offset 0x20, a length the data holds, at most
    /// MAX_EXTRA_ATTRIBUTES bytes. Anything else (a short answer, another offset, a length past the data or a huge
    /// one, an answer too long, a return bomb) is left out; a string of exactly the maximum shows.
    function test_MalformedOrOversizedExtensionAddsNothing() public {
        _mint(alice, 1);
        _reveal();
        RawExtension raw = new RawExtension();
        _useExtension(address(raw));
        string memory trait = '{"trait_type":"Mood","value":"Calm"}';
        raw.set(abi.encode(trait));
        assertEq(crafters.extraAttributes(1), trait, "a well-formed answer shows");

        bytes[6] memory bad = [
            abi.encodePacked(uint256(0x20)), // shorter than an offset and a length
            abi.encode(uint256(0x40), uint256(0), trait), // a string, but not at 0x20
            abi.encodePacked(uint256(0x20), uint256(100), bytes32("too short for 100")),
            abi.encodePacked(uint256(0x20), type(uint256).max, bytes32("huge")),
            abi.encodePacked(uint256(0x20), type(uint256).max - 0x1f), // a length that wraps past the data
            abi.encode(_trait(crafters.MAX_EXTRA_ATTRIBUTES() + 1)) // one byte too long
        ];
        for (uint256 i; i < bad.length; i++) {
            raw.set(bad[i]);
            assertEq(crafters.extraAttributes(1), "", "a malformed answer was used");
            (bool ok, string memory json) = _readURI(1, 10_000_000);
            assertTrue(ok);
            _assertNoExtra(json);
        }

        string memory longest = _trait(crafters.MAX_EXTRA_ATTRIBUTES());
        raw.set(abi.encode(longest));
        assertEq(crafters.extraAttributes(1), longest);
        string memory full = Json.decodeURI(crafters.tokenURI(1));
        assertEq(vm.parseJsonString(full, ".attributes[9].trait_type"), "Note");

        _useExtension(address(new BombExtension()));
        assertEq(crafters.extraAttributes(1), "");
        (bool ok2, string memory json2) = _readURI(1, 30_000_000);
        assertTrue(ok2);
        _assertNoExtra(json2);
    }

    /// One JSON trait exactly `size` bytes long.
    function _trait(uint256 size) internal pure returns (string memory) {
        bytes memory pad = new bytes(size - 32);
        for (uint256 i; i < pad.length; i++) {
            pad[i] = "a";
        }
        string memory t = string.concat('{"trait_type":"Note","value":"', string(pad), '"}');
        assert(bytes(t).length == size);
        return t;
    }

    function test_OwnerOnly() public {
        vm.startPrank(alice);
        bytes memory notOwner = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice);
        vm.expectRevert(notOwner);
        crafters.setPrice(1);
        vm.expectRevert(notOwner);
        crafters.setWalletLimit(20);
        vm.expectRevert(notOwner);
        crafters.setTreasury(alice);
        vm.expectRevert(notOwner);
        crafters.setSaleOpen(false);
        vm.expectRevert(notOwner);
        crafters.setLinks("", "");
        vm.expectRevert(notOwner);
        crafters.setCollectionImages("", "");
        vm.expectRevert(notOwner);
        crafters.setContractURI("");
        vm.expectRevert(notOwner);
        crafters.reveal(SECRET);
        vm.expectRevert(notOwner);
        crafters.setAttributesExtension(address(0));
        vm.stopPrank();
    }
}

/// A validator that refuses every transfer.
contract RefuseAll {
    error No();

    function validateTransfer(address, address, address, uint256) external pure {
        revert No();
    }
}

/// A validator that allows every transfer: what relaxing enforcement looks like.
contract PassValidator {
    function validateTransfer(address, address, address, uint256) external pure {}
}

/// A treasury with no receive or fallback: it refuses ETH (audit 0792975e #4).
contract NoEthTreasury {}

/// A treasury contract that takes ETH.
contract EthTreasury {
    receive() external payable {}
}

/// Attributes extensions that misbehave (audit 0792975e #3); none of them may break tokenURI.
contract GasHogExtension {
    function attributesOf(uint256) external pure returns (string memory) {
        assembly {
            for {} 1 {} {}
        }
        return "";
    }
}

contract RevertingExtension {
    function attributesOf(uint256) external pure returns (string memory) {
        revert("no traits");
    }
}

/// attributesOf exists but returns nothing.
contract SilentExtension {
    function attributesOf(uint256) external pure {}
}

/// Answers attributesOf (any call) with whatever bytes it was given.
contract RawExtension {
    bytes internal reply;

    function set(bytes calldata r) external {
        reply = r;
    }

    fallback() external {
        bytes memory r = reply;
        assembly {
            return(add(r, 0x20), mload(r))
        }
    }
}

/// Answers with a megabyte: more memory than its gas can pay for.
contract BombExtension {
    fallback() external {
        assembly {
            return(0, 1000000)
        }
    }
}

/// Audit 0792975e #1, the auditor's proof, adapted to the flow that replaced the one it was written for (re-check
/// 8c7ba957 #2).
contract OkValidator {
    function validateTransfer(address, address, address, uint256) external view {}
}

/// The auditor's point stands: the owner must not be able to pick a seed by picking when to act. In the current flow
/// the owner's one choice is when to publish the secret (`reveal`), and the seed then waits for the hash of the next
/// block, which doesn't exist when the owner decides. So the proof now checks (a) at every block the owner could
/// reveal in, the seed that reveal leads to can't be worked out yet, and a reveal can't be taken back; (b) once
/// revealed, the seed is the same whenever, and by whomever, `seal` is sent.
contract RevealSeedTest is Test {
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    uint256 secret = 12345;

    function _collection() internal returns (MineWorldCrafters c) {
        CrafterArt art = new CrafterArt();
        OkValidator v = new OkValidator();
        c = new MineWorldCrafters(owner, owner, 0, keccak256(abi.encode(secret)), address(v), art);
        vm.prank(owner);
        c.setSaleOpen(true);
        vm.prank(alice);
        c.mint(3); // (5 in the auditor's original: the launch allows 3 a wallet now)
        vm.prank(owner);
        c.setSaleOpen(false);
    }

    /// blockhash(n) now, in its own call.
    function hashOf(uint256 n) external view returns (bytes32) {
        return blockhash(n);
    }

    /// The same closed sale, revealed one block later or seven blocks later: neither reveal lets the owner see the seed
    /// it leads to; and a reveal sealed one block or seven blocks after its entropy block gives every Crafter the same
    /// look.
    function test_SeedDoesNotDependOnTheRevealBlock() public {
        MineWorldCrafters c = _collection();
        uint256 closed = vm.getBlockNumber();
        uint256[2] memory laters = [uint256(1), 7];
        for (uint256 i; i < 2; i++) {
            uint256 snap = vm.snapshotState();
            vm.roll(closed + laters[i]);
            vm.prank(owner);
            c.reveal(secret);
            assertEq(this.hashOf(c.entropyBlock()), 0, "the owner could see the seed's entropy when it chose to reveal");
            vm.revertToState(snap);
        }

        vm.roll(closed + 1);
        vm.prank(owner);
        c.reveal(secret);
        uint256 e = c.entropyBlock();
        uint256 snap2 = vm.snapshotState();
        vm.roll(e + 1);
        c.seal();
        uint256 seedA = c.seed();
        vm.revertToState(snap2);
        vm.roll(e + 7);
        vm.prank(alice);
        c.seal();
        uint256 seedB = c.seed();
        assertTrue(seedA != 0);
        assertEq(seedA, seedB, "the seed depends on when it is sealed");
    }

    /// The specialists' version: however long the owner looks for a block that makes its own Crafter #1 Legendary,
    /// it never sees the seed before committing to it, and can't take a reveal back to try again.
    function test_OwnerCantGrindItsOwnCrafterToLegendary() public {
        MineWorldCrafters c = _collection();
        uint256 closed = vm.getBlockNumber();
        for (uint256 later = 1; later <= 256; later += 5) {
            uint256 snap = vm.snapshotState();
            vm.roll(closed + later);
            vm.prank(owner);
            c.reveal(secret);
            assertEq(this.hashOf(c.entropyBlock()), 0, "the owner saw the entropy before committing");
            vm.prank(owner);
            vm.expectRevert(MineWorldCrafters.AlreadyRevealed.selector);
            c.reveal(secret);
            vm.prank(owner);
            vm.expectRevert(MineWorldCrafters.AlreadyRevealed.selector);
            c.setSaleOpen(true);
            vm.revertToState(snap);
        }
    }
}

/// Stands in for ArbSys at 0x64 in tests: an L2 block number the test sets and, for each L2 block, a hash of its own
/// (made up), given only for the last 256 blocks before the current one, as ArbSys does.
contract MockArbSys {
    error InvalidBlockNumber(uint256 requested, uint256 current);

    uint256 public number;
    bool public broken;

    function setNumber(uint256 n) external {
        number = n;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function arbBlockNumber() external view returns (uint256) {
        return number;
    }

    function arbBlockHash(uint256 n) external view returns (bytes32) {
        if (broken) revert("broken");
        if (n >= number || n + 256 < number) revert InvalidBlockNumber(n, number);
        return l2Hash(n);
    }

    function l2Hash(uint256 n) public pure returns (bytes32) {
        return keccak256(abi.encode("L2 block", n));
    }
}

/// The registry's side of OpenSea's fee-checked sales, called by the SignedZone around a transfer.
interface IAuthorizer {
    function beforeAuthorizedTransfer(address token, uint256 tokenId) external;
    function afterAuthorizedTransfer(address token, uint256 tokenId) external;
}

/// Stand-in for the SignedZone's calls around a sale.
contract ZoneFlow {
    function sell(address registry, address token, address market, address from, address to, uint256 id) external {
        IAuthorizer(registry).beforeAuthorizedTransfer(token, id);
        MarketMove(market).move(token, from, to, id);
        IAuthorizer(registry).afterAuthorizedTransfer(token, id);
    }
}

/// Stand-in for the marketplace moving the sold token.
contract MarketMove {
    function move(address token, address from, address to, uint256 id) external {
        IERC721(token).transferFrom(from, to, id);
    }
}

/// OpenSea's registry: the collection's policy there.
interface IOpenSeaRegistry {
    function getAuthorizerAccountsByCollection(address collection) external view returns (address[] memory);
    function applyListToCollection(address collection, uint120 id) external;
}

/// @notice Against OpenSea's real creator fee enforcement registry on Robinhood Chain.
///   forge test --match-contract MineWorldCraftersForkTest --fork-url robinhood
/// Skipped when not forked.
contract MineWorldCraftersForkTest is Test {
    address constant REGISTRY = 0xA000027A9B2802E1ddf7000061001e5c005A0000; // StrictAuthorizedTransferSecurityRegistry
    address constant SEAPORT = 0x0000000000000068F116a894984e2DB1123eB395; // Seaport 1.6
    bytes4 constant UNAUTHORIZED = 0x1de5204e; // StrictAuthorizedTransferSecurityRegistry__UnauthorizedTransfer()
    address constant SIGNED_ZONE = 0x000056F7000000EcE9003ca63978907a00FFD100; // OpenSea's SignedZone

    MineWorldCrafters crafters;
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        if (block.chainid != 4663) return;
        crafters = new MineWorldCrafters(owner, makeAddr("treasury"), 0, keccak256(abi.encode(uint256(7))), REGISTRY, new CrafterArt());
        vm.prank(owner);
        crafters.setSaleOpen(true);
        vm.prank(alice);
        crafters.mint(2);
    }

    function test_Fork_HolderTransfersPass() public {
        vm.skip(block.chainid != 4663);
        vm.prank(alice);
        crafters.transferFrom(alice, bob, 1);
        assertEq(crafters.ownerOf(1), bob);
    }

    /// A real OpenSea sale, as one transaction like Seaport runs it: the SignedZone (which checks the order pays
    /// the creator fee) authorizes the token on the live registry, the approved marketplace moves it, and the
    /// zone clears the flag. The registry keeps the flag in transient storage, so it only lives inside that
    /// transaction; the zone and Seaport addresses get stand-in code that makes exactly those calls.
    function test_Fork_SaleAuthorizedByOpenSeaGoesThrough() public {
        vm.skip(block.chainid != 4663);
        vm.etch(SIGNED_ZONE, address(new ZoneFlow()).code);
        vm.etch(SEAPORT, address(new MarketMove()).code);
        vm.prank(alice);
        crafters.setApprovalForAll(SEAPORT, true);
        ZoneFlow(SIGNED_ZONE).sell(REGISTRY, address(crafters), SEAPORT, alice, bob, 2);
        assertEq(crafters.ownerOf(2), bob);
        // Without the zone, the same marketplace is refused.
        vm.prank(bob);
        crafters.setApprovalForAll(SEAPORT, true);
        vm.prank(SEAPORT);
        vm.expectRevert(UNAUTHORIZED);
        crafters.transferFrom(bob, alice, 2);
    }

    /// Only an authorizer on the collection's list (OpenSea's zone on the default list) can authorize.
    function test_Fork_StrangersCantAuthorize() public {
        vm.skip(block.chainid != 4663);
        vm.etch(SEAPORT, address(new MarketMove()).code);
        ZoneFlow stranger = new ZoneFlow();
        vm.prank(alice);
        crafters.setApprovalForAll(SEAPORT, true);
        vm.expectRevert();
        stranger.sell(REGISTRY, address(crafters), SEAPORT, alice, bob, 1);
        assertEq(crafters.ownerOf(1), alice);
    }

    /// Seaport, or any approved operator, can't move a Crafter outside OpenSea's fee-checked flow.
    function test_Fork_MarketplaceWithoutFeeCheckReverts() public {
        vm.skip(block.chainid != 4663);
        vm.prank(alice);
        crafters.setApprovalForAll(SEAPORT, true);
        vm.prank(SEAPORT);
        vm.expectRevert(UNAUTHORIZED);
        crafters.transferFrom(alice, bob, 2);

        address otherMarket = makeAddr("otherMarket");
        vm.prank(alice);
        crafters.setApprovalForAll(otherMarket, true);
        vm.prank(otherMarket);
        vm.expectRevert(UNAUTHORIZED);
        crafters.transferFrom(alice, bob, 2);
        assertEq(crafters.ownerOf(2), alice);
    }

    /// Audit 0792975e #6: nothing to register after deploy. A collection that never configured anything on OpenSea's
    /// registry gets its default list, whose one authorizer is OpenSea's SignedZone, so the fee is enforced as the
    /// tests above show. Only the collection's owner can change its policy there (the trust the docs state).
    function test_Fork_EnforcedWithoutRegistering() public {
        vm.skip(block.chainid != 4663);
        address[] memory authorizers = IOpenSeaRegistry(REGISTRY).getAuthorizerAccountsByCollection(address(crafters));
        assertEq(authorizers.length, 1);
        assertEq(authorizers[0], SIGNED_ZONE);
        vm.prank(alice);
        vm.expectRevert();
        IOpenSeaRegistry(REGISTRY).applyListToCollection(address(crafters), 0);
        vm.prank(owner);
        IOpenSeaRegistry(REGISTRY).applyListToCollection(address(crafters), 0); // (list 0: the default it has anyway)
    }

    /// ArbSys is at 0x64 on Robinhood Chain (its marker code 0xfe), so the reveal counts in L2 blocks there, not in
    /// `block.number`, which follows the parent chain (Forge's fork gives both, as the chain does). Forge doesn't run
    /// ArbOS itself: its stand-in answers arbBlockNumber with the fork's block, fixed, and not arbBlockHash, so the
    /// reveal below mocks the two calls. The real ArbSys was checked live (AUDIT.md section 9).
    function test_Fork_ArbSysIsThere() public {
        vm.skip(block.chainid != 4663);
        assertEq(address(100).code, hex"fe");
        assertEq(crafters.ARB_SYS(), address(100));
        assertGt(crafters.chainBlock(), block.number, "the reveal counts in ArbSys's L2 blocks, not the parent chain's");
    }

    /// The art renders on the real chain's EVM too (a view, as marketplaces call it).
    function test_Fork_TokenURIRendersOnChain() public {
        vm.skip(block.chainid != 4663);
        vm.prank(owner);
        crafters.setSaleOpen(false);
        vm.prank(owner);
        crafters.reveal(7);
        uint256 e = crafters.entropyBlock();
        assertEq(e, crafters.chainBlock() + 1);
        // (See test_Fork_ArbSysIsThere: ArbSys answered as on chain once the entropy block is over.)
        vm.mockCall(address(100), abi.encodeWithSignature("arbBlockNumber()"), abi.encode(e + 1));
        vm.mockCall(address(100), abi.encodeWithSignature("arbBlockHash(uint256)", e), abi.encode(keccak256("L2 block")));
        crafters.seal();
        assertEq(crafters.seed(), uint256(keccak256(abi.encode(uint256(7), keccak256("L2 block")))));
        assertTrue(bytes(crafters.tokenURI(1)).length > 10_000);
    }
}
