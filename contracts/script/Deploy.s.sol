// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {MineHook} from "../src/MineHook.sol";
import {MineToken} from "../src/MineToken.sol";
import {MiningSites} from "../src/MiningSites.sol";
import {DeployLib} from "./DeployLib.sol";

/// @notice Robinhood Chain (4663) addresses (as Courier World uses them, checked on-chain 2026-10-07).
library RobinhoodConfig {
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address internal constant IMD = 0x5F7Bb59365ce557C26dbcAa4EE9d39A4b95B7127;
    /// @dev IMD/ETH pool for the ETH router: fee 1%, tick spacing 100, no hook.
    uint24 internal constant IMD_ETH_FEE = 10_000;
    int24 internal constant IMD_ETH_SPACING = 100;
    uint160 internal constant HOOK_FLAGS = 0x28CC;
    /// @dev Chainlink ETH/USD on Robinhood Chain (8 decimals).
    address internal constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
}

interface IAggregatorV3 {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @notice The deploy steps, shared by the scripts below and the fork tests.
///   - Bare dev chain (no Uniswap v4): MiningSites, then $MINE with its pool half to a stand-in holder.
///   - Robinhood Chain, or a fork of it: MineHook (mined CREATE2 address) with its routers, MiningSites, $MINE (half
///     to the hook, half to the sites), the pool opened, then the hook renounced so the fee recipient is final.
///   $MINE mints the vault half to MiningSites in its constructor, while MiningSites keeps $MINE as an immutable: so
///   MiningSites goes first, at the token's predicted address (the deployer's next contract), and the address is
///   checked once the token exists.
abstract contract MineDeployer is Script {
    int24 internal constant MIN_START_TICK = -300_000;
    int24 internal constant MAX_START_TICK = 400_000;

    /// @dev MiningSites' settings.
    struct Sites {
        address treasury;
        address signer;
        uint256 sitePrice;
        uint256 walletDailyCap;
        uint256 dailyCap;
    }

    struct Launch {
        address hook;
        address token;
        address sites;
        int24 startTick;
    }

    /// @dev MiningSites' settings from the environment: MINING_SIGNER (the game server's voucher key, an address),
    ///      SITE_PRICE (0.005 ether), WALLET_DAILY_CAP (5,000 $MINE), DAILY_CAP (1,000,000 $MINE).
    function _sitesFromEnv(address treasury) internal view returns (Sites memory s) {
        s.treasury = treasury;
        s.signer = vm.envAddress("MINING_SIGNER");
        s.sitePrice = vm.envOr("SITE_PRICE", uint256(0.005 ether));
        s.walletDailyCap = vm.envOr("WALLET_DAILY_CAP", uint256(5_000e18));
        s.dailyCap = vm.envOr("DAILY_CAP", uint256(1_000_000e18));
    }

    /// @dev MiningSites at the token's predicted address, then $MINE: POOL_SUPPLY to `pool`, VAULT_SUPPLY to the
    ///      sites. `deployer` is whoever creates them (the broadcasting wallet, or the test contract).
    function _deployTokenAndSites(address deployer, address owner, address pool, Sites memory s)
        internal
        returns (MineToken token, MiningSites sites)
    {
        // The deployer's next two contracts: the sites (this nonce), then the token (the one after).
        address predicted = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        sites = new MiningSites(IERC20(predicted), owner, s.treasury, s.signer, s.sitePrice, s.walletDailyCap, s.dailyCap);
        token = new MineToken(pool, address(sites));
        require(address(token) == predicted, "MineToken isn't at the address MiningSites was given");
        require(address(sites.token()) == address(token), "MiningSites points at another token");
        require(token.balanceOf(address(sites)) == token.VAULT_SUPPLY(), "the vault isn't funded");
    }

    /// @dev The full launch. `deployer` owns the hook until it renounces at the end, and owns MiningSites.
    function _launch(address deployer, address feeRecipient, uint256 startMcap, Sites memory s)
        internal
        returns (Launch memory l)
    {
        // Start price: `startMcap` IMD wei for all 1B $MINE (the pool holds half; the rest is earned in the game).
        l.startTick = DeployLib.startTickForMarketCap(startMcap, 1_000_000_000e18);
        require(l.startTick >= MIN_START_TICK && l.startTick <= MAX_START_TICK, "start market cap outside the hook's range");

        // The hook, at an address carrying its permission flags.
        bytes memory initCode = abi.encodePacked(
            type(MineHook).creationCode,
            abi.encode(
                RobinhoodConfig.POOL_MANAGER,
                RobinhoodConfig.IMD,
                deployer,
                feeRecipient,
                l.startTick,
                uint256(500_000_000e18),
                MineHook.ImdEthPool(RobinhoodConfig.IMD_ETH_FEE, RobinhoodConfig.IMD_ETH_SPACING, address(0))
            )
        );
        (bytes32 salt, address expected) =
            DeployLib.mineSalt(CREATE2_FACTORY, RobinhoodConfig.HOOK_FLAGS, initCode, vm.envOr("SALT_START", uint256(0)));
        require(expected.code.length == 0, "already deployed at mined address");
        (bool ok,) = CREATE2_FACTORY.call(abi.encodePacked(salt, initCode));
        require(ok && expected.code.length > 0, "hook deploy failed");
        l.hook = expected;

        (MineToken token, MiningSites sites) = _deployTokenAndSites(deployer, deployer, l.hook, s);
        l.token = address(token);
        l.sites = address(sites);
        require(token.balanceOf(l.hook) == MineHook(l.hook).launchSupply(), "the hook didn't get the pool half");

        MineHook(l.hook).openPool(l.token); // locks the pool half forever
        MineHook(l.hook).renounceOwnership(); // the fee recipient is final
    }

    /// @dev $usd in IMD wei, from the IMD/ETH pool price and Chainlink ETH/USD (refuses a feed older than a day).
    function _usdToImd(uint256 usd) internal view returns (uint256) {
        PoolKey memory imdEth = PoolKey(
            Currency.wrap(address(0)), Currency.wrap(RobinhoodConfig.IMD), RobinhoodConfig.IMD_ETH_FEE,
            RobinhoodConfig.IMD_ETH_SPACING, IHooks(address(0))
        );
        (uint160 sqrtP,,,) = StateLibrary.getSlot0(RobinhoodConfig.POOL_MANAGER, imdEth.toId());
        (, int256 ethUsd,, uint256 updatedAt,) = IAggregatorV3(RobinhoodConfig.ETH_USD).latestRoundData();
        require(ethUsd > 0 && block.timestamp - updatedAt < 1 days, "stale ETH/USD");
        // IMD per ETH = (sqrtP / 2^96)^2; IMD for $usd = usd * IMD-per-ETH / ETH-USD.
        uint256 imdPerEthX = FullMath.mulDiv(FullMath.mulDiv(usd * 1e26, sqrtP, 1 << 96), sqrtP, 1 << 96);
        uint256 imd = imdPerEthX / uint256(ethUsd);
        console.log("ETH/USD (8 dec)", uint256(ethUsd));
        console.log("USD -> IMD wei ", usd, imd);
        return imd;
    }

    /// @dev START_MCAP (IMD wei) if set, else START_MCAP_USD (5,000) converted to IMD.
    function _startMcap() internal view returns (uint256 startMcap) {
        startMcap = vm.envOr("START_MCAP", uint256(0));
        if (startMcap == 0) startMcap = _usdToImd(vm.envOr("START_MCAP_USD", uint256(5_000)));
        console.log("Launch FDV (IMD wei, 1B MINE)", startMcap);
    }

    /// @dev One `<Name> <address>` line per contract (dev.sh reads them), then the settings.
    function _log(address token, address sites, address hook) internal view {
        console.log("MineToken", token);
        console.log("MiningSites", sites);
        if (hook != address(0)) {
            console.log("MineHook", hook);
            console.log("Router", MineHook(hook).router());
            console.log("EthRouter", MineHook(hook).ethRouter());
        }
        MiningSites s = MiningSites(sites);
        console.log("  sites owner      ", s.owner());
        console.log("  sites treasury   ", s.treasury());
        console.log("  sites signer     ", s.signer());
        console.log("  site price (wei) ", s.sitePrice());
        console.log("  wallet daily cap ", s.walletDailyCap() / 1e18);
        console.log("  daily cap        ", s.dailyCap() / 1e18);
        console.log("  vault (MINE)     ", s.vaultBalance() / 1e18);
        if (hook == address(0)) return;
        MineHook h = MineHook(hook);
        console.log("  fee recipient    ", h.feeRecipient());
        console.log("  hook owner       ", h.owner());
        console.log("  MINE price at launch (IMD wei per MINE)", h.price(token));
        console.log("  FDV at launch (IMD wei, 1B MINE)       ", h.marketCap(token));
    }
}

/// @notice Deploys $MINE and MiningSites.
///
///   runLocal()  bare dev chain (../dev.sh): no Uniswap v4, so $MINE's pool half goes to the deployer as a stand-in,
///               and PLAYERS get MINE_EACH (100,000 $MINE) each from it. Env: TREASURY, MINING_SIGNER, PLAYERS.
///   run()       Robinhood Chain (./script/deploy-mainnet.sh launch), or a fork of it (../dev.sh --fork): the full
///               launch. Env: FEE_RECIPIENT (the 4% trading fee, in IMD), TREASURY (site sales; default
///               FEE_RECIPIENT), MINING_SIGNER, START_MCAP_USD (launch price as a market cap for all 1B $MINE in
///               whole dollars, converted to IMD from the IMD/ETH pool and Chainlink ETH/USD; or START_MCAP in IMD
///               wei), SITE_PRICE, WALLET_DAILY_CAP, DAILY_CAP, SALT_START (0).
///
/// The wallet that broadcasts owns MiningSites (two-step transferable) and owns the hook until the renounce.
contract Deploy is MineDeployer {
    function runLocal() external {
        Sites memory s = _sitesFromEnv(vm.envAddress("TREASURY"));
        address[] memory players = vm.envOr("PLAYERS", ",", new address[](0));
        uint256 each = vm.envOr("MINE_EACH", uint256(100_000e18));
        // The stand-in pool holder only makes sense where there's no pool: never on Robinhood Chain or a fork of it.
        require(
            address(RobinhoodConfig.POOL_MANAGER).code.length == 0,
            "runLocal is for a bare dev chain; use run() on Robinhood Chain or a fork of it"
        );

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        (MineToken token, MiningSites sites) = _deployTokenAndSites(deployer, deployer, deployer, s);
        for (uint256 i; i < players.length; i++) {
            token.transfer(players[i], each);
        }
        vm.stopBroadcast();
        _log(address(token), address(sites), address(0));
    }

    function run() external {
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        Sites memory s = _sitesFromEnv(vm.envOr("TREASURY", feeRecipient));
        uint256 startMcap = _startMcap();

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        Launch memory l = _launch(deployer, feeRecipient, startMcap, s);
        vm.stopBroadcast();
        _log(l.token, l.sites, l.hook);

        // (dev.sh sets DEV_CHAIN: an Anvil fork of Robinhood Chain has its chain ID too, and must not touch the real record.)
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || block.chainid != 4663 || vm.envOr("DEV_CHAIN", false)) return;
        string memory json = "mine";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeUint(json, "block", block.number);
        vm.serializeAddress(json, "mine", l.token);
        vm.serializeAddress(json, "sites", l.sites);
        vm.serializeAddress(json, "hook", l.hook);
        vm.serializeAddress(json, "router", MineHook(l.hook).router());
        vm.serializeAddress(json, "ethRouter", MineHook(l.hook).ethRouter());
        vm.serializeAddress(json, "imd", RobinhoodConfig.IMD);
        vm.serializeAddress(json, "feeRecipient", feeRecipient);
        vm.serializeAddress(json, "treasury", s.treasury);
        vm.serializeAddress(json, "signer", s.signer);
        vm.serializeInt(json, "startTick", l.startTick);
        string memory out = vm.serializeUint(json, "startMarketCapImd", startMcap);
        vm.writeJson(out, "./deployments/robinhood.json");
    }
}
