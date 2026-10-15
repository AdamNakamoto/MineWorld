// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

interface ISale {
    function setSaleOpen(bool open) external;
    function saleOpen() external view returns (bool);
    function owner() external view returns (address);
}

/// @notice Opens the I'M DEGEN mint (or closes it with OPEN=false), signed by the collection's owner:
///   CRAFTERS=0x... forge script script/SetSale.s.sol --rpc-url <rpc> --broadcast --browser --browser-disable-open
/// Closing it after the mint is the first step of the reveal (then reveal(secret) and seal(): see the README).
contract SetSale is Script {
    function run() external {
        ISale crafters = ISale(vm.envAddress("CRAFTERS"));
        bool open = vm.envOr("OPEN", true);
        console2.log("I'M DEGEN", address(crafters));
        console2.log("  owner", crafters.owner());
        console2.log("  sale open now", crafters.saleOpen());
        vm.startBroadcast();
        crafters.setSaleOpen(open);
        vm.stopBroadcast();
        console2.log("  sale open after", crafters.saleOpen());
    }
}
