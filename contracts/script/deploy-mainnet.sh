#!/usr/bin/env bash
# Deploy MineWorldCraft to Robinhood Chain, with the settings in launch.env.
#
#   ./script/deploy-mainnet.sh launch                    # dry run against a fork: hook, $MINE, MiningSites, pool
#   MINING_SIGNER=0x... ./script/deploy-mainnet.sh launch --broadcast --browser --browser-disable-open
#   ./script/deploy-mainnet.sh miners                    # dry run of the Miners collection against a fork
#   ./script/deploy-mainnet.sh miners --broadcast --browser --browser-disable-open
#
# launch: MineHook at a mined CREATE2 address (with its two routers), MiningSites, $MINE (500M to the hook, 500M to
#   MiningSites), the pool opened (the 500M locked for good), then the hook renounced so the fee recipient is final.
#   MINING_SIGNER is the game server's voucher key's address (never the key).
# miners: MineWorldCraft Miners with the sale closed (open it later with setSaleOpen).
#
# Signing: --browser serves a page at http://127.0.0.1:9545 (--browser-disable-open: nothing opens by itself; paste
# the address into your browser) where you connect your wallet and approve each transaction, so no private key is typed
# anywhere. Switch the wallet to Robinhood Chain first. Or --account <keystore name> for a Foundry keystore. The wallet
# that signs owns MiningSites and the Miners (both hand over in two steps and can't be renounced).
#
# RPC_URL picks the RPC (default: foundry.toml's "robinhood"). The launch mines a CREATE2 salt first, which takes a
# while, so it needs an RPC that keeps a few minutes of state (Courier's launchpad needed the official RPC for this).
#
# The Miners' reveal secret: pass your own as SECRET=..., or, when broadcasting, one is generated and written to
# SECRET_FILE (default ~/mineworldcraft-miners-reveal-secret.txt, readable only by you; if it exists, the secret in it
# is reused, so a retry keeps the same commit). It is never printed. Keep it in a password manager too: the Miners can
# only be revealed with it (reveal(secret)). A dry run uses a throwaway secret and saves nothing.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"

STAGE="${1:-}"
shift || true
case "$STAGE" in
  launch | miners) ;;
  *) echo "Usage: $0 launch|miners [--broadcast --browser --browser-disable-open | --account <name>]" >&2; exit 1 ;;
esac

set -a
source ./launch.env
set +a
RPC="${RPC_URL:-robinhood}"

BROADCAST=0
for a in "$@"; do [ "$a" = "--broadcast" ] && BROADCAST=1; done

is_address() { [[ "$1" =~ ^0x[0-9a-fA-F]{40}$ ]] && [ "$1" != "0x0000000000000000000000000000000000000000" ]; }

if [ "$STAGE" = launch ]; then
  if ! is_address "${MINING_SIGNER:-}"; then
    if [ "$BROADCAST" = 1 ]; then
      echo "Set MINING_SIGNER to the game server's voucher key's address (0x..., not the key)." >&2
      exit 1
    fi
    export MINING_SIGNER=0x0000000000000000000000000000000000000001 # (dry run only)
    echo "(dry run without MINING_SIGNER: using a placeholder signer)"
  fi
  SCRIPT=(script/Deploy.s.sol --sig "run()")
  RECORD=deployments/robinhood.json
  KEYS=(mine sites hook)
else
  SECRET_FILE="${SECRET_FILE:-$HOME/mineworldcraft-miners-reveal-secret.txt}"
  if [ -z "${SECRET:-}" ]; then
    if [ "$BROADCAST" = 1 ]; then
      if [ -s "$SECRET_FILE" ]; then
        SECRET_NOTE="reused the reveal secret in $SECRET_FILE"
      else
        (umask 077 && cast to-dec "0x$(openssl rand -hex 32)" > "$SECRET_FILE")
        SECRET_NOTE="saved a new reveal secret to $SECRET_FILE"
      fi
      SECRET=$(cat "$SECRET_FILE")
    else
      SECRET=$(cast to-dec "0x$(openssl rand -hex 32)") # (dry run: a throwaway, never saved)
    fi
  fi
  SEED_COMMIT=$(cast keccak "$(cast abi-encode "f(uint256)" "$SECRET")")
  export SEED_COMMIT
  unset SECRET # the deploy only needs the commit
  SCRIPT=(script/DeployMiners.s.sol)
  RECORD=deployments/robinhood-miners.json
  KEYS=(miners)
fi

if [ "$BROADCAST" = 1 ]; then
  echo "Stage \"$STAGE\" on Robinhood Chain with:"
  if [ "$STAGE" = launch ]; then
    grep -E '^(FEE_RECIPIENT|TREASURY|START_MCAP_USD|SITE_PRICE|WALLET_DAILY_CAP|DAILY_CAP)=' launch.env | sed 's/^/  /'
    echo "  MINING_SIGNER=$MINING_SIGNER"
  else
    grep -E '^(TREASURY|MINERS_[A-Z_]+)=' launch.env | sed 's/^/  /'
    echo "  SEED_COMMIT=$SEED_COMMIT"
    [ -n "${SECRET_NOTE:-}" ] && echo "  ($SECRET_NOTE; not printed)"
  fi
  read -r -p "Type DEPLOY to continue: " ok
  [ "$ok" = "DEPLOY" ] || { echo "Cancelled."; exit 1; }
  forge script "${SCRIPT[@]}" --rpc-url "$RPC" "$@"
  # (forge writes the record even when sending fails: only contracts actually on chain count.)
  for k in "${KEYS[@]}"; do
    a=$(jq -r ".$k" "$RECORD")
    if [ "$(cast code "$a" --rpc-url "$RPC")" = "0x" ]; then
      echo "No contract at $a ($k): the deploy didn't go through. Nothing exported." >&2
      git checkout -- "$RECORD" 2>/dev/null || rm -f "$RECORD"
      exit 1
    fi
  done
  ./script/export-web.sh
else
  forge script "${SCRIPT[@]}" --fork-url "$RPC" "$@"
fi
