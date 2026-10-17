// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {MiningSites} from "../src/MiningSites.sol";

/// @notice Upgrades MiningSites (the proxy at SITES) to this repo's implementation, whose per-wallet limit can go up to
///         35,000 $MINE a day (the mining vault's whole daily limit), then sets MiningSites' converting limits: how
///         much $MINE one wallet (WALLET_CAP, whole $MINE, 35,000 by default) and everyone together (DAILY_CAP, 35,000
///         by default: the vault's limit) may convert in a UTC day. With both at 35,000 one wallet can convert the
///         whole day's 35,000, first come, first served. Three transactions, signed by the owner in the browser: the
///         new implementation, upgradeToAndCall(new implementation, "") on the proxy, and setCaps. It stops before
///         sending anything unless the signing wallet is the proxy's owner, and checks in its simulation that the
///         proxy kept its books (CHECK_WALLETS=0x..,0x.. adds those players' books and today's counts to the check):
///   SITES=0x... forge script script/UpgradeSites.s.sol --rpc-url <rpc> --broadcast --browser --browser-disable-open
contract UpgradeSites is Script {
    /// @dev ERC-1967: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1).
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    function run() external {
        MiningSites sites = MiningSites(vm.envAddress("SITES"));
        uint256 wallet = vm.envOr("WALLET_CAP", uint256(35_000)) * 1e18;
        uint256 global = vm.envOr("DAILY_CAP", uint256(35_000)) * 1e18;
        address[] memory players = vm.envOr("CHECK_WALLETS", ",", new address[](0));
        require(address(sites).code.length != 0, "UpgradeSites: nothing is deployed at SITES on this chain");
        require(
            wallet != 0 && wallet <= global && global <= sites.MAX_DAILY_CAP(),
            "UpgradeSites: WALLET_CAP must be 1 to DAILY_CAP, and DAILY_CAP at most the vault's daily limit (35,000)"
        );

        console2.log("MiningSites", address(sites));
        _log("before", sites);
        bytes memory books = _books(sites, players);
        bytes memory caps = abi.encode(sites.walletDailyCap(), sites.dailyCap());
        address oldImpl = _implementation(sites);

        vm.startBroadcast();
        // Who signs: the owner, or nothing is sent (this runs in the simulation, before any transaction).
        (, address signer,) = vm.readCallers();
        address owner = sites.owner();
        if (signer != owner) {
            revert(
                string.concat(
                    "UpgradeSites: the signing wallet ", vm.toString(signer), " isn't MiningSites' owner ",
                    vm.toString(owner), ": connect the owner's wallet"
                )
            );
        }
        MiningSites impl = new MiningSites();
        require(impl.MAX_WALLET_DAILY_CAP() >= wallet, "UpgradeSites: the new implementation can't take WALLET_CAP");
        sites.upgradeToAndCall(address(impl), "");
        // The proxy kept its books, its settings and its caps: only the code changed.
        require(_implementation(sites) == address(impl), "UpgradeSites: the proxy doesn't run the new implementation");
        require(keccak256(_books(sites, players)) == keccak256(books), "UpgradeSites: the upgrade changed the books");
        require(
            keccak256(abi.encode(sites.walletDailyCap(), sites.dailyCap())) == keccak256(caps),
            "UpgradeSites: the upgrade changed the caps"
        );
        require(sites.MAX_WALLET_DAILY_CAP() == 35_000e18, "UpgradeSites: the proxy's wallet maximum isn't 35,000");
        sites.setCaps(wallet, global);
        vm.stopBroadcast();

        require(sites.walletDailyCap() == wallet && sites.dailyCap() == global, "UpgradeSites: the caps didn't take");
        require(keccak256(_books(sites, players)) == keccak256(books), "UpgradeSites: setCaps changed the books");
        console2.log("  implementation was", oldImpl);
        _log("after", sites);
    }

    function _implementation(MiningSites sites) internal view returns (address) {
        return address(uint160(uint256(vm.load(address(sites), IMPLEMENTATION_SLOT))));
    }

    function _log(string memory when, MiningSites sites) internal view {
        console2.log(string.concat("  ", when, ": owner"), sites.owner());
        console2.log(string.concat("  ", when, ": implementation (ERC-1967 slot)"), _implementation(sites));
        console2.log(string.concat("  ", when, ": wallet limit ($MINE a day)"), sites.walletDailyCap() / 1e18);
        console2.log(string.concat("  ", when, ": everyone's limit ($MINE a day)"), sites.dailyCap() / 1e18);
        console2.log(
            string.concat("  ", when, ": the contract's most for a wallet ($MINE)"), sites.MAX_WALLET_DAILY_CAP() / 1e18
        );
    }

    /// @dev Everything the proxy holds that the upgrade and setCaps must not change: settings, levels and rates, the
    ///      vault and the voucher domain, today's total, and the books of the CHECK_WALLETS players.
    function _books(MiningSites sites, address[] memory players) internal view returns (bytes memory b) {
        b = bytes.concat(
            abi.encode(sites.owner(), sites.pendingOwner(), sites.signer(), sites.treasury(), sites.sitePrice()),
            abi.encode(sites.paused(), address(sites.vault()), address(sites.token()), sites.predecessor()),
            abi.encode(sites.rates(), sites.upgradeCosts(), sites.upgradeBurnBps(), sites.maxLevel()),
            abi.encode(sites.paidToday(), sites.vaultBalance(), sites.MAX_DAILY_CAP(), sites.domainSeparator())
        );
        for (uint256 i; i < players.length; i++) {
            (uint64 openedAt, uint256 level, uint256 settled, uint256 claimed) = sites.bookOf(players[i]);
            b = bytes.concat(b, abi.encode(openedAt, level, settled, claimed, sites.walletPaidToday(players[i])));
        }
    }
}
