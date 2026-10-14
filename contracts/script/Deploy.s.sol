// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {MineHook} from "../src/MineHook.sol";
import {MineToken} from "../src/MineToken.sol";
import {MineVault} from "../src/MineVault.sol";
import {MiningSites} from "../src/MiningSites.sol";
import {MinePayments} from "../src/MinePayments.sol";
import {CrafterLevels} from "../src/CrafterLevels.sol";
import {MineWorldCrafters} from "../src/MineWorldCrafters.sol";
import {UpgradeCosts} from "../src/UpgradeCosts.sol";
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

interface IOwned {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
}

/// @notice The deploy steps, shared by the scripts below and the tests.
///   - Bare dev chain (no Uniswap v4): $MINE with its launch allocation to a stand-in holder, then the game.
///   - Robinhood Chain, or a fork of it: MineHook (mined CREATE2 address) with its routers, $MINE (the launch
///     allocation to the hook), the game, the pool opened, then the hook renounced so the fee recipient is final.
///   The game: MiningSites' implementation, the vault (naming MiningSites' proxy, the deployer's next contract, its
///   distributor), the proxy, then MinePayments (implementation and proxy); $MINE's minter set, once, to the vault, and
///   the token's ownership renounced, as Courier World's launch does for $STAMP.
///   - CrafterLevels (implementation and proxy), once both $MINE and the Crafters exist (either can come first).
///   OWNER (default: the deploying wallet) owns the vault and every proxy from the start: nothing waits on it.
abstract contract MineDeployer is Script {
    int24 internal constant MIN_START_TICK = -300_000;
    int24 internal constant MAX_START_TICK = 400_000;
    /// @dev $MINE's cap (MineToken.MAX_SUPPLY) and the pool's launch allocation, half of it.
    uint256 internal constant MAX_SUPPLY = 21_000_000e18;
    uint256 internal constant POOL_SUPPLY = 10_500_000e18;

    /// @dev MiningSites' settings.
    struct Sites {
        address treasury;
        address signer;
        uint256 sitePrice;
        uint256 walletDailyCap;
        uint256 dailyCap;
    }

    /// @dev The game's contracts (the proxies, for the upgradeable ones, and their implementations).
    struct Game {
        address token;
        address vault;
        address sites;
        address sitesImpl;
        address payments;
        address paymentsImpl;
    }

    struct Launch {
        address hook;
        int24 startTick;
        Game game;
    }

    /// @dev MiningSites' settings from the environment: MINING_SIGNER (the game server's voucher key, an address),
    ///      SITE_PRICE (0.005 ether), WALLET_DAILY_CAP (1,500 $MINE), DAILY_CAP (35,000 $MINE, the most it can be:
    ///      the vault's daily limit).
    function _sitesFromEnv(address treasury) internal view returns (Sites memory s) {
        s.treasury = treasury;
        s.signer = vm.envAddress("MINING_SIGNER");
        s.sitePrice = vm.envOr("SITE_PRICE", uint256(0.005 ether));
        s.walletDailyCap = vm.envOr("WALLET_DAILY_CAP", uint256(1_500e18));
        s.dailyCap = vm.envOr("DAILY_CAP", uint256(35_000e18));
    }

    /// @dev OWNER: who owns the vault, the proxies and the Crafters (the deploying wallet if unset).
    function _ownerFromEnv(address deployer) internal view returns (address) {
        return vm.envOr("OWNER", deployer);
    }

    /// @dev $MINE (its launch allocation to `pool`), then the game (see the contract's notes). `deployer` creates
    ///      everything (the broadcasting wallet, or a test contract) and owns the token until it renounces; `owner`
    ///      owns the vault and the proxies from the start.
    function _deployGame(address deployer, address owner, address pool, Sites memory s)
        internal
        returns (Game memory g)
    {
        MineToken token = new MineToken(deployer, pool, POOL_SUPPLY);
        g.token = address(token);
        g.sitesImpl = address(new MiningSites());
        // The vault, then MiningSites' proxy: the deployer's next contract after the vault.
        address predicted = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        MineVault vault = new MineVault(token, owner, predicted);
        g.vault = address(vault);
        g.sites = address(
            new ERC1967Proxy(
                g.sitesImpl,
                abi.encodeCall(
                    MiningSites.initialize,
                    (IERC20(g.token), vault, owner, s.treasury, s.signer, s.sitePrice, s.walletDailyCap, s.dailyCap)
                )
            )
        );
        require(g.sites == predicted, "MiningSites isn't at the address the vault was given");
        // As Courier World's launch does for $STAMP: the one minter, set once, then nobody owns the token.
        token.setMinter(g.vault);
        token.renounceOwnership();
        g.paymentsImpl = address(new MinePayments());
        g.payments = address(
            new ERC1967Proxy(g.paymentsImpl, abi.encodeCall(MinePayments.initialize, (IERC20(g.token), owner, s.treasury)))
        );

        require(token.owner() == address(0) && token.minter() == g.vault, "the token isn't renounced to the vault");
        require(token.totalMinted() == POOL_SUPPLY && token.MAX_SUPPLY() == MAX_SUPPLY, "the supply changed");
        require(token.balanceOf(pool) == POOL_SUPPLY, "the pool didn't get its allocation");
        require(vault.distributor() == g.sites && address(vault.token()) == g.token, "the vault isn't wired");
        require(address(MiningSites(g.sites).vault()) == g.vault, "MiningSites points at another vault");
        require(_implementation(g.sites) == g.sitesImpl && _implementation(g.payments) == g.paymentsImpl, "proxies");
    }

    /// @dev The full launch. `deployer` owns the hook until it renounces at the end.
    function _launch(address deployer, address owner, address feeRecipient, uint256 startMcap, Sites memory s)
        internal
        returns (Launch memory l)
    {
        // Start price: `startMcap` IMD wei for all 21M $MINE (the pool holds half; the rest is earned in the game).
        l.startTick = DeployLib.startTickForMarketCap(startMcap, MAX_SUPPLY);
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
                POOL_SUPPLY,
                MineHook.ImdEthPool(RobinhoodConfig.IMD_ETH_FEE, RobinhoodConfig.IMD_ETH_SPACING, address(0))
            )
        );
        (bytes32 salt, address expected) =
            DeployLib.mineSalt(CREATE2_FACTORY, RobinhoodConfig.HOOK_FLAGS, initCode, vm.envOr("SALT_START", uint256(0)));
        require(expected.code.length == 0, "already deployed at mined address");
        (bool ok,) = CREATE2_FACTORY.call(abi.encodePacked(salt, initCode));
        require(ok && expected.code.length > 0, "hook deploy failed");
        l.hook = expected;

        l.game = _deployGame(deployer, owner, l.hook, s);
        require(MineToken(l.game.token).balanceOf(l.hook) == MineHook(l.hook).launchSupply(), "the hook didn't get the pool half");

        MineHook(l.hook).openPool(l.game.token); // locks the launch allocation forever
        MineHook(l.hook).renounceOwnership(); // the fee recipient is final
    }

    /// @dev CrafterLevels (implementation and proxy) for `crafters`, paid in `token`, owned by `owner` from the start.
    function _deployLevels(address owner, address token, address crafters, address treasury)
        internal
        returns (CrafterLevels levels, address impl)
    {
        require(token.code.length > 0, "no $MINE at MINE");
        require(crafters.code.length > 0, "no Crafters at CRAFTERS");
        impl = address(new CrafterLevels());
        levels = CrafterLevels(
            address(
                new ERC1967Proxy(
                    impl, abi.encodeCall(CrafterLevels.initialize, (IERC20(token), IERC721(crafters), owner, treasury))
                )
            )
        );
    }

    /// @dev Point the Crafters at `levels` for their "Level" trait, if `deployer` owns them; otherwise the owner must
    ///      (`_logLevels` prints the call).
    function _wireLevels(address deployer, CrafterLevels levels) internal {
        MineWorldCrafters crafters = MineWorldCrafters(address(levels.crafters()));
        if (crafters.owner() == deployer) crafters.setAttributesExtension(address(levels));
    }

    /// @dev Upgrade costs other than the contract's defaults, if `name` (SITE_UPGRADE_COSTS or CRAFTER_UPGRADE_COSTS)
    ///      lists them in $MINE wei, one per level above 1, comma-separated. Set now if `deployer` owns `c`; otherwise
    ///      the call the owner must make is printed.
    function _costsFromEnv(UpgradeCosts c, string memory name, address deployer) internal {
        uint256[] memory costs = vm.envOr(name, ",", new uint256[](0));
        if (costs.length == 0) return;
        if (c.owner() == deployer) {
            c.setUpgradeCosts(costs);
            return;
        }
        string memory list = "[";
        for (uint256 i; i < costs.length; i++) {
            list = string.concat(list, i == 0 ? "" : ",", vm.toString(costs[i]));
        }
        console.log(string.concat("  ", name, ": the owner, ", vm.toString(c.owner()), ", must call"));
        console.log(string.concat('    cast send ', vm.toString(address(c)), ' "setUpgradeCosts(uint256[])" "', list, ']"'));
    }

    function _implementation(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, ERC1967Utils.IMPLEMENTATION_SLOT))));
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
        console.log("Launch FDV (IMD wei, 21M MINE)", startMcap);
    }

    function _logCosts(UpgradeCosts c) internal view {
        uint256[] memory costs = c.upgradeCosts();
        string memory list;
        for (uint256 i; i < costs.length; i++) {
            list = string.concat(list, i == 0 ? "" : ", ", vm.toString(costs[i] / 1e18));
        }
        console.log(string.concat("  upgrade costs, levels 2-", vm.toString(c.maxLevel()), " (MINE): ", list));
        console.log("  burned of each upgrade (bps)", c.upgradeBurnBps());
    }

    /// @dev One `<Name> <address>` line per contract (dev.sh reads them), then the settings.
    function _log(Game memory g, address hook) internal view {
        console.log("MineToken", g.token);
        console.log("MineVault", g.vault);
        console.log("MiningSites", g.sites);
        console.log("MinePayments", g.payments);
        if (hook != address(0)) {
            console.log("MineHook", hook);
            console.log("Router", MineHook(hook).router());
            console.log("EthRouter", MineHook(hook).ethRouter());
        }
        MineToken token = MineToken(g.token);
        MineVault vault = MineVault(g.vault);
        MiningSites s = MiningSites(g.sites);
        console.log("  MINE minted / cap ", token.totalMinted() / 1e18, token.MAX_SUPPLY() / 1e18);
        console.log("  MINE minter       ", token.minter());
        console.log("  vault: daily, total limit (MINE)", vault.DAILY_LIMIT() / 1e18, vault.TOTAL_LIMIT() / 1e18);
        console.log("  vault lasts at least (days)", vault.TOTAL_LIMIT() / vault.DAILY_LIMIT());
        console.log("  sites implementation", g.sitesImpl);
        console.log("  sites treasury    ", s.treasury());
        console.log("  sites signer      ", s.signer());
        console.log("  site price (wei)  ", s.sitePrice());
        console.log("  wallet daily cap  ", s.walletDailyCap() / 1e18);
        console.log("  daily cap         ", s.dailyCap() / 1e18);
        uint256[] memory r = s.rates();
        string memory rates;
        for (uint256 i; i < r.length; i++) {
            rates = string.concat(rates, i == 0 ? "" : ", ", vm.toString(r[i]));
        }
        console.log(string.concat("  rates by level (bps): ", rates));
        _logCosts(s);
        console.log("  payments implementation", g.paymentsImpl);
        MinePayments p = MinePayments(g.payments);
        for (uint256 k; k < p.kindCount(); k++) {
            (string memory name, uint256 burn) = p.kind(k);
            console.log(string.concat("  payment kind ", vm.toString(k), " ", name, ", burned (bps): ", vm.toString(burn)));
        }
        if (hook == address(0)) return;
        MineHook h = MineHook(hook);
        console.log("  fee recipient     ", h.feeRecipient());
        console.log("  MINE price at launch (IMD wei per MINE)", h.price(g.token));
        console.log("  FDV at launch (IMD wei, 21M MINE)      ", h.marketCap(g.token));
    }

    /// @dev The CrafterLevels line (dev.sh reads it), its settings, and whether the Crafters show its levels yet.
    function _logLevels(CrafterLevels levels, address impl) internal view {
        console.log("CrafterLevels", address(levels));
        console.log("  levels implementation", impl);
        console.log("  levels treasury   ", levels.treasury());
        console.log("  levels crafters   ", address(levels.crafters()));
        _logCosts(levels);
        MineWorldCrafters crafters = MineWorldCrafters(address(levels.crafters()));
        if (crafters.attributesExtension() == address(levels)) {
            console.log("  I'M DIO shows these levels (attributes extension set)");
            return;
        }
        console.log("  I'M DIO's owner (contract MineWorldCrafters) must now point the collection at it, from", crafters.owner());
        console.log(
            string.concat(
                '    cast send ',
                vm.toString(address(crafters)),
                ' "setAttributesExtension(address)" ',
                vm.toString(address(levels))
            )
        );
    }

    /// @dev Every owned contract's owner, and a pending owner's acceptOwnership call.
    function _logOwners(address[] memory contracts, string[] memory names) internal view {
        console.log("Owners:");
        for (uint256 i; i < contracts.length; i++) {
            if (contracts[i] == address(0)) continue;
            IOwned c = IOwned(contracts[i]);
            console.log(string.concat("  ", names[i], " ", vm.toString(contracts[i]), " owner ", vm.toString(c.owner())));
            (bool ok, bytes memory data) = contracts[i].staticcall(abi.encodeCall(IOwned.pendingOwner, ()));
            if (ok && data.length == 32 && abi.decode(data, (address)) != address(0)) {
                address pending = abi.decode(data, (address));
                console.log(string.concat("    pending owner ", vm.toString(pending), ": it must call"));
                console.log(string.concat('    cast send ', vm.toString(contracts[i]), ' "acceptOwnership()"'));
            }
        }
    }

    function _gameOwners(Game memory g, address hook, address levels, address crafters)
        internal
        pure
        returns (address[] memory a, string[] memory n)
    {
        a = new address[](7);
        n = new string[](7);
        (a[0], n[0]) = (g.token, "MineToken (renounced)");
        (a[1], n[1]) = (g.vault, "MineVault");
        (a[2], n[2]) = (g.sites, "MiningSites");
        (a[3], n[3]) = (g.payments, "MinePayments");
        (a[4], n[4]) = (hook, "MineHook (renounced)");
        (a[5], n[5]) = (levels, "CrafterLevels");
        (a[6], n[6]) = (crafters, "MineWorldCrafters (I'M DIO)");
    }
}

/// @notice Deploys $MINE and the game, and CrafterLevels.
///
///   runLocal()   bare dev chain (../dev.sh): no Uniswap v4, so $MINE's launch allocation goes to the deployer as a
///                stand-in, and PLAYERS get MINE_EACH (1,000,000 $MINE, enough to try the upgrades) each from it. Env:
///                TREASURY, MINING_SIGNER, PLAYERS, SITE_UPGRADE_COSTS, OWNER.
///   run()        Robinhood Chain (./script/deploy-mainnet.sh launch), or a fork of it (../dev.sh --fork): the full
///                launch. Env: OWNER (owns the vault and the proxies; default: the deploying wallet), FEE_RECIPIENT
///                (the 4% trading fee, in IMD), TREASURY (site sales, upgrades and payments; default FEE_RECIPIENT),
///                MINING_SIGNER, START_MCAP_USD (launch price as a market cap for all 21M $MINE in whole dollars,
///                converted to IMD from the IMD/ETH pool and Chainlink ETH/USD; or START_MCAP in IMD wei), SITE_PRICE,
///                WALLET_DAILY_CAP, DAILY_CAP, SITE_UPGRADE_COSTS, SALT_START (0). With CRAFTERS (the Crafters'
///                address, if they're already deployed) it deploys CrafterLevels too, with CRAFTER_UPGRADE_COSTS.
///   runLevels()  CrafterLevels on its own, once $MINE (MINE) and the Crafters (CRAFTERS) both exist
///                (./script/deploy-mainnet.sh levels, or ../dev.sh). Env: OWNER, TREASURY, CRAFTER_UPGRADE_COSTS.
///
/// Calls only an owner can make (pointing the Crafters at CrafterLevels, custom upgrade costs) are made here when the
/// broadcasting wallet is that owner, and printed for the owner to make otherwise. Every contract's owner is printed
/// at the end.
contract Deploy is MineDeployer {
    function runLocal() external {
        Sites memory s = _sitesFromEnv(vm.envAddress("TREASURY"));
        address[] memory players = vm.envOr("PLAYERS", ",", new address[](0));
        uint256 each = vm.envOr("MINE_EACH", uint256(1_000_000e18));
        // The stand-in pool holder only makes sense where there's no pool: never on Robinhood Chain or a fork of it.
        require(
            address(RobinhoodConfig.POOL_MANAGER).code.length == 0,
            "runLocal is for a bare dev chain; use run() on Robinhood Chain or a fork of it"
        );

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        Game memory g = _deployGame(deployer, _ownerFromEnv(deployer), deployer, s);
        _costsFromEnv(MiningSites(g.sites), "SITE_UPGRADE_COSTS", deployer);
        for (uint256 i; i < players.length; i++) {
            MineToken(g.token).transfer(players[i], each);
        }
        vm.stopBroadcast();
        _log(g, address(0));
        (address[] memory a, string[] memory n) = _gameOwners(g, address(0), address(0), address(0));
        _logOwners(a, n);
    }

    function run() external {
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        address treasury = vm.envOr("TREASURY", feeRecipient);
        Sites memory s = _sitesFromEnv(treasury);
        address crafters = vm.envOr("CRAFTERS", address(0));
        uint256 startMcap = _startMcap();

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        address owner = _ownerFromEnv(deployer);
        Launch memory l = _launch(deployer, owner, feeRecipient, startMcap, s);
        _costsFromEnv(MiningSites(l.game.sites), "SITE_UPGRADE_COSTS", deployer);
        CrafterLevels levels;
        address levelsImpl;
        if (crafters != address(0)) {
            (levels, levelsImpl) = _deployLevels(owner, l.game.token, crafters, treasury);
            _costsFromEnv(levels, "CRAFTER_UPGRADE_COSTS", deployer);
            _wireLevels(deployer, levels);
        }
        vm.stopBroadcast();
        _log(l.game, l.hook);
        if (address(levels) != address(0)) _logLevels(levels, levelsImpl);
        else console.log("CrafterLevels: not yet (set CRAFTERS once I'M DIO exists; deploy-mainnet.sh levels)");
        (address[] memory a, string[] memory n) = _gameOwners(l.game, l.hook, address(levels), crafters);
        _logOwners(a, n);

        // (dev.sh sets DEV_CHAIN: an Anvil fork of Robinhood Chain has its chain ID too, and must not touch the real record.)
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || block.chainid != 4663 || vm.envOr("DEV_CHAIN", false)) return;
        string memory json = "mine";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeUint(json, "block", block.number);
        vm.serializeAddress(json, "mine", l.game.token);
        vm.serializeAddress(json, "vault", l.game.vault);
        vm.serializeAddress(json, "sites", l.game.sites);
        vm.serializeAddress(json, "sitesImplementation", l.game.sitesImpl);
        vm.serializeAddress(json, "payments", l.game.payments);
        vm.serializeAddress(json, "paymentsImplementation", l.game.paymentsImpl);
        vm.serializeAddress(json, "hook", l.hook);
        vm.serializeAddress(json, "router", MineHook(l.hook).router());
        vm.serializeAddress(json, "ethRouter", MineHook(l.hook).ethRouter());
        vm.serializeAddress(json, "imd", RobinhoodConfig.IMD);
        vm.serializeAddress(json, "owner", owner);
        vm.serializeAddress(json, "feeRecipient", feeRecipient);
        vm.serializeAddress(json, "treasury", s.treasury);
        vm.serializeAddress(json, "signer", s.signer);
        if (address(levels) != address(0)) {
            vm.serializeAddress(json, "levels", address(levels));
            vm.serializeAddress(json, "levelsImplementation", levelsImpl);
        }
        vm.serializeInt(json, "startTick", l.startTick);
        string memory out = vm.serializeUint(json, "startMarketCapImd", startMcap);
        vm.writeJson(out, "./deployments/robinhood.json");
    }

    function runLevels() external {
        address token = vm.envAddress("MINE");
        address crafters = vm.envAddress("CRAFTERS");
        address treasury = vm.envAddress("TREASURY");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        (CrafterLevels levels, address impl) = _deployLevels(_ownerFromEnv(deployer), token, crafters, treasury);
        _costsFromEnv(levels, "CRAFTER_UPGRADE_COSTS", deployer);
        _wireLevels(deployer, levels);
        vm.stopBroadcast();
        _logLevels(levels, impl);
        address[] memory a = new address[](2);
        string[] memory n = new string[](2);
        (a[0], n[0]) = (address(levels), "CrafterLevels");
        (a[1], n[1]) = (crafters, "MineWorldCrafters (I'M DIO)");
        _logOwners(a, n);

        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || block.chainid != 4663 || vm.envOr("DEV_CHAIN", false)) return;
        string memory json = "levels";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeUint(json, "block", block.number);
        vm.serializeAddress(json, "mine", token);
        vm.serializeAddress(json, "crafters", crafters);
        vm.serializeAddress(json, "treasury", treasury);
        vm.serializeAddress(json, "levelsImplementation", impl);
        string memory out = vm.serializeAddress(json, "levels", address(levels));
        vm.writeJson(out, "./deployments/robinhood-levels.json");
    }
}
