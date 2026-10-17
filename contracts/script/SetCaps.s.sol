// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

interface ICaps {
    function setCaps(uint256 walletDailyCap_, uint256 dailyCap_) external;
    function walletDailyCap() external view returns (uint256);
    function dailyCap() external view returns (uint256);
    function MAX_WALLET_DAILY_CAP() external view returns (uint256);
    function owner() external view returns (address);
}

/// @notice Sets MiningSites' converting limits: how much $MINE one wallet (WALLET_CAP, whole $MINE, 3,500 by default;
///         the contract allows up to MAX_WALLET_DAILY_CAP: 35,000, the vault's whole day, since the 2026-10-18 upgrade
///         in script/UpgradeSites.s.sol, 3,500 before it) and everyone together (DAILY_CAP, 35,000 by default: the
///         mining vault's limit) may convert in a UTC day. Signed by the owner in the browser:
///   SITES=0x... forge script script/SetCaps.s.sol --rpc-url <rpc> --broadcast --browser --browser-disable-open
contract SetCaps is Script {
    function run() external {
        ICaps sites = ICaps(vm.envAddress("SITES"));
        uint256 wallet = vm.envOr("WALLET_CAP", uint256(3_500)) * 1e18;
        uint256 global = vm.envOr("DAILY_CAP", uint256(35_000)) * 1e18;
        console2.log("MiningSites", address(sites));
        console2.log("  owner", sites.owner());
        console2.log("  wallet limit now ($MINE)", sites.walletDailyCap() / 1e18);
        console2.log("  everyone's limit now ($MINE)", sites.dailyCap() / 1e18);
        console2.log("  the contract's most for a wallet ($MINE)", sites.MAX_WALLET_DAILY_CAP() / 1e18);
        vm.startBroadcast();
        sites.setCaps(wallet, global);
        vm.stopBroadcast();
        console2.log("  wallet limit after ($MINE)", sites.walletDailyCap() / 1e18);
        console2.log("  everyone's limit after ($MINE)", sites.dailyCap() / 1e18);
    }
}
