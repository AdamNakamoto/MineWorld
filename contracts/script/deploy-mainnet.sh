#!/usr/bin/env bash
# Deploy MineWorldCraft to Robinhood Chain, with the settings in launch.env.
#
#   ./script/deploy-mainnet.sh launch                    # dry run against a fork: hook, $MINE, the game, the pool
#   MINING_SIGNER=0x... ./script/deploy-mainnet.sh launch --broadcast --browser --browser-disable-open
#   ./script/deploy-mainnet.sh crafters                  # dry run of I'M DEGEN (MineWorldCrafters) against a fork
#   ./script/deploy-mainnet.sh crafters --broadcast --browser --browser-disable-open
#   ./script/deploy-mainnet.sh levels                    # dry run of CrafterLevels, once $MINE and I'M DEGEN exist
#   ./script/deploy-mainnet.sh levels --broadcast --browser --browser-disable-open
#   ./script/deploy-mainnet.sh verify                    # verify every deployed source on Sourcify (as Courier World)
#
# launch: MineHook at a mined CREATE2 address (with its two routers); $MINE, as Courier World's $STAMP: 10.5M of its 21M
#   cap minted to the hook, the rest minted later only by the mining vault; MiningSites (implementation and proxy), the
#   vault (MineVault, $MINE's one minter: at most 35,000 a day, 10.5M in all), MinePayments (implementation and proxy);
#   the token's minter set to the vault and its ownership renounced; the pool opened (the 10.5M locked for good), then
#   the hook renounced (after that only the fee recipient moves its fees). OWNER owns the vault and the proxies.
#   MINING_SIGNER is the game server's voucher key's address (never the key). With CRAFTERS set (I'M DEGEN came first),
#   CrafterLevels too. A hard precondition: the vault is given the address of the deploying wallet's next contract
#   (MiningSites' proxy), and the script requires the proxy landed there, so the wallet sends nothing else until the
#   stage is done. Every stage broadcasts with --slow: a transaction goes out only once the one before succeeded, so a
#   failed step stops the run (before the token's renounce, say).
# crafters: the on-chain art (CrafterArt: every DEGEN's skin and card) and I'M DEGEN (contract MineWorldCrafters) with
#   the sale closed (open it later),
#   owned by OWNER (handed over in two steps if the deploying wallet sets anything up first: OWNER then accepts).
# levels: CrafterLevels (implementation and proxy; DEGEN levels paid in $MINE), for $MINE and I'M DEGEN in
#   deployments/ (or MINE= and CRAFTERS=), owned by OWNER.
# Every stage prints each contract's owner, and the calls only OWNER can make that are still to do (acceptOwnership,
# I'M DEGEN's setAttributesExtension, custom upgrade costs) when the deploying wallet isn't OWNER.
#
# Signing: --browser serves a page at http://127.0.0.1:9545 (--browser-disable-open: nothing opens by itself; paste
# the address into your browser) where you connect your wallet and approve each transaction, so no private key is typed
# anywhere. Switch the wallet to Robinhood Chain first. Or --account <keystore name> for a Foundry keystore. The wallet
# that signs only deploys: OWNER (launch.env) owns everything that has an owner.
#
# RPC_URL picks the RPC (default: foundry.toml's "robinhood"). The launch mines a CREATE2 salt first, which takes a
# while, so it needs an RPC that keeps a few minutes of state (Courier's launchpad needed the official RPC for this).
#
# I'M DEGEN's reveal secret: pass your own as SECRET=..., or, when broadcasting, one is generated and written to
# SECRET_FILE (default ~/mineworldcraft-crafters-reveal-secret.txt, readable only by you; if it exists, the secret in
# it is reused, so a retry keeps the same commit). It is never printed. Keep it in a password manager too: I'M DEGEN
# can only be revealed with it (reveal(secret)). A dry run uses a throwaway secret and saves nothing.
#
# The reveal, after the mint: setSaleOpen(false), then OWNER calls reveal(secret), which publishes the secret and makes
# the seed wait for the next L2 block's hash, and seals at once: the game's panel does both (log in as OWNER, I'M DEGEN,
# "Reveal and lock in"), or with a Foundry keystore:
#   cast send <I'M DEGEN> "reveal(uint256)" "$(cat ~/mineworldcraft-crafters-reveal-secret.txt)" --account <owner> --rpc-url robinhood \
#     && until cast send <I'M DEGEN> "seal()" --account <owner> --rpc-url robinhood; do sleep 1; done
# Anyone can seal() for 256 L2 blocks (about 26 seconds on Robinhood Chain). After a window nobody sealed in, only OWNER
# can move the entropy block on (moveEntropyOn, at most 3 times in all, each in public), then seal again. Nobody, the
# owner included, can see the looks before everyone can. Announce the reveal time in advance, so holders can run
# tools/sealer.sh (RPC_URL=... ./tools/sealer.sh --account <keystore name>), which seals the moment it can: then the
# owner doesn't decide alone whether a window gets sealed.
#
# I'M DEGEN's ownership can never be renounced, so OpenSea Studio (which lets only owner() edit the collection) always
# works: deploy it from the OWNER wallet itself, so OWNER is its creator and its owner.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"

STAGE="${1:-}"
shift || true
case "$STAGE" in
  launch | crafters | levels | verify) ;;
  *) echo "Usage: $0 launch|crafters|levels|verify [--broadcast --browser --browser-disable-open | --account <name>]" >&2; exit 1 ;;
esac

set -a
source ./launch.env
set +a
RPC="${RPC_URL:-robinhood}"

BROADCAST=0
for a in "$@"; do [ "$a" = "--broadcast" ] && BROADCAST=1; done

is_address() { [[ "$1" =~ ^0x[0-9a-fA-F]{40}$ ]] && [ "$1" != "0x0000000000000000000000000000000000000000" ]; }

if [ "$STAGE" = verify ]; then
  # Sourcify, as Courier World's contracts are verified. Each record's contracts, with their sources.
  PROXY=lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy
  verify() { # <record> <key> <path:Name>
    [ -f "$1" ] || return 0
    local a
    a=$(jq -r ".$2 // empty" "$1")
    [ -n "$a" ] || return 0
    echo "Verifying $2 ($a) as $3"
    forge verify-contract "$a" "$3" --chain 4663 --verifier sourcify --rpc-url "$RPC" --watch \
      || echo "  (not verified: check it on https://sourcify.dev)" >&2
  }
  G=deployments/robinhood.json C=deployments/robinhood-crafters.json L=deployments/robinhood-levels.json
  verify $G mine src/MineToken.sol:MineToken
  verify $G vault src/MineVault.sol:MineVault
  verify $G sitesImplementation src/MiningSites.sol:MiningSites
  verify $G sites "$PROXY"
  verify $G paymentsImplementation src/MinePayments.sol:MinePayments
  verify $G payments "$PROXY"
  verify $G hook src/MineHook.sol:MineHook
  verify $G router src/MineRouter.sol:MineRouter
  verify $G ethRouter src/MineEthRouter.sol:MineEthRouter
  verify $G levelsImplementation src/CrafterLevels.sol:CrafterLevels
  verify $G levels "$PROXY"
  verify $C art src/CrafterArt.sol:CrafterArt
  verify $C crafters src/MineWorldCrafters.sol:MineWorldCrafters
  verify $L levelsImplementation src/CrafterLevels.sol:CrafterLevels
  verify $L levels "$PROXY"
  exit 0
fi

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
  KEYS=(mine vault sites sitesImplementation payments paymentsImplementation hook)
  if [ -n "${CRAFTERS:-}" ]; then
    is_address "$CRAFTERS" || { echo "CRAFTERS isn't an address." >&2; exit 1; }
    KEYS+=(levels levelsImplementation)
  fi
elif [ "$STAGE" = levels ]; then
  MINE="${MINE:-$(jq -r '.mine // empty' deployments/robinhood.json 2>/dev/null || true)}"
  CRAFTERS="${CRAFTERS:-$(jq -r '.crafters // empty' deployments/robinhood-crafters.json 2>/dev/null || true)}"
  is_address "${MINE:-}" || { echo "No \$MINE yet: run the launch first (or set MINE=0x...)." >&2; exit 1; }
  is_address "${CRAFTERS:-}" || { echo "No I'M DEGEN yet: deploy it first (or set CRAFTERS=0x...)." >&2; exit 1; }
  export MINE CRAFTERS TREASURY="${TREASURY:-$FEE_RECIPIENT}"
  SCRIPT=(script/Deploy.s.sol --sig "runLevels()")
  RECORD=deployments/robinhood-levels.json
  KEYS=(levels levelsImplementation)
else
  SECRET_FILE="${SECRET_FILE:-$HOME/mineworldcraft-crafters-reveal-secret.txt}"
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
  SCRIPT=(script/DeployCrafters.s.sol)
  RECORD=deployments/robinhood-crafters.json
  KEYS=(crafters art)
fi

if [ "$BROADCAST" = 1 ]; then
  echo "Stage \"$STAGE\" on Robinhood Chain with:"
  if [ "$STAGE" = launch ]; then
    grep -E '^(OWNER|FEE_RECIPIENT|TREASURY|START_MCAP_USD|SITE_PRICE|WALLET_DAILY_CAP|DAILY_CAP|SITE_UPGRADE_COSTS|CRAFTERS|CRAFTER_UPGRADE_COSTS)=' launch.env | sed 's/^/  /'
    echo "  MINING_SIGNER=$MINING_SIGNER"
    echo "  Send nothing else from the deploying wallet until this stage is done: the vault is given the address of its"
    echo "  next contract (MiningSites' proxy), a hard precondition the script checks."
  elif [ "$STAGE" = levels ]; then
    grep -E '^(OWNER|TREASURY|CRAFTER_UPGRADE_COSTS)=' launch.env | sed 's/^/  /'
    echo "  MINE=$MINE"
    echo "  CRAFTERS=$CRAFTERS"
  else
    grep -E '^(OWNER|TREASURY|CRAFTERS_[A-Z_]+)=' launch.env | sed 's/^/  /'
    echo "  SEED_COMMIT=$SEED_COMMIT"
    echo "  Sign with the OWNER wallet ($OWNER) itself: OpenSea Studio lets only the collection's owner() edit it, and"
    echo "  OWNER should be its creator too. From another wallet, OWNER must accept the collection right after (printed)."
    [ -n "${SECRET_NOTE:-}" ] && echo "  ($SECRET_NOTE; not printed)"
  fi
  read -r -p "Type DEPLOY to continue: " ok
  [ "$ok" = "DEPLOY" ] || { echo "Cancelled."; exit 1; }
  forge script "${SCRIPT[@]}" --rpc-url "$RPC" --slow "$@"
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
  echo "Next: ./script/deploy-mainnet.sh verify (Sourcify), and the owner calls printed above, if any."
else
  forge script "${SCRIPT[@]}" --fork-url "$RPC" "$@"
fi
