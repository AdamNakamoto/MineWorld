// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {CrafterArt, CrafterRules, Traits} from "../src/CrafterArt.sol";
import {MineWorldCrafters} from "../src/MineWorldCrafters.sol";
import {CrafterVectors} from "./CrafterVectors.sol";
import {FastBase64} from "../src/lib/FastBase64.sol";
import {StrictValidator, Json} from "./MineWorldCrafters.t.sol";

/// Exposes the traits for any seed, and sets the seed and mints any id directly (tests only). (Its treasury is a
/// plain address: the test contract deploying it takes no ETH, so it couldn't be the treasury.)
contract CraftersHarness is MineWorldCrafters {
    constructor(address validator, CrafterArt art_)
        MineWorldCrafters(msg.sender, address(0x7EA5), 0, bytes32(0), validator, art_)
    {}

    function setSeed(uint256 s) external {
        seed = s;
    }

    function mintId(address to, uint256 id) external {
        _mint(to, id);
    }

    function traitsFor(uint256 s, uint256 id) external pure returns (Traits memory) {
        return _traitsFor(s, id);
    }

    function shuffle(uint256 s, uint256 x) external pure returns (uint256) {
        return _shuffle(s, x);
    }
}

/// Exposes a DEGEN's skin as the game's texture holds it: 64 x 64 RGBA bytes, row by row (empty pixels all zero), as
/// skinPixels() in web/degen-skin.js gives it (tests only: the collection itself only shows the card).
contract ArtHarness is CrafterArt {
    function skin(Traits calldata t) external pure returns (bytes memory rgba) {
        uint256 canvas = _skin(t);
        rgba = new bytes(16384);
        assembly ("memory-safe") {
            let out := add(rgba, 32)
            for { let i := 0 } lt(i, 4096) { i := add(i, 1) } {
                let c := mload(add(canvas, shl(5, i)))
                // 0x1rrggbb, or 0: rr gg bb ff, or four zeros.
                if c { mstore(add(out, shl(2, i)), shl(224, or(shl(8, and(c, 0xffffff)), 0xff))) }
            }
        }
    }
}

/// The on-chain art and traits against the JS that defines them (web/degen-skin.js, web/degen-skin-art.js): every
/// expected value in CrafterVectors.sol was worked out by the JS (tools/gen-degen-art.mjs).
contract CrafterArtTest is Test {
    ArtHarness art;
    CraftersHarness crafters;

    function setUp() public {
        art = new ArtHarness();
        crafters = new CraftersHarness(address(new StrictValidator()), art);
    }

    /// The generated files must come from the JS as it is now. If this fails, run
    /// `~/.local/node/bin/node tools/gen-degen-art.mjs` and run the tests again.
    function test_ArtIsUpToDateWithTheJs() public view {
        string memory hint = ": changed since CrafterArt.sol was generated; run ~/.local/node/bin/node tools/gen-degen-art.mjs";
        assertEq(keccak256(vm.readFileBinary("../web/degen-skin-art.js")), CrafterVectors.ART_JS, string.concat("web/degen-skin-art.js", hint));
        assertEq(keccak256(vm.readFileBinary("../web/degen-skin.js")), CrafterVectors.RULES_JS, string.concat("web/degen-skin.js", hint));
        assertEq(keccak256(vm.readFileBinary("../tools/gen-degen-art.mjs")), CrafterVectors.GENERATOR, string.concat("tools/gen-degen-art.mjs", hint));
    }

    // ---------------------------------------------------------------- pictures

    /// Every option of every trait: the skin pixel for pixel as skinPixels() paints it, the card byte for byte as
    /// cardSvg() writes it, the attributes and the rarity.
    function test_RenderMatchesTheJs() public view {
        CrafterVectors.Look[] memory v = CrafterVectors.looks();
        for (uint256 i; i < v.length; i++) {
            string memory at = string.concat("look ", vm.toString(i));
            bytes memory svg = bytes(art.render(v[i].traits));
            assertEq(svg.length, v[i].cardLength, string.concat(at, ": card length"));
            assertEq(keccak256(svg), v[i].card, string.concat(at, ": card"));
            assertEq(keccak256(art.skin(v[i].traits)), v[i].skin, string.concat(at, ": skin"));
            assertEq(keccak256(bytes(art.attributes(v[i].traits))), v[i].attributes, string.concat(at, ": attributes"));
            assertEq(art.rarityOf(v[i].traits), v[i].rarity, string.concat(at, ": rarity"));
        }
    }

    function test_SealedPictureMatchesTheJs() public view {
        bytes memory svg = bytes(art.sealedSvg());
        assertEq(svg.length, CrafterVectors.SEALED_SVG_LENGTH);
        assertEq(keccak256(svg), CrafterVectors.SEALED_SVG);
    }

    function test_TraitNamesMatchTheJs() public {
        uint256[11] memory counts = [
            CrafterRules.BACKGROUNDS, CrafterRules.SKINS, CrafterRules.EYES, CrafterRules.MOUTHS, CrafterRules.CHEEKS,
            CrafterRules.TOPS, CrafterRules.BOTTOMS, CrafterRules.SHOES, CrafterRules.HEADWEAR, CrafterRules.ACCESSORIES,
            CrafterRules.RARITIES
        ];
        bytes32[11] memory expected = CrafterVectors.names();
        for (uint256 kind; kind < 11; kind++) {
            string memory all = art.traitName(kind, 0);
            for (uint256 i = 1; i < counts[kind]; i++) all = string.concat(all, "|", art.traitName(kind, i));
            assertEq(keccak256(bytes(all)), expected[kind], vm.toString(kind));
            vm.expectRevert(CrafterArt.BadTraits.selector);
            art.traitName(kind, counts[kind]);
        }
        vm.expectRevert(CrafterArt.BadTraits.selector);
        art.traitName(11, 0);
        assertEq(art.traitName(0, 0), "Sky");
        assertEq(art.traitName(1, 8), "Gold");
        assertEq(art.traitName(2, 5), "Starry");
        assertEq(art.traitName(5, 0), "Hoodie Grey");
        assertEq(art.traitName(5, 41), "Miner's Vest Orange");
        assertEq(art.traitName(5, 57), "Knight Armour Gold");
        assertEq(art.traitName(8, 0), "None");
        assertEq(art.traitName(8, CrafterRules.HOOD), "Hood");
        assertEq(art.traitName(10, 0), "Common");
        assertEq(art.traitName(10, 1), "Rare");
        assertEq(art.traitName(10, 2), "Legendary");
    }

    /// Nothing worn hides the blush (the pre-launch review found glasses and the hood covering it, so two DEGENs that
    /// differed only in cheeks could look the same): with glasses (accessory 2) and with the hood (headwear 22) up, a
    /// blush still changes the picture. tools/degen-skin-check.mjs --faces checks every face under everything worn.
    function test_BlushShowsUnderGlassesAndTheHood() public view {
        Traits memory a = Traits(0, 0, 1, 1, 0, 5, 0, 0, 0, 2);
        Traits memory b = Traits(0, 0, 1, 1, 1, 5, 0, 0, 0, 2);
        assertTrue(keccak256(bytes(art.render(a))) != keccak256(bytes(art.render(b))), "glasses hide the blush");
        a.accessory = 0;
        b.accessory = 0;
        a.headwear = 22;
        b.headwear = 22;
        assertTrue(keccak256(bytes(art.render(a))) != keccak256(bytes(art.render(b))), "the hood hides the blush");
    }

    function test_TraitsPastTheTablesRevert() public {
        Traits memory ok = Traits(9, 8, 5, 4, 1, 57, 11, 7, 22, 9);
        art.render(ok);
        art.attributes(ok);
        assertEq(art.rarityOf(ok), 2);
        for (uint256 f; f < 10; f++) {
            Traits memory t = ok;
            if (f == 0) t.background = 10;
            if (f == 1) t.skin = 9;
            if (f == 2) t.eyes = 6;
            if (f == 3) t.mouth = 5;
            if (f == 4) t.cheeks = 2;
            if (f == 5) t.top = 58;
            if (f == 6) t.bottoms = 12;
            if (f == 7) t.shoes = 8;
            if (f == 8) t.headwear = 23;
            if (f == 9) t.accessory = 10;
            vm.expectRevert(CrafterArt.BadTraits.selector);
            art.render(t);
            vm.expectRevert(CrafterArt.BadTraits.selector);
            art.attributes(t);
            vm.expectRevert(CrafterArt.BadTraits.selector);
            art.rarityOf(t);
        }
    }

    /// Bottoms and Shoes are listed only when the top doesn't bring its own trousers or boots: a hoodie shows both,
    /// a suit (its own trousers) no Bottoms, a space suit (trousers and boots) neither.
    function test_BottomsAndShoesFollowTheTop() public view {
        string[3] memory names = [art.traitName(5, 0), art.traitName(5, 30), art.traitName(5, 54)];
        assertEq(names[0], "Hoodie Grey");
        assertEq(names[1], "Suit Black");
        assertEq(names[2], "Space Suit White");
        uint8[3] memory tops = [0, 30, 54];
        uint256[3] memory kinds = [uint256(11), 10, 9];
        for (uint256 i; i < 3; i++) {
            string memory json = string.concat('{"attributes":', art.attributes(Traits(0, 0, 0, 0, 0, tops[i], 3, 4, 0, 0)), "}");
            assertEq(Json.rarityAt(json) + 1, kinds[i]);
            assertEq(Json.has(json, '"Bottoms"'), i == 0);
            assertEq(Json.has(json, '"Shoes"'), i < 2);
        }
    }

    // ---------------------------------------------------------------- traits

    /// traitsOf(seed, id) as web/degen-skin.js works it out, under several seeds, and each token's skin, card,
    /// attributes and rarity.
    function test_TraitsMatchTheJs() public view {
        CrafterVectors.Token[] memory v = CrafterVectors.tokens();
        uint256[3] memory seeds = CrafterVectors.seeds();
        for (uint256 i; i < v.length; i++) {
            Traits memory t = crafters.traitsFor(seeds[v[i].seed], v[i].id);
            string memory at = string.concat("seed ", vm.toString(v[i].seed), " token ", vm.toString(v[i].id));
            assertEq(abi.encode(t), abi.encode(v[i].traits), string.concat(at, ": traits"));
            bytes memory svg = bytes(art.render(t));
            assertEq(svg.length, v[i].cardLength, string.concat(at, ": card length"));
            assertEq(keccak256(svg), v[i].card, string.concat(at, ": card"));
            assertEq(keccak256(art.skin(t)), v[i].skin, string.concat(at, ": skin"));
            assertEq(keccak256(bytes(art.attributes(t))), v[i].attributes, string.concat(at, ": attributes"));
            assertEq(art.rarityOf(t), v[i].rarity, string.concat(at, ": rarity"));
        }
    }

    /// Every one of the 3,333 under each seed: their traits and rarities, the whole run of them, exactly as the JS.
    function test_EveryTokensTraitsMatchTheJs() public view {
        uint256[3] memory seeds = CrafterVectors.seeds();
        bytes32[3] memory traitRuns = CrafterVectors.traitsRuns();
        bytes32[3] memory rarityRuns = CrafterVectors.rarityRuns();
        uint256[3][3] memory expected = CrafterVectors.rarityCounts();
        for (uint256 k; k < seeds.length; k++) {
            bytes memory run = new bytes(10 * CrafterRules.SUPPLY);
            bytes memory rarities = new bytes(CrafterRules.SUPPLY);
            uint256[3] memory counts;
            for (uint256 id = 1; id <= CrafterRules.SUPPLY; id++) {
                Traits memory t = crafters.traitsFor(seeds[k], id);
                bytes10 packed = bytes10(abi.encodePacked(t.background, t.skin, t.eyes, t.mouth, t.cheeks, t.top, t.bottoms, t.shoes, t.headwear, t.accessory));
                for (uint256 b; b < 10; b++) run[10 * (id - 1) + b] = packed[b];
                uint8 r = CrafterRules.rarity(t);
                rarities[id - 1] = bytes1(r);
                counts[r]++;
            }
            assertEq(keccak256(run), traitRuns[k], string.concat("seed ", vm.toString(k), ": traits"));
            assertEq(keccak256(rarities), rarityRuns[k], string.concat("seed ", vm.toString(k), ": rarities"));
            assertEq(abi.encode(counts), abi.encode(expected[k]));
            console2.log("rarity over the 3,333, seed", k);
            console2.log("  Common, Rare, Legendary:", counts[0], counts[1], counts[2]);
        }
    }

    /// The whole token: valid JSON, its name, the picture as a base64 data URI of render(traits), the attributes
    /// (named by traitName), Rarity last.
    function test_TokenURIMatchesTheJs() public {
        CrafterVectors.Token[] memory v = CrafterVectors.tokens();
        crafters.setSeed(CrafterVectors.SEED);
        address holder = makeAddr("holder");
        for (uint256 i; i < v.length; i++) if (v[i].seed == 0) crafters.mintId(holder, v[i].id);
        for (uint256 i; i < v.length; i += 3) {
            if (v[i].seed != 0) continue;
            string memory json = Json.decodeURI(crafters.tokenURI(v[i].id));
            string memory svg = art.render(v[i].traits);
            assertEq(keccak256(bytes(svg)), v[i].card);
            assertEq(vm.parseJsonString(json, ".name"), string.concat("I'M DEGEN #", vm.toString(v[i].id)));
            assertEq(vm.parseJsonString(json, ".image"), string.concat("data:image/svg+xml;base64,", vm.toBase64(svg)));
            assertTrue(bytes(vm.parseJsonString(json, ".description")).length > 0);
            // The traits, in order, by name (Bottoms and Shoes only when the top shows them), then the rarity.
            Traits memory t = v[i].traits;
            uint256 k;
            k = _attr(json, k, "Background", art.traitName(0, t.background));
            k = _attr(json, k, "Skin", art.traitName(1, t.skin));
            k = _attr(json, k, "Eyes", art.traitName(2, t.eyes));
            k = _attr(json, k, "Mouth", art.traitName(3, t.mouth));
            k = _attr(json, k, "Cheeks", art.traitName(4, t.cheeks));
            k = _attr(json, k, "Top", art.traitName(5, t.top));
            if (!CrafterRules.legs(t.top)) k = _attr(json, k, "Bottoms", art.traitName(6, t.bottoms));
            if (!CrafterRules.feet(t.top)) k = _attr(json, k, "Shoes", art.traitName(7, t.shoes));
            k = _attr(json, k, "Headwear", art.traitName(8, t.headwear));
            k = _attr(json, k, "Accessory", art.traitName(9, t.accessory));
            k = _attr(json, k, "Rarity", art.traitName(10, v[i].rarity));
            assertEq(crafters.rarityOf(v[i].id), v[i].rarity);
            assertFalse(vm.keyExistsJson(json, string.concat(".attributes[", vm.toString(k), "]")));
        }
    }

    /// Attribute `k` is {"trait_type": kind, "value": value}; the next one's index.
    function _attr(string memory json, uint256 k, string memory kind, string memory value) internal pure returns (uint256) {
        string memory at = string.concat(".attributes[", vm.toString(k), "]");
        assertEq(vm.parseJsonString(json, string.concat(at, ".trait_type")), kind);
        assertEq(vm.parseJsonString(json, string.concat(at, ".value")), value);
        return k + 1;
    }

    function test_SealedTokenURI() public {
        crafters.mintId(makeAddr("holder"), 7);
        string memory json = Json.decodeURI(crafters.tokenURI(7));
        assertEq(vm.parseJsonString(json, ".name"), "I'M DEGEN #7");
        assertEq(vm.parseJsonString(json, ".image"), string.concat("data:image/svg+xml;base64,", vm.toBase64(art.sealedSvg())));
        assertEq(vm.parseJsonString(json, ".attributes[0].trait_type"), "Status");
        assertEq(vm.parseJsonString(json, ".attributes[0].value"), "Sealed");
        assertFalse(vm.keyExistsJson(json, ".attributes[1]"));
        vm.expectRevert(MineWorldCrafters.NotRevealed.selector);
        crafters.rarityOf(7);
    }

    /// Gas of a view call as eth_call runs it (cold storage, nothing copied back), plus the call itself. An
    /// eth_call adds 21,000 and the calldata to this.
    function _gasOf(address target, bytes memory data) internal returns (uint256 used) {
        vm.cool(address(crafters));
        vm.cool(address(art));
        assembly {
            let before := gas()
            let ok := staticcall(gas(), target, add(data, 32), mload(data), 0, 0)
            used := sub(before, gas())
            if iszero(ok) { revert(0, 0) }
        }
    }

    /// tokenURI is a view, read with eth_call: it must stay far below RPC gas caps (often 50M; aim under 15M). Over
    /// every vector token under SEED, the heaviest five DEGENs of the 3,333 (the longest cards) among them, and the
    /// sealed one. Marketplaces' eth_calls (10M and 30M budgets, as OpenSea's) get the whole, valid JSON.
    function test_TokenURIGas() public {
        CrafterVectors.Token[] memory v = CrafterVectors.tokens();
        crafters.setSeed(CrafterVectors.SEED);
        for (uint256 i; i < v.length; i++) if (v[i].seed == 0) crafters.mintId(address(this), v[i].id);
        uint256 min = type(uint256).max;
        uint256 max;
        for (uint256 i; i < v.length; i++) {
            if (v[i].seed != 0) continue;
            uint256 g = _gasOf(address(crafters), abi.encodeCall(crafters.tokenURI, (v[i].id)));
            if (g < min) min = g;
            if (g > max) max = g;
        }
        uint256[5] memory heavy = CrafterVectors.heaviest();
        uint256 heaviest = _gasOf(address(crafters), abi.encodeCall(crafters.tokenURI, (heavy[0])));
        for (uint256 i; i < heavy.length; i++) {
            (bool ok, bytes memory ret) = address(crafters).staticcall{gas: 10_000_000}(abi.encodeCall(MineWorldCrafters.tokenURI, (heavy[i])));
            assertTrue(ok, "the heaviest tokenURIs must fit a 10M eth_call");
            string memory json = Json.decodeURI(abi.decode(ret, (string)));
            assertEq(vm.parseJsonString(json, ".name"), string.concat("I'M DEGEN #", vm.toString(heavy[i])));
        }
        crafters.setSeed(0);
        uint256 sealedGas = _gasOf(address(crafters), abi.encodeCall(crafters.tokenURI, (v[0].id)));
        console2.log("tokenURI gas over the vector tokens: min", min, "max", max);
        console2.log("tokenURI gas, the heaviest DEGEN (id, gas):", heavy[0], heaviest);
        console2.log("tokenURI gas, sealed", sealedGas);
        assertLt(max, 15_000_000);
        assertLt(heaviest, 15_000_000);
        assertLt(sealedGas, 15_000_000);
    }

    function test_RenderGas() public {
        CrafterVectors.Look[] memory v = CrafterVectors.looks();
        uint256 min = type(uint256).max;
        uint256 max;
        for (uint256 i; i < v.length; i++) {
            uint256 g = _gasOf(address(art), abi.encodeCall(art.render, (v[i].traits)));
            if (g < min) min = g;
            if (g > max) max = g;
        }
        console2.log("render gas over the looks: min", min, "max", max);
        console2.log("sealedSvg gas", _gasOf(address(art), abi.encodeCall(art.sealedSvg, ())));
    }

    /// The base64 the metadata uses, against forge's, for every length mod 3 and any bytes.
    /// forge-config: default.fuzz.runs = 512
    function testFuzz_Base64MatchesForge(bytes memory data) public pure {
        assertEq(FastBase64.encode(data), vm.toBase64(data));
    }

    function test_Base64EdgeCases() public pure {
        assertEq(FastBase64.encode(""), "");
        assertEq(FastBase64.encode("f"), "Zg==");
        assertEq(FastBase64.encode("fo"), "Zm8=");
        assertEq(FastBase64.encode("foo"), "Zm9v");
        assertEq(FastBase64.encode("foob"), "Zm9vYg==");
        assertEq(FastBase64.encode(hex"fbff"), "+/8=");
        bytes memory big = new bytes(1000);
        for (uint256 i; i < big.length; i++) big[i] = bytes1(uint8(i * 7));
        assertEq(FastBase64.encode(big), vm.toBase64(big));
    }

    // ---------------------------------------------------------------- the shuffle

    /// No two of the 3,333 share a face (eyes, mouth, cheeks) and a top, for a few seeds (every token takes a
    /// different one of the 3,480 combinations), and every trait stays in its table.
    function test_EveryCrafterIsUnique() public view {
        uint256[4] memory seeds = [CrafterVectors.SEED, 1, type(uint256).max, uint256(keccak256("another seed"))];
        for (uint256 k; k < seeds.length; k++) _checkUnique(seeds[k]);
    }

    /// forge-config: default.fuzz.runs = 4
    function testFuzz_EveryCrafterIsUnique(uint256 s) public view {
        _checkUnique(s == 0 ? 1 : s);
    }

    function _checkUnique(uint256 s) internal view {
        uint256[14] memory seen; // a 3,480-bit set
        uint256[2] memory cheeks;
        for (uint256 id = 1; id <= CrafterRules.SUPPLY; id++) {
            Traits memory t = crafters.traitsFor(s, id);
            assertLt(t.background, CrafterRules.BACKGROUNDS);
            assertLt(t.skin, CrafterRules.SKINS);
            assertLt(t.eyes, CrafterRules.EYES);
            assertLt(t.mouth, CrafterRules.MOUTHS);
            assertLt(t.cheeks, CrafterRules.CHEEKS);
            assertLt(t.top, CrafterRules.TOPS);
            assertLt(t.bottoms, CrafterRules.BOTTOMS);
            assertLt(t.shoes, CrafterRules.SHOES);
            assertLt(t.headwear, CrafterRules.HEADWEAR);
            assertLt(t.accessory, CrafterRules.ACCESSORIES);
            uint256 c = t.eyes + 6 * (t.mouth + 5 * (t.cheeks + 2 * uint256(t.top)));
            uint256 bit = 1 << (c & 255);
            assertEq(seen[c >> 8] & bit, 0, "two DEGENs share a face and a top");
            seen[c >> 8] |= bit;
            cheeks[t.cheeks]++;
        }
        // The combinations are spread over the whole range: half have blush.
        assertApproxEqAbs(cheeks[0], cheeks[1], 2);
    }

    /// For any seed, the shuffle sends 0..3332 to 0..3332 with no two the same.
    /// forge-config: default.fuzz.runs = 8
    function testFuzz_ShuffleIsABijection(uint256 s) public view {
        uint256[14] memory seen; // a 3,333-bit set
        for (uint256 x; x < CrafterRules.SUPPLY; x++) {
            uint256 y = crafters.shuffle(s, x);
            assertLt(y, CrafterRules.SUPPLY);
            uint256 bit = 1 << (y & 255);
            assertEq(seen[y >> 8] & bit, 0, "two inputs share a place");
            seen[y >> 8] |= bit;
        }
    }

    // ---------------------------------------------------------------- rarity

    /// The rule, spelled out here independently of the generated tables: Legendary with a gold skin, a crown or gold
    /// armour; Rare with an ice, purple or stone skin, a royal robe, a space suit, iron armour, a wizard hat or a
    /// viking helmet; Common otherwise. Nothing else matters.
    function test_RarityIsTheVisibleTiers() public view {
        assertEq(art.traitName(1, 5), "Ice");
        assertEq(art.traitName(1, 7), "Stone");
        assertEq(art.traitName(1, 8), "Gold");
        assertEq(art.traitName(5, 52), "Royal Robe Red");
        assertEq(art.traitName(5, 56), "Knight Armour Iron");
        assertEq(art.traitName(5, 57), "Knight Armour Gold");
        assertEq(art.traitName(8, 18), "Wizard Hat");
        assertEq(art.traitName(8, 19), "Viking Helmet");
        assertEq(art.traitName(8, 20), "Crown Gold");
        assertEq(art.traitName(8, 21), "Crown Jewelled");
        for (uint8 s; s < CrafterRules.SKINS; s++) {
            for (uint8 top; top < CrafterRules.TOPS; top++) {
                for (uint8 h; h < CrafterRules.HEADWEAR; h++) {
                    uint8 want = _want(s, top, h);
                    Traits memory t = Traits(h % 10, s, top % 6, top % 5, h % 2, top, top % 12, h % 8, h, (s + top + h) % 10);
                    assertEq(CrafterRules.rarity(t), want);
                    if ((s + top + h) % 37 == 0) assertEq(art.rarityOf(t), want);
                }
            }
        }
    }

    function _want(uint8 s, uint8 top, uint8 h) internal pure returns (uint8) {
        if (s == 8 || top == 57 || h == 20 || h == 21) return 2;
        if (s >= 5 || top >= 52 || h == 18 || h == 19) return 1;
        return 0;
    }

    /// The weighted picks follow their weights over a full mint (loose bounds: one seed), and the hood is only ever
    /// up on a hoodie, about a third of those with nothing else on the head.
    function test_WeightedPicksAndTheHood() public view {
        uint256[23] memory headwear;
        uint256[9] memory skins;
        uint256 bareHoodies;
        for (uint256 id = 1; id <= CrafterRules.SUPPLY; id++) {
            Traits memory t = crafters.traitsFor(CrafterVectors.SEED, id);
            headwear[t.headwear]++;
            skins[t.skin]++;
            if (CrafterRules.hoodie(t.top) && (t.headwear == 0 || t.headwear == CrafterRules.HOOD)) bareHoodies++;
            if (t.headwear == CrafterRules.HOOD) assertTrue(CrafterRules.hoodie(t.top), "a hood on a top that isn't a hoodie");
        }
        // None 56/168 (less the hoods), Hard Hat Yellow 12/168, Crown Jewelled 1/168; Leaf 26%, Gold 2%.
        assertApproxEqAbs(headwear[0] + headwear[CrafterRules.HOOD], 1111, 110);
        assertApproxEqAbs(headwear[10], 238, 60);
        assertApproxEqAbs(headwear[21], 20, 15);
        assertApproxEqAbs(skins[0], 867, 100);
        assertApproxEqAbs(skins[8], 67, 30);
        assertApproxEqAbs(headwear[CrafterRules.HOOD] * 3, bareHoodies, 60);
    }
}
