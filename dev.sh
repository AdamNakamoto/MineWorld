#!/usr/bin/env bash
# Local dev: a fresh Anvil chain, the MineWorldCraft contracts, web/chain.json for the game and multiplayer/.dev.vars
# for the local room, then the site served from web/. Anvil's dev accounts are unlocked, so the page plays as any of
# them. Ports differ from Courier World's dev setup (Anvil 8610, site 5810), so both can run at once.
#
#   ./dev.sh                 # empty chain: $MINE, MiningSites and the Miners. No Uniswap v4 here, so $MINE's pool half
#                            # is held by the deployer as a stand-in (no trading)
#   ./dev.sh --fork          # fork of Robinhood Chain: the full launch against the real PoolManager, IMD and IMD/ETH
#                            # pool (hook, routers, pool opened, hook renounced), so trading works (no real money)
#   ./dev.sh --wallet        # log in with your own browser wallet (MetaMask...) as on mainnet. The chain gets its own
#                            # ID, so nothing signed there works elsewhere. Combines with --fork.
#   ./dev.sh --sale          # leave the Miners' sale open and sealed, to try the mint and the reveal (the owner,
#                            # account 0, reveals with chain.json's devSecret). Without it the players get miners at
#                            # once and the collection is revealed.
#
# Accounts: 0 deploys, and owns MiningSites and the Miners; 1 is the treasury and the fee recipient; 2-9 are players,
# each with some $MINE (100,000 from the stand-in on the empty chain; bought with 0.01 ETH through the pool on a fork)
# and, without --sale, two miners. The voucher key MiningSites trusts is a throwaway made here for this chain only; it
# goes into multiplayer/.dev.vars and is never printed.
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
FORK_URL="${FORK_URL:-https://robinhood.drpc.org}"
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
# The reveal mixes in the previous block's hash, so a fresh chain needs a block or two first.
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
MINE=$(addr MineToken) SITES=$(addr MiningSites)
HOOK=$(addr MineHook) ROUTER=$(addr Router) ETH_ROUTER=$(addr EthRouter)
[ -n "$MINE" ] && [ -n "$SITES" ] || { echo "$OUT"; exit 1; }

# The Miners, committed to this chain's throwaway secret, with the sale open.
MINERS_PRICE=4000000000000000
SEED_COMMIT=$(cast keccak "$(cast abi-encode "f(uint256)" "$SECRET")") OPEN_SALE=true MINERS_PRICE=$MINERS_PRICE \
  MINERS_IMAGES="http://localhost:$WEB_PORT/miners/" deploy script/DeployMiners.s.sol
MINERS=$(addr Miners)
[ -n "$MINERS" ] || { echo "$OUT"; exit 1; }

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
  # Two miners for each player (paid to the treasury, as anyone's mint), then the sale closes and, a block later, the
  # owner reveals with this chain's secret.
  HASHES=()
  for p in "${PLAYER_LIST[@]}"; do
    HASHES+=($(cast send "$MINERS" "mint(uint256)" 2 --value $((MINERS_PRICE * 2)) \
      --from "$p" --unlocked --rpc-url "$RPC" --async))
  done
  wait_ok "${HASHES[@]}"
  cast send "$MINERS" "setSaleOpen(bool)" false --from "$DEPLOYER" --unlocked --rpc-url "$RPC" >/dev/null
  cast rpc anvil_mine 1 --rpc-url "$RPC" >/dev/null
  cast send "$MINERS" "reveal(uint256)" "$SECRET" --from "$DEPLOYER" --unlocked --rpc-url "$RPC" >/dev/null
fi

CHAIN_ID=$(cast chain-id --rpc-url "$RPC")
NAME=Anvil
[ "$FORK" = 1 ] && NAME="Robinhood Chain (fork)"
if [ "$WALLET" = 1 ]; then
  NAME="MineWorldCraft practice"
  [ "$FORK" = 1 ] && NAME="MineWorldCraft practice (Robinhood fork)"
fi

# `npx wrangler dev` in multiplayer/ reads these: it signs vouchers for this chain's MiningSites, and reads the Miners.
mkdir -p multiplayer
(umask 077 && printf 'MINING_KEY=%s\nMINING_ADDRESS=%s\nCHAIN_ID=%s\nCHAIN_RPC=%s\nMINERS_ADDRESS=%s\n' \
  "$MINING_KEY" "$SITES" "$CHAIN_ID" "$RPC" "$MINERS" > multiplayer/.dev.vars)

# web/chain.json: what the game reads to find this chain and its contracts.
mkdir -p web
contracts=$(jq -n --arg mine "$MINE" --arg sites "$SITES" --arg miners "$MINERS" '{mine: $mine, sites: $sites, miners: $miners}')
abis=$(jq -n --argjson mine "$(abi MineToken)" --argjson sites "$(abi MiningSites)" --argjson miners "$(abi MineWorldMiners)" \
  '{mine: $mine, sites: $sites, miners: $miners}')
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
echo "MiningSites $SITES"
if [ "$FORK" = 1 ]; then
  echo "MineHook    $HOOK"
  echo "Router      $ROUTER"
  echo "EthRouter   $ETH_ROUTER"
fi
echo "Miners      $MINERS ($([ "$SALE" = 1 ] && echo "sale open, sealed" || echo "revealed, 2 per player"))"
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
