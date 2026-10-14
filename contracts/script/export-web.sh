#!/usr/bin/env bash
# Write web/deployments/robinhood.json: Robinhood Chain's details, the addresses the site needs and the contract
# ABIs. Commit it and the host serves it. After the launch it holds $MINE, the vault, MiningSites and MinePayments (their
# proxies, with the implementations' ABIs), the hook and its routers; I'M DIO (MineWorldCrafters) joins once deployed
# (either can come first), and CrafterLevels (`levels`, its proxy) once it is.
#   ./script/export-web.sh
# RPC_URL picks the RPC used to check there's a contract behind each address (default: foundry.toml's "robinhood").
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"

GAME=deployments/robinhood.json
CRAFTERS=deployments/robinhood-crafters.json
LEVELS=deployments/robinhood-levels.json
OUT=../web/deployments/robinhood.json
RPC="${RPC_URL:-robinhood}"
[ -f "$GAME" ] || [ -f "$CRAFTERS" ] || { echo "Nothing deployed yet: run deploy-mainnet.sh launch (or crafters) --broadcast first." >&2; exit 1; }
forge build >/dev/null
mkdir -p "$(dirname "$OUT")"

abi() { jq '.abi' "out/$1.sol/$1.json"; }
# (forge writes a record even when sending fails: refuse an address the chain says has no contract.)
check() {
  if [ "$(cast code "$1" --rpc-url "$RPC" 2>/dev/null)" = "0x" ]; then
    echo "No contract at $1 ($2): not exported." >&2
    exit 1
  fi
}

json=$(jq -n '{
  local: false,
  chainId: 4663,
  chainName: "Robinhood Chain",
  rpcUrl: "https://robinhood-rpc.publicnode.com",
  walletRpcUrl: "https://robinhood-rpc.publicnode.com",
  logsRpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",
  contracts: {multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11"},
  abis: {}
}')

if [ -f "$GAME" ]; then
  for k in mine vault sites payments hook; do check "$(jq -r ".$k" "$GAME")" "$k"; done
  json=$(echo "$json" | jq \
    --slurpfile d "$GAME" \
    --argjson mineAbi "$(abi MineToken)" \
    --argjson vaultAbi "$(abi MineVault)" \
    --argjson sitesAbi "$(abi MiningSites)" \
    --argjson paymentsAbi "$(abi MinePayments)" \
    --argjson hookAbi "$(abi MineHook)" \
    --argjson routerAbi "$(abi MineRouter)" \
    --argjson ethRouterAbi "$(abi MineEthRouter)" \
    '$d[0] as $g
     | .sitesBlock = $g.block
     | .contracts += {mine: $g.mine, vault: $g.vault, sites: $g.sites, payments: $g.payments, hook: $g.hook,
                      router: $g.router, ethRouter: $g.ethRouter,
                      imd: $g.imd,
                      poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
                      quoter: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94",
                      ethUsd: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9"}
     | .abis += {mine: $mineAbi, vault: $vaultAbi, sites: $sitesAbi, payments: $paymentsAbi, hook: $hookAbi,
                 router: $routerAbi, ethRouter: $ethRouterAbi}')
fi

if [ -f "$CRAFTERS" ]; then
  check "$(jq -r .crafters "$CRAFTERS")" crafters
  json=$(echo "$json" | jq --slurpfile m "$CRAFTERS" --argjson craftersAbi "$(abi MineWorldCrafters)" \
    '.contracts.crafters = $m[0].crafters | .craftersBlock = $m[0].block | .abis.crafters = $craftersAbi')
fi

# CrafterLevels: deployed with the launch (CRAFTERS set) or on its own afterwards (deploy-mainnet.sh levels).
levels=""
[ -f "$GAME" ] && levels=$(jq -r '.levels // empty' "$GAME")
[ -z "$levels" ] && [ -f "$LEVELS" ] && levels=$(jq -r '.levels // empty' "$LEVELS")
if [ -n "$levels" ]; then
  check "$levels" levels
  json=$(echo "$json" | jq --arg levels "$levels" --argjson levelsAbi "$(abi CrafterLevels)" \
    '.contracts.levels = $levels | .abis.levels = $levelsAbi')
fi

echo "$json" > "$OUT"
echo "wrote web/deployments/robinhood.json ($(echo "$json" | jq -r '.contracts | keys | join(", ")'))"
