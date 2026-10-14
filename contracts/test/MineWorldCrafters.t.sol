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

    /// Close the sale, wait a block, reveal: the order the contract requires.
    function _reveal() internal {
        vm.prank(owner);
        crafters.setSaleOpen(false);
        vm.roll(block.number + 1);
        vm.prank(owner);
        crafters.reveal(SECRET);
    }

    // ---------------------------------------------------------------- mint

    function test_TheCollection() public view {
        assertEq(crafters.name(), "MineWorld Crafters");
        assertEq(crafters.symbol(), "CRAFTER");
        assertEq(crafters.MAX_SUPPLY(), 3333);
        assertEq(crafters.MAX_PER_TX(), 5);
        assertEq(crafters.walletLimit(), 10);
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
        vm.prank(alice);
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

    /// Each wallet mints at most `walletLimit` in all (10 at launch), counted by what it minted, not what it holds.
    function test_WalletLimit() public {
        _mint(alice, 5);
        _mint(alice, 5);
        vm.prank(alice);
        vm.expectRevert(MineWorldCrafters.WalletLimit.selector);
        crafters.mint(1);
        // Giving them away doesn't make room.
        vm.prank(alice);
        crafters.transferFrom(alice, bob, 1);
        vm.prank(alice);
        vm.expectRevert(MineWorldCrafters.WalletLimit.selector);
        crafters.mint(1);
        assertEq(crafters.mintedBy(alice), 10);
        // A partial mint over the limit is refused whole.
        _mint(bob, 5);
        _mint(bob, 4);
        vm.prank(bob);
        vm.expectRevert(MineWorldCrafters.WalletLimit.selector);
        crafters.mint(2);
        _mint(bob, 1);

        // The owner raises it (up to 50) or lowers it (to 1).
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.WalletLimitSet(12);
        vm.prank(owner);
        crafters.setWalletLimit(12);
        _mint(alice, 2);
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
        crafters.setSaleOpen(false);
        vm.roll(block.number + 1);
        vm.prank(owner);
        vm.expectRevert(MineWorldCrafters.BadSecret.selector);
        crafters.reveal(1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        crafters.reveal(SECRET);

        _reveal();
        assertFalse(crafters.saleOpen());
        assertTrue(crafters.seed() != 0);
        vm.startPrank(owner);
        vm.expectRevert(MineWorldCrafters.AlreadyRevealed.selector);
        crafters.reveal(SECRET);
        vm.expectRevert(MineWorldCrafters.AlreadyRevealed.selector);
        crafters.setSaleOpen(true);
        vm.stopPrank();
        crafters.traitsOf(1);
        // Only minted tokens have traits.
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 3));
        crafters.traitsOf(3);
    }

    /// Audit 25e6a0b3 #1: the reveal's entropy must not exist while anyone can still mint.
    function test_RevealNeedsTheSaleClosedInAnEarlierBlock() public {
        _mint(alice, 2);
        uint256 b = block.number + 3; // explicit numbers: via-IR may reuse one read of block.number
        vm.roll(b);
        vm.startPrank(owner);
        vm.expectRevert(MineWorldCrafters.SaleStillOpen.selector);
        crafters.reveal(SECRET);
        crafters.setSaleOpen(false);
        assertEq(crafters.saleClosedAt(), b);
        vm.expectRevert(MineWorldCrafters.RevealTooSoon.selector);
        crafters.reveal(SECRET);
        // Reopening and closing again moves the reveal to after the new close.
        vm.roll(b + 1);
        crafters.setSaleOpen(true);
        crafters.setSaleOpen(false);
        assertEq(crafters.saleClosedAt(), b + 1);
        vm.expectRevert(MineWorldCrafters.RevealTooSoon.selector);
        crafters.reveal(SECRET);
        vm.roll(b + 2);
        crafters.reveal(SECRET);
        vm.stopPrank();
        assertTrue(crafters.seed() != 0);
    }

    /// The audit's proof: the owner computes the seed from the secret and the current block, mints the next
    /// ones, and reveals in the same block. The reveal refuses, so the prediction is worthless.
    function test_OwnerCantMintKnowingTheLooks() public {
        _mint(alice, 5);
        vm.roll(block.number + 10);
        vm.startPrank(owner);
        crafters.mint(5);
        vm.expectRevert(MineWorldCrafters.SaleStillOpen.selector);
        crafters.reveal(SECRET);
        crafters.setSaleOpen(false);
        vm.expectRevert(MineWorldCrafters.RevealTooSoon.selector);
        crafters.reveal(SECRET);
        vm.stopPrank();
    }

    /// The seed is the secret mixed with the previous block's hash, and never 0.
    function test_SeedComesFromTheSecretAndTheBlock() public {
        _mint(alice, 1);
        vm.prank(owner);
        crafters.setSaleOpen(false);
        vm.roll(block.number + 5);
        uint256 expected = uint256(keccak256(abi.encode(SECRET, blockhash(block.number - 1))));
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.Revealed(expected);
        vm.prank(owner);
        crafters.reveal(SECRET);
        assertEq(crafters.seed(), expected);
    }

    function testFuzz_DifferentSeedsGiveValidTraits(uint256 secret) public {
        MineWorldCrafters s = new MineWorldCrafters(owner, treasury, 0, keccak256(abi.encode(secret)), address(validator), art);
        vm.prank(owner);
        s.setSaleOpen(true);
        vm.prank(alice);
        s.mint(5);
        vm.prank(owner);
        s.setSaleOpen(false);
        vm.roll(block.number + 1);
        vm.prank(owner);
        s.reveal(secret);
        for (uint256 id = 1; id <= 5; id++) {
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
        assertEq(vm.parseJsonString(sealedJson, ".name"), "MineWorld Crafter #1");
        assertEq(vm.parseJsonString(sealedJson, ".image"), string.concat("data:image/svg+xml;base64,", vm.toBase64(art.sealedSvg())));
        assertEq(vm.parseJsonString(sealedJson, ".attributes[0].value"), "Sealed");
        _reveal();
        string memory json = Json.decodeURI(crafters.tokenURI(1));
        Traits memory t = crafters.traitsOf(1);
        assertEq(vm.parseJsonString(json, ".name"), "MineWorld Crafter #1");
        assertEq(vm.parseJsonString(json, ".image"), string.concat("data:image/svg+xml;base64,", vm.toBase64(art.render(t))));
        assertEq(vm.parseJsonString(json, ".attributes[0].trait_type"), "Background");
        assertEq(vm.parseJsonString(json, ".attributes[0].value"), art.traitName(0, t.background));
        assertEq(vm.parseJsonString(json, ".attributes[7].trait_type"), "Outfit");
        assertEq(vm.parseJsonString(json, ".attributes[7].value"), art.traitName(7, t.outfit));
        assertEq(vm.parseJsonString(json, ".attributes[8].trait_type"), "Rarity");
        assertFalse(vm.keyExistsJson(json, ".attributes[9]"), "no extra traits without an extension");
        assertTrue(Json.has(json, "boosts its owner's mining in MineWorldCraft by its rarity and level"));
        assertFalse(Json.has(json, "Cosmetic"));
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 2));
        crafters.tokenURI(2);
    }

    /// Audit 25e6a0b3 #3: the reveal tells marketplaces to re-read every token (ERC-4906).
    function test_RevealRefreshesMarketplaces() public {
        _mint(alice, 3);
        assertTrue(crafters.supportsInterface(0x49064906));
        vm.prank(owner);
        crafters.setSaleOpen(false);
        vm.roll(block.number + 1);
        vm.expectEmit(address(crafters));
        emit MineWorldCrafters.BatchMetadataUpdate(1, 3);
        vm.prank(owner);
        crafters.reveal(SECRET);
    }

    /// Before any link or picture is set, the collection page has only its name and description.
    function test_CollectionMetadataWithoutLinks() public view {
        string memory json = Json.decodeURI(crafters.contractURI());
        assertEq(vm.parseJsonString(json, ".name"), "MineWorld Crafters");
        assertFalse(Json.has(json, "external_link"));
        assertFalse(Json.has(json, '"image"'));
        assertFalse(Json.has(json, "banner_image"));
        assertFalse(Json.has(json, "Website:"));
        assertFalse(Json.has(json, "Social:"));
        assertTrue(Json.has(json, 'Each Crafter boosts its owner\'s mining in MineWorldCraft by its rarity and level: faster mining, more $MINE per block and a higher daily cap, for active play only."'));
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
        _mint(alice, 5);
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

    /// Ownership can never be renounced (not even once revealed), so the links can always be updated. It moves in
    /// two steps.
    function test_RenounceReverts() public {
        _mint(alice, 1);
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

    /// The art renders on the real chain's EVM too (a view, as marketplaces call it).
    function test_Fork_TokenURIRendersOnChain() public {
        vm.skip(block.chainid != 4663);
        vm.prank(owner);
        crafters.setSaleOpen(false);
        vm.roll(block.number + 1);
        vm.prank(owner);
        crafters.reveal(7);
        assertTrue(bytes(crafters.tokenURI(1)).length > 10_000);
    }
}
