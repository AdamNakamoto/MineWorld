#!/usr/bin/env bash
# Local dev: a fresh Anvil chain, the MineWorldCraft contracts, web/chain.json for the game and multiplayer/.dev.vars
# for the local room, then the site served from web/. Anvil's dev accounts are unlocked, so the page plays as any of
# them. Ports differ from Courier World's dev setup (Anvil 8610, site 5810), so both can run at once.
#
#   ./dev.sh                 # empty chain: $MINE, MiningSites, I'M DEGEN (contract MineWorldCrafters) and CrafterLevels.
#                            # No Uniswap v4 here, so
#                            # $MINE's pool half is held by the deployer as a stand-in (no trading)
#   ./dev.sh --fork          # fork of Robinhood Chain: the full launch against the real PoolManager, IMD and IMD/ETH
#                            # pool (hook, routers, pool opened, hook renounced), so trading works (no real money)
#   ./dev.sh --wallet        # log in with your own browser wallet (MetaMask...) as on mainnet. The chain gets its own
#                            # ID, so nothing signed there works elsewhere. Combines with --fork.
#   ./dev.sh --sale          # leave the I'M DEGEN sale open and sealed, to try the mint and the reveal: the owner
#                            # (account 0) closes the sale, then the panel's "Reveal and lock in" (its secret field
#                            # holds chain.json's devSecret) publishes it and seals at once (not on --fork, see
#                            # below). Without it the players get two DEGENs each (3 per wallet at most), revealed.
#
# Accounts: 0 deploys, and owns the vault, the proxies (MiningSites, MinePayments, CrafterLevels) and I'M DEGEN; 1 is
# the treasury and the fee recipient; 2-9 are players, each with some $MINE (1,000,000 from the stand-in on the empty
# chain, enough to try the upgrades; bought with 0.01 ETH through the pool on a fork) and, without --sale, two DEGENs.
# The voucher key MiningSites trusts is a throwaway made here for this chain only; it goes into multiplayer/.dev.vars
# and is never printed.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.foundry/bin:$PATH"

FORK=0 WALLET=0 SALE=0
for a in "$@"; do
  case "$a" in
    --fork) FORK=1 ;;
    --wallet) WALLET=1 ;;
    --sale) SALE=1 ;;
    *) echo "Unknown option $a (use --fork, --wallet, --sale)" >&2; exit 1 ;;
  esac
done
# The official RPC keeps the old state a fork reads as it goes (drpc drops it after about a minute). Where a network's
# DNS blocks its name (Anvil then sees the wrong certificate), run `python3 tools/rpc-relay.py` and fork from it:
# FORK_URL=http://127.0.0.1:8611 ./dev.sh --fork
FORK_URL="${FORK_URL:-https://rpc.mainnet.chain.robinhood.com}"
# Chain ID for --wallet: unused by any public chain and never Robinhood Chain's 4663 (nor Courier's practice chain's
# 466399), so a transaction or permit signed on the practice chain can't be replayed on a real one.
PRACTICE_CHAIN_ID="${PRACTICE_CHAIN_ID:-466400}"
RPC_PORT="${RPC_PORT:-8610}"
WEB_PORT="${WEB_PORT:-5810}"
RPC="http://127.0.0.1:$RPC_PORT"

for port in "$RPC_PORT" "$WEB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is busy; set RPC_PORT / WEB_PORT to free ports" >&2
    exit 1
  fi
done

ANVIL_ARGS=(--silent --port "$RPC_PORT" --block-time 1)
# (Cancun, as the contracts are compiled: later forks make Anvil read EIP-2935's block-hash contract every block,
# and the public RPCs refuse that old state after a minute or two.)
[ "$FORK" = 1 ] && ANVIL_ARGS+=(--fork-url "$FORK_URL" --hardfork cancun)
[ "$WALLET" = 1 ] && ANVIL_ARGS+=(--chain-id "$PRACTICE_CHAIN_ID")
anvil "${ANVIL_ARGS[@]}" &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null' EXIT INT TERM
until cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; do
  kill -0 "$ANVIL_PID" 2>/dev/null || { echo "Anvil didn't start (is the fork RPC reachable?)" >&2; exit 1; }
  sleep 0.2
done

ACCOUNTS=($(cast rpc eth_accounts --rpc-url "$RPC" | jq -r '.[]'))
if [ "$FORK" = 1 ]; then
  # Anvil's dev keys are public, and on mainnet these accounts carry EIP-7702 delegations to sweeper
  # contracts that forward any ETH they receive. Clear them so the fork's dev accounts are plain wallets.
  for a in "${ACCOUNTS[@]}"; do cast rpc anvil_setCode "$a" 0x --rpc-url "$RPC" >/dev/null; done
fi
# The reveal mixes in the hash of the block after the secret is published; a block or two first, for some history.
cast rpc anvil_mine 2 --rpc-url "$RPC" >/dev/null
DEPLOYER=${ACCOUNTS[0]}
PLAYER_LIST=("${ACCOUNTS[@]:2}")
# A throwaway reveal secret for this local chain only (chain.json carries it as devSecret).
export SECRET=$(cast to-dec "0x$(openssl rand -hex 16)")
export FEE_RECIPIENT=${ACCOUNTS[1]} TREASURY=${ACCOUNTS[1]}
export DEV_CHAIN=true # the deploy scripts never write contracts/deployments/ from here
export PLAYERS=$(IFS=,; echo "${PLAYER_LIST[*]}")
# The voucher key for MiningSites: made here, for this chain only, and never printed. (Newer cast wraps the result in
# {data: ...}.)
MINING_KEY=$(cast wallet new --json | jq -r '(.data? // .) | if type == "array" then .[0] else . end | .private_key')
export MINING_SIGNER=$(cast wallet address "$MINING_KEY")
export START_MCAP_USD="${START_MCAP_USD:-5000}"

deploy() { # <script> [--sig <fn>]: run a forge script as the deployer (account 0) and keep its output in OUT
  OUT=$(cd contracts && forge script "$@" --rpc-url "$RPC" --unlocked --sender "$DEPLOYER" --broadcast 2>&1) \
    || { echo "$OUT"; exit 1; }
}
addr() { echo "$OUT" | awk -v k="$1" '$1 == k {print $2; exit}'; }
abi() { jq '.abi' "contracts/out/$1.sol/$1.json"; }
wait_ok() { # <tx hash>...: wait for each, and stop if one failed
  local h
  for h in "$@"; do
    case "$(cast receipt "$h" status --rpc-url "$RPC")" in
      true | 1*) ;; # (cast prints "true", older versions "1 (success)")
      *) echo "Transaction $h failed" >&2; exit 1 ;;
    esac
  done
}

echo "Deploying..."
if [ "$FORK" = 1 ]; then
  deploy script/Deploy.s.sol --sig "run()"
else
  deploy script/Deploy.s.sol --sig "runLocal()"
fi
MINE=$(addr MineToken) SITES=$(addr MiningSites) VAULT=$(addr MineVault) PAYMENTS=$(addr MinePayments)
HOOK=$(addr MineHook) ROUTER=$(addr Router) ETH_ROUTER=$(addr EthRouter)
[ -n "$MINE" ] && [ -n "$SITES" ] && [ -n "$VAULT" ] && [ -n "$PAYMENTS" ] || { echo "$OUT"; exit 1; }

# I'M DEGEN (contract MineWorldCrafters, and its on-chain art), committed to this chain's throwaway secret, with the sale
# open. Free, as at
# launch (CRAFTERS_PRICE=<wei> ./dev.sh to try a paid mint).
CRAFTERS_PRICE="${CRAFTERS_PRICE:-0}"
SEED_COMMIT=$(cast keccak "$(cast abi-encode "f(uint256)" "$SECRET")") OPEN_SALE=true CRAFTERS_PRICE=$CRAFTERS_PRICE \
  deploy script/DeployCrafters.s.sol
CRAFTERS=$(addr MineWorldCrafters)
[ -n "$CRAFTERS" ] || { echo "$OUT"; exit 1; }

# CrafterLevels: DEGEN levels paid in $MINE, wired to I'M DEGEN at once (the deployer owns both here).
MINE=$MINE CRAFTERS=$CRAFTERS deploy script/Deploy.s.sol --sig "runLevels()"
LEVELS=$(addr CrafterLevels)
[ -n "$LEVELS" ] || { echo "$OUT"; exit 1; }

if [ "$FORK" = 1 ]; then
  # $MINE for the players, bought with 0.01 ETH each through the real IMD/ETH pool and the $MINE pool (4% fee included).
  HASHES=()
  for p in "${PLAYER_LIST[@]}"; do
    HASHES+=($(cast send "$ETH_ROUTER" "buyWithEth(address,uint256,uint256)" "$MINE" 1 9999999999 --value 0.01ether \
      --from "$p" --unlocked --rpc-url "$RPC" --async))
  done
  wait_ok "${HASHES[@]}"
fi

if [ "$SALE" = 0 ]; then
  # Two DEGENs for each player (as anyone mints them; 3 a wallet at most), then the sale closes, the owner publishes
  # this chain's secret (reveal) and the seed is sealed at once: a player sends seal() (anyone can, within the window).
  HASHES=()
  for p in "${PLAYER_LIST[@]}"; do
    HASHES+=($(cast send "$CRAFTERS" "mint(uint256)" 2 --value $((CRAFTERS_PRICE * 2)) \
      --from "$p" --unlocked --rpc-url "$RPC" --async))
  done
  wait_ok "${HASHES[@]}"
  cast send "$CRAFTERS" "setSaleOpen(bool)" false --from "$DEPLOYER" --unlocked --rpc-url "$RPC" >/dev/null
  # The honest reveal: publish the secret, then seal at once (retrying until the seed is set), so no window passes
  # unsealed.
  cast send "$CRAFTERS" "reveal(uint256)" "$SECRET" --from "$DEPLOYER" --unlocked --rpc-url "$RPC" >/dev/null
  cast rpc anvil_mine 2 --rpc-url "$RPC" >/dev/null
  if [ "$FORK" = 1 ]; then
    # On a fork of Robinhood Chain the collection reads Arbitrum's ArbSys (0x64), which Anvil only half emulates: it
    # gives the L2 block number but not the L2 block hash, so seal() can't work here. Set the seed as seal() would,
    # with a stand-in hash (local chains only; the bare chain and the tests run seal() itself).
    SLOT=$(cd contracts && forge inspect MineWorldCrafters storageLayout --json | jq -r '.storage[] | select(.label == "seed") | .slot')
    SEED=$(cast keccak "$(cast abi-encode "f(uint256,bytes32)" "$SECRET" "$(cast keccak "anvil fork")")")
    cast rpc anvil_setStorageAt "$CRAFTERS" "$(cast to-uint256 "$SLOT")" "$SEED" --rpc-url "$RPC" >/dev/null
  else
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      cast send "$CRAFTERS" "seal()" --from "${PLAYER_LIST[0]}" --unlocked --rpc-url "$RPC" >/dev/null 2>&1 || true
      [ "$(cast call "$CRAFTERS" "seed()(uint256)" --rpc-url "$RPC")" != 0 ] && break
      cast rpc anvil_mine 1 --rpc-url "$RPC" >/dev/null
    done
    [ "$(cast call "$CRAFTERS" "seed()(uint256)" --rpc-url "$RPC")" != 0 ] || { echo "The I'M DEGEN reveal didn't seal" >&2; exit 1; }
  fi
fi

CHAIN_ID=$(cast chain-id --rpc-url "$RPC")
NAME=Anvil
[ "$FORK" = 1 ] && NAME="Robinhood Chain (fork)"
if [ "$WALLET" = 1 ]; then
  NAME="MineWorldCraft practice"
  [ "$FORK" = 1 ] && NAME="MineWorldCraft practice (Robinhood fork)"
fi

# `npx wrangler dev` in multiplayer/ reads these: it signs vouchers for this chain's MiningSites, reads I'M DEGEN and
# their levels, and checks rocket tickets paid through MinePayments.
mkdir -p multiplayer
(umask 077 && printf 'MINING_KEY=%s\nMINING_ADDRESS=%s\nCHAIN_ID=%s\nCHAIN_RPC=%s\nCRAFTERS_ADDRESS=%s\nLEVELS_ADDRESS=%s\nPAYMENTS_ADDRESS=%s\nSITES_SEED=\n' \
  "$MINING_KEY" "$SITES" "$CHAIN_ID" "$RPC" "$CRAFTERS" "$LEVELS" "$PAYMENTS" > multiplayer/.dev.vars)

# web/chain.json: what the game reads to find this chain and its contracts.
mkdir -p web
contracts=$(jq -n --arg mine "$MINE" --arg vault "$VAULT" --arg sites "$SITES" --arg payments "$PAYMENTS" \
  --arg crafters "$CRAFTERS" --arg levels "$LEVELS" \
  '{mine: $mine, vault: $vault, sites: $sites, payments: $payments, crafters: $crafters, levels: $levels}')
abis=$(jq -n --argjson mine "$(abi MineToken)" --argjson vault "$(abi MineVault)" --argjson sites "$(abi MiningSites)" \
  --argjson payments "$(abi MinePayments)" --argjson crafters "$(abi MineWorldCrafters)" --argjson levels "$(abi CrafterLevels)" \
  '{mine: $mine, vault: $vault, sites: $sites, payments: $payments, crafters: $crafters, levels: $levels}')
if [ "$FORK" = 1 ]; then
  # Robinhood Chain addresses, as in contracts/script/export-web.sh.
  contracts=$(echo "$contracts" | jq --arg hook "$HOOK" --arg router "$ROUTER" --arg ethRouter "$ETH_ROUTER" \
    '. + {hook: $hook, router: $router, ethRouter: $ethRouter,
          imd: "0x5F7Bb59365ce557C26dbcAa4EE9d39A4b95B7127", poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
          quoter: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94", ethUsd: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9",
          multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11"}')
  abis=$(echo "$abis" | jq --argjson hook "$(abi MineHook)" --argjson router "$(abi MineRouter)" --argjson ethRouter "$(abi MineEthRouter)" \
    '. + {hook: $hook, router: $router, ethRouter: $ethRouter}')
fi
jq -n --arg rpc "$RPC" --argjson chainId "$CHAIN_ID" --arg name "$NAME" --arg secret "$SECRET" \
  --argjson wallet "$([ "$WALLET" = 1 ] && echo true || echo false)" --argjson contracts "$contracts" --argjson abis "$abis" \
  '{local: true, wallet: $wallet, chainId: $chainId, chainName: $name, rpcUrl: $rpc, devSecret: $secret,
    contracts: $contracts, abis: $abis}' \
  > web/chain.json

echo "MineToken   $MINE"
echo "MineVault   $VAULT"
echo "MiningSites $SITES"
echo "Payments    $PAYMENTS"
if [ "$FORK" = 1 ]; then
  echo "MineHook    $HOOK"
  echo "Router      $ROUTER"
  echo "EthRouter   $ETH_ROUTER"
fi
echo "I'M DEGEN     $CRAFTERS ($([ "$SALE" = 1 ] && echo "sale open, sealed" || echo "revealed, 2 per player"))"
echo "Levels      $LEVELS (CrafterLevels, wired to I'M DEGEN)"
echo "Chain       $RPC ($NAME, chain ID $CHAIN_ID)"
echo "Wrote       web/chain.json, multiplayer/.dev.vars"
echo "Game        http://localhost:$WEB_PORT"
if [ "$WALLET" = 1 ]; then
  echo
  echo "Log in with your browser wallet; the page asks it to add \"$NAME\"."
  echo "Transactions and signatures on this chain only work here, never on Robinhood Chain."
  echo "After restarting dev.sh, if MetaMask shows a nonce error: Settings > Advanced > Clear activity tab data."
  echo
fi
python3 tools/serve.py "$WEB_PORT" web
