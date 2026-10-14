// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {MineWorldMiners} from "../src/MineWorldMiners.sol";
import {DevTransferValidator} from "./DevTransferValidator.sol";

/// @notice MineWorldCraft Miners on Robinhood Chain: 999 blind-minted miner outfits, with the 5% royalty enforced.
///
///   ./script/deploy-mainnet.sh miners --broadcast --browser --browser-disable-open
///
/// Env: SEED_COMMIT (keccak256(abi.encode(secret)); keep the secret until the reveal), TREASURY (mint money and
/// royalties), MINERS_PRICE (0.004 ether), MINERS_VALIDATOR (OpenSea's creator fee enforcement registry),
/// MINERS_IMAGES (where the pictures live), MINERS_WEBSITE and MINERS_SOCIAL (the collection's links; optional, the
/// owner can set them any time with setLinks), OPEN_SALE (false: open it later with setSaleOpen).
/// The wallet that broadcasts owns the collection. On a bare local chain (../dev.sh without --fork) there's no
/// registry, so it deploys DevTransferValidator instead.
contract DeployMiners is Script {
    /// OpenSea's StrictAuthorizedTransferSecurityRegistry, the validator its creator fee enforcement uses.
    address constant OPENSEA_REGISTRY = 0xA000027A9B2802E1ddf7000061001e5c005A0000;

    function run() external returns (MineWorldMiners miners) {
        address treasury = vm.envAddress("TREASURY");
        bytes32 commit = vm.envBytes32("SEED_COMMIT");
        address validator = vm.envOr("MINERS_VALIDATOR", OPENSEA_REGISTRY);
        uint256 price = vm.envOr("MINERS_PRICE", uint256(0.004 ether));
        string memory images = vm.envOr("MINERS_IMAGES", string("https://mineworldcraft.fun/miners/"));
        string memory website = vm.envOr("MINERS_WEBSITE", string(""));
        string memory social = vm.envOr("MINERS_SOCIAL", string(""));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        if (validator.code.length == 0 && block.chainid != 4663) validator = address(new DevTransferValidator());
        miners = new MineWorldMiners(deployer, treasury, price, commit, validator, images);
        if (bytes(website).length != 0 || bytes(social).length != 0) miners.setLinks(website, social);
        if (vm.envOr("OPEN_SALE", false)) miners.setSaleOpen(true);
        vm.stopBroadcast();
        console2.log("Miners", address(miners));
        console2.log("  validator", validator);
        console2.log("  owner", miners.owner());
        console2.log("  treasury", miners.treasury());
        console2.log("  price (wei)", miners.price());

        // (dev.sh sets DEV_CHAIN: an Anvil fork of Robinhood Chain has its chain ID too, and must not touch the real record.)
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || block.chainid != 4663 || vm.envOr("DEV_CHAIN", false)) return miners;
        string memory json = "miners";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeUint(json, "block", block.number);
        vm.serializeAddress(json, "treasury", treasury);
        string memory out = vm.serializeAddress(json, "miners", address(miners));
        vm.writeJson(out, "./deployments/robinhood-miners.json");
    }
}
