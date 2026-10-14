// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {CrafterArt} from "../src/CrafterArt.sol";
import {MineWorldCrafters} from "../src/MineWorldCrafters.sol";
import {DevTransferValidator} from "./DevTransferValidator.sol";

/// @notice MineWorld Crafters on Robinhood Chain: the on-chain art (CrafterArt), then 3,333 blind-minted Crafters
///         drawn by it, with the 5% royalty enforced.
///
///   ./script/deploy-mainnet.sh crafters --broadcast --browser --browser-disable-open
///
/// Env: SEED_COMMIT (keccak256(abi.encode(secret)); keep the secret until the reveal), TREASURY (mint money, if any,
/// and royalties), CRAFTERS_PRICE (wei per Crafter, 0: free), CRAFTERS_WALLET_LIMIT (1-50, 10 by default),
/// CRAFTERS_VALIDATOR (OpenSea's creator fee enforcement registry), CRAFTERS_WEBSITE and CRAFTERS_SOCIAL (the
/// collection's links) and CRAFTERS_IMAGE and CRAFTERS_BANNER (its picture and banner URLs), all four optional: the
/// owner can set them any time with setLinks and setCollectionImages. OPEN_SALE (false: open it later with
/// setSaleOpen). The wallet that broadcasts owns the collection. On a bare local chain (../dev.sh without --fork)
/// there's no registry, so it deploys DevTransferValidator instead.
contract DeployCrafters is Script {
    /// OpenSea's StrictAuthorizedTransferSecurityRegistry, the validator its creator fee enforcement uses.
    address constant OPENSEA_REGISTRY = 0xA000027A9B2802E1ddf7000061001e5c005A0000;

    function run() external returns (MineWorldCrafters crafters) {
        address treasury = vm.envAddress("TREASURY");
        bytes32 commit = vm.envBytes32("SEED_COMMIT");
        address validator = vm.envOr("CRAFTERS_VALIDATOR", OPENSEA_REGISTRY);
        uint256 price = vm.envOr("CRAFTERS_PRICE", uint256(0));
        uint256 walletLimit = vm.envOr("CRAFTERS_WALLET_LIMIT", uint256(10));
        string memory website = vm.envOr("CRAFTERS_WEBSITE", string(""));
        string memory social = vm.envOr("CRAFTERS_SOCIAL", string(""));
        string memory image = vm.envOr("CRAFTERS_IMAGE", string(""));
        string memory banner = vm.envOr("CRAFTERS_BANNER", string(""));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        if (validator.code.length == 0 && block.chainid != 4663) validator = address(new DevTransferValidator());
        CrafterArt art = new CrafterArt();
        crafters = new MineWorldCrafters(deployer, treasury, price, commit, validator, art);
        if (walletLimit != crafters.walletLimit()) crafters.setWalletLimit(walletLimit);
        if (bytes(website).length != 0 || bytes(social).length != 0) crafters.setLinks(website, social);
        if (bytes(image).length != 0 || bytes(banner).length != 0) crafters.setCollectionImages(image, banner);
        if (vm.envOr("OPEN_SALE", false)) crafters.setSaleOpen(true);
        vm.stopBroadcast();
        console2.log("Crafters", address(crafters));
        console2.log("CrafterArt", address(art));
        console2.log("  validator", validator);
        console2.log("  owner", crafters.owner());
        console2.log("  treasury", crafters.treasury());
        console2.log("  price (wei)", crafters.price());
        console2.log("  wallet limit", crafters.walletLimit());

        // (dev.sh sets DEV_CHAIN: an Anvil fork of Robinhood Chain has its chain ID too, and must not touch the real record.)
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || block.chainid != 4663 || vm.envOr("DEV_CHAIN", false)) return crafters;
        string memory json = "crafters";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeUint(json, "block", block.number);
        vm.serializeAddress(json, "treasury", treasury);
        vm.serializeAddress(json, "art", address(art));
        string memory out = vm.serializeAddress(json, "crafters", address(crafters));
        vm.writeJson(out, "./deployments/robinhood-crafters.json");
    }
}
