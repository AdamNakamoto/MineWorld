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

/// The on-chain art and traits against the JS that defines them (web/crafters.js, web/crafters-art.js): every
/// expected value in CrafterVectors.sol was worked out by the JS (tools/gen-crafter-art.mjs).
contract CrafterArtTest is Test {
    CrafterArt art;
    CraftersHarness crafters;

    function setUp() public {
        art = new CrafterArt();
        crafters = new CraftersHarness(address(new StrictValidator()), art);
    }

    /// The generated files must come from the JS as it is now. If this fails, run
    /// `~/.local/node/bin/node tools/gen-crafter-art.mjs` and run the tests again.
    function test_ArtIsUpToDateWithTheJs() public view {
        string memory hint = ": changed since CrafterArt.sol was generated; run ~/.local/node/bin/node tools/gen-crafter-art.mjs";
        assertEq(keccak256(vm.readFileBinary("../web/crafters-art.js")), CrafterVectors.ART_JS, string.concat("web/crafters-art.js", hint));
        assertEq(keccak256(vm.readFileBinary("../web/crafters.js")), CrafterVectors.RULES_JS, string.concat("web/crafters.js", hint));
        assertEq(keccak256(vm.readFileBinary("../tools/gen-crafter-art.mjs")), CrafterVectors.GENERATOR, string.concat("tools/gen-crafter-art.mjs", hint));
    }

    // ---------------------------------------------------------------- pictures

    /// Every option of every trait, drawn byte for byte as svg() in web/crafters.js draws it.
    function test_RenderMatchesTheJs() public view {
        CrafterVectors.Look[] memory v = CrafterVectors.looks();
        for (uint256 i; i < v.length; i++) {
            bytes memory svg = bytes(art.render(v[i].traits));
            assertEq(svg.length, v[i].svgLength, string.concat("look ", vm.toString(i), ": length"));
            assertEq(keccak256(svg), v[i].svg, string.concat("look ", vm.toString(i), ": picture"));
            assertEq(art.rarityOf(v[i].traits), v[i].rarity, string.concat("look ", vm.toString(i), ": rarity"));
        }
    }

    function test_SealedPictureMatchesTheJs() public view {
        assertEq(keccak256(bytes(art.sealedSvg())), CrafterVectors.SEALED_SVG);
    }

    function test_AttributesMatchTheJs() public view {
        CrafterVectors.Look[] memory v = CrafterVectors.looks();
        for (uint256 i; i < v.length; i++) {
            assertEq(keccak256(bytes(art.attributes(v[i].traits))), v[i].attributes, string.concat("look ", vm.toString(i)));
        }
    }

    function test_TraitNamesMatchTheJs() public {
        uint256[9] memory counts = [
            CrafterRules.BACKGROUNDS, CrafterRules.SKINS, CrafterRules.EYES, CrafterRules.GAZES, CrafterRules.BLUSHES,
            CrafterRules.HAIRS, CrafterRules.HATS, CrafterRules.OUTFITS, CrafterRules.RARITIES
        ];
        bytes32[9] memory expected = [
            CrafterVectors.BACKGROUND_NAMES, CrafterVectors.SKIN_NAMES, CrafterVectors.EYES_NAMES,
            CrafterVectors.GAZE_NAMES, CrafterVectors.BLUSH_NAMES, CrafterVectors.HAIR_NAMES, CrafterVectors.HAT_NAMES,
            CrafterVectors.OUTFIT_NAMES, CrafterVectors.RARITY_NAMES
        ];
        for (uint256 kind; kind < 9; kind++) {
            string memory all = art.traitName(kind, 0);
            for (uint256 i = 1; i < counts[kind]; i++) all = string.concat(all, "|", art.traitName(kind, i));
            assertEq(keccak256(bytes(all)), expected[kind], vm.toString(kind));
            vm.expectRevert(CrafterArt.BadTraits.selector);
            art.traitName(kind, counts[kind]);
        }
        vm.expectRevert(CrafterArt.BadTraits.selector);
        art.traitName(9, 0);
        assertEq(art.traitName(0, 7), "Gold");
        assertEq(art.traitName(8, 0), "Common");
        assertEq(art.traitName(8, 1), "Rare");
        assertEq(art.traitName(8, 2), "Legendary");
        assertEq(art.traitName(3, 1), "Right");
        assertEq(art.traitName(5, 8), "Rainbow Long");
        assertEq(art.traitName(6, 0), "None");
    }

    function test_TraitsPastTheTablesRevert() public {
        Traits memory ok = Traits(35, 15, 5, 1, 7, 4, 9, 1);
        art.render(ok);
        art.attributes(ok);
        assertEq(art.rarityOf(ok), 2);
        for (uint256 f; f < 8; f++) {
            Traits memory t = ok;
            if (f == 0) t.hair = 36;
            if (f == 1) t.outfit = 16;
            if (f == 2) t.eyes = 6;
            if (f == 3) t.gaze = 2;
            if (f == 4) t.background = 8;
            if (f == 5) t.skin = 5;
            if (f == 6) t.hat = 10;
            if (f == 7) t.blush = 2;
            vm.expectRevert(CrafterArt.BadTraits.selector);
            art.render(t);
            vm.expectRevert(CrafterArt.BadTraits.selector);
            art.attributes(t);
            vm.expectRevert(CrafterArt.BadTraits.selector);
            art.rarityOf(t);
        }
    }

    // ---------------------------------------------------------------- traits

    /// traitsOf(seed, id) as web/crafters.js works it out, and the token's picture and attributes.
    function test_TraitsMatchTheJs() public view {
        CrafterVectors.Token[] memory v = CrafterVectors.tokens();
        for (uint256 i; i < v.length; i++) {
            Traits memory t = crafters.traitsFor(CrafterVectors.SEED, v[i].id);
            string memory id = vm.toString(v[i].id);
            assertEq(abi.encode(t), abi.encode(v[i].traits), string.concat("token ", id, ": traits"));
            assertEq(keccak256(bytes(art.render(t))), v[i].svg, string.concat("token ", id, ": picture"));
            assertEq(keccak256(bytes(art.attributes(t))), v[i].attributes, string.concat("token ", id, ": attributes"));
            assertEq(art.rarityOf(t), v[i].rarity, string.concat("token ", id, ": rarity"));
        }
    }

    /// The whole token: valid JSON, its name, the picture as a base64 data URI of render(traits), the attributes.
    function test_TokenURIMatchesTheJs() public {
        CrafterVectors.Token[] memory v = CrafterVectors.tokens();
        crafters.setSeed(CrafterVectors.SEED);
        address holder = makeAddr("holder");
        for (uint256 i; i < v.length; i++) crafters.mintId(holder, v[i].id);
        for (uint256 i; i < v.length; i += 4) {
            string memory json = Json.decodeURI(crafters.tokenURI(v[i].id));
            string memory svg = art.render(v[i].traits);
            assertEq(keccak256(bytes(svg)), v[i].svg);
            assertEq(vm.parseJsonString(json, ".name"), string.concat("I'M DEGEN #", vm.toString(v[i].id)));
            assertEq(vm.parseJsonString(json, ".image"), string.concat("data:image/svg+xml;base64,", vm.toBase64(svg)));
            assertTrue(bytes(vm.parseJsonString(json, ".description")).length > 0);
            uint8[8] memory index = [
                v[i].traits.background, v[i].traits.skin, v[i].traits.eyes, v[i].traits.gaze, v[i].traits.blush,
                v[i].traits.hair, v[i].traits.hat, v[i].traits.outfit
            ];
            string[8] memory kinds = ["Background", "Skin", "Eyes", "Gaze", "Blush", "Hair", "Hat", "Outfit"];
            for (uint256 k; k < 8; k++) {
                string memory at = string.concat(".attributes[", vm.toString(k), "]");
                assertEq(vm.parseJsonString(json, string.concat(at, ".trait_type")), kinds[k]);
                assertEq(vm.parseJsonString(json, string.concat(at, ".value")), art.traitName(k, index[k]));
            }
            // Then the rarity, and nothing more without an attributes extension.
            assertEq(vm.parseJsonString(json, ".attributes[8].trait_type"), "Rarity");
            assertEq(vm.parseJsonString(json, ".attributes[8].value"), art.traitName(8, v[i].rarity));
            assertEq(crafters.rarityOf(v[i].id), v[i].rarity);
            assertFalse(vm.keyExistsJson(json, ".attributes[9]"));
        }
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

    /// tokenURI is a view, read with eth_call: it must stay far below RPC gas caps (often 50M; aim under 15M).
    function test_TokenURIGas() public {
        CrafterVectors.Token[] memory v = CrafterVectors.tokens();
        crafters.setSeed(CrafterVectors.SEED);
        for (uint256 i; i < v.length; i++) crafters.mintId(address(this), v[i].id);
        uint256 min = type(uint256).max;
        uint256 max;
        for (uint256 i; i < v.length; i++) {
            uint256 g = _gasOf(address(crafters), abi.encodeCall(crafters.tokenURI, (v[i].id)));
            if (g < min) min = g;
            if (g > max) max = g;
        }
        crafters.setSeed(0);
        uint256 sealedGas = _gasOf(address(crafters), abi.encodeCall(crafters.tokenURI, (v[0].id)));
        console2.log("tokenURI gas over the vectors: min", min, "max", max);
        console2.log("tokenURI gas, sealed", sealedGas);
        assertLt(max, 15_000_000);
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

    /// No two of the 3,333 share hair, outfit, eyes and gaze, for a few seeds (every token takes a different one of
    /// the 6,912 combinations), and every trait stays in its table.
    function test_EveryCrafterIsUnique() public view {
        uint256[4] memory seeds = [CrafterVectors.SEED, 1, type(uint256).max, uint256(keccak256("another seed"))];
        for (uint256 k; k < seeds.length; k++) _checkUnique(seeds[k]);
    }

    /// forge-config: default.fuzz.runs = 4
    function testFuzz_EveryCrafterIsUnique(uint256 s) public view {
        _checkUnique(s == 0 ? 1 : s);
    }

    function _checkUnique(uint256 s) internal view {
        uint256[28] memory seen; // a 6,912-bit set
        uint256[2] memory gazes;
        for (uint256 id = 1; id <= CrafterRules.SUPPLY; id++) {
            Traits memory t = crafters.traitsFor(s, id);
            assertLt(t.hair, CrafterRules.HAIRS);
            assertLt(t.outfit, CrafterRules.OUTFITS);
            assertLt(t.eyes, CrafterRules.EYES);
            assertLt(t.gaze, CrafterRules.GAZES);
            assertLt(t.background, CrafterRules.BACKGROUNDS);
            assertLt(t.skin, CrafterRules.SKINS);
            assertLt(t.hat, CrafterRules.HATS);
            assertLt(t.blush, CrafterRules.BLUSHES);
            uint256 c = t.hair + 36 * (t.outfit + 16 * (t.eyes + 6 * uint256(t.gaze)));
            uint256 bit = 1 << (c & 255);
            assertEq(seen[c >> 8] & bit, 0, "two Crafters share hair, outfit, eyes and gaze");
            seen[c >> 8] |= bit;
            gazes[t.gaze]++;
        }
        // The combinations are spread over the whole range: half look each way.
        assertApproxEqAbs(gazes[0], gazes[1], 2);
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

    /// Every Crafter's rarity under the vector seed, as rarityOf() in web/crafters.js gives it: the counts and the
    /// whole run of 3,333, exactly.
    function test_RarityMatchesTheJsForEveryCrafter() public view {
        uint256[3] memory counts;
        bytes memory run = new bytes(CrafterRules.SUPPLY);
        for (uint256 id = 1; id <= CrafterRules.SUPPLY; id++) {
            uint8 r = art.rarityOf(crafters.traitsFor(CrafterVectors.SEED, id));
            counts[r]++;
            run[id - 1] = bytes1(r);
        }
        console2.log("rarity over the 3,333 under the vector seed: Common", counts[0]);
        console2.log("                                             Rare  ", counts[1]);
        console2.log("                                             Legendary", counts[2]);
        assertEq(abi.encode(counts), abi.encode(CrafterVectors.rarityCounts()));
        assertEq(keccak256(run), CrafterVectors.RARITY_SEQUENCE);
        // Roughly the odds: 68.8%, 25.2%, 6%.
        assertApproxEqAbs(counts[0], 2293, 120);
        assertApproxEqAbs(counts[1], 840, 100);
        assertApproxEqAbs(counts[2], 200, 60);
    }

    /// The rule, spelled out here independently of the generated table: Legendary with the Gold background (7);
    /// Rare with the Night background (6) or a hard hat (7, 8, 9: yellow, orange, white); Common otherwise. Nothing
    /// else matters.
    function test_RarityIsTheBackgroundAndTheHat() public view {
        assertEq(art.traitName(0, 6), "Night");
        assertEq(art.traitName(0, 7), "Gold");
        assertEq(art.traitName(6, 7), "Hard Hat Yellow");
        assertEq(art.traitName(6, 8), "Hard Hat Orange");
        assertEq(art.traitName(6, 9), "Hard Hat White");
        for (uint8 b; b < CrafterRules.BACKGROUNDS; b++) {
            for (uint8 h; h < CrafterRules.HATS; h++) {
                uint8 want = b == 7 ? 2 : (b == 6 || h >= 7 ? 1 : 0);
                assertEq(art.rarityOf(Traits(3, 2, 1, 0, b, 4, h, 1)), want);
                assertEq(art.rarityOf(Traits(35, 15, 5, 1, b, 0, h, 0)), want);
                assertEq(CrafterRules.rarity(b, h), want);
            }
        }
    }

    /// The weighted picks follow their weights over a full mint (loose bounds: one seed).
    function test_WeightedPicksFollowTheWeights() public view {
        uint256[10] memory hats;
        uint256[8] memory backgrounds;
        for (uint256 id = 1; id <= CrafterRules.SUPPLY; id++) {
            Traits memory t = crafters.traitsFor(CrafterVectors.SEED, id);
            hats[t.hat]++;
            backgrounds[t.background]++;
        }
        // None 40%, Hard Hat White 4%; Sky 18%, Gold 6%.
        assertApproxEqAbs(hats[0], 1333, 120);
        assertApproxEqAbs(hats[9], 133, 50);
        assertApproxEqAbs(backgrounds[0], 600, 90);
        assertApproxEqAbs(backgrounds[7], 200, 60);
    }
}
