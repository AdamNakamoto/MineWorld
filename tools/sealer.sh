#!/usr/bin/env bash
# I'M DIO's sealer: lock the reveal in the moment it can be, so the owner isn't the only one who decides whether a
# window gets sealed. Anyone can run it (seal() costs gas only, and the seed doesn't depend on who sends it or when
# within the window). It watches the collection (MineWorldCrafters) for SecretRevealed and EntropyBlockMoved, the two
# events that set its entropy block, and sends seal() as soon as that block is over, in the next L2 block, retrying
# until the seed is set. Start it before the reveal time the owner announced, and leave it running.
#
#   RPC_URL=https://... ./tools/sealer.sh --account <keystore name>   # a Foundry keystore (cast wallet import <name> -i)
#   RPC_URL=https://... ./tools/sealer.sh --browser                   # your browser wallet, via cast's page on :9545
#
# CRAFTERS is the collection's address (default: contracts/deployments/robinhood-crafters.json). POLL is how often it
# looks, in seconds (default 0.2; Robinhood Chain makes a block every ~0.1 s and keeps a hash for 256 of them, about
# 26 s). It never takes a private key: --private-key, --mnemonic and the like are refused. With a keystore, cast asks
# for its password when the seal is due; ETH_PASSWORD (cast's own variable) may name a file holding it instead, so the
# send doesn't wait for you. With --browser, approve the seal in your wallet as soon as it asks (the window is short).
# On a local chain, --from <address> --unlocked sends from one of the node's own accounts.
#
# Each try is simulated first (cast call), so a seal that would fail is never sent and a browser wallet is asked only
# for one that would go through. Needs Foundry's cast (and jq for the default CRAFTERS). Runs on macOS's bash 3.2.
set -uo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."

[ -n "${RPC_URL:-}" ] || { echo "Set RPC_URL to the chain's RPC (e.g. https://robinhood.drpc.org)." >&2; exit 2; }
POLL=${POLL:-0.2}
CRAFTERS=${CRAFTERS:-$(jq -r '.crafters // empty' contracts/deployments/robinhood-crafters.json 2>/dev/null)}
[ -n "$CRAFTERS" ] || { echo "Set CRAFTERS to I'M DIO's address." >&2; exit 2; }

SIGNER=()
while [ $# -gt 0 ]; do
  case "$1" in
    --account | --from | --browser-port) SIGNER+=("$1" "${2:?$1 needs a value}"); shift 2 ;;
    --browser | --browser-disable-open | --unlocked) SIGNER+=("$1"); shift ;;
    --private-key* | --mnemonic* | --interactive | -i | --keystore* | --password*)
      echo "No keys or passwords on the command line: use --account <keystore name> (ETH_PASSWORD may name a password file) or --browser." >&2
      exit 2 ;;
    *) echo "Unknown option: $1 (use --account <name> or --browser)" >&2; exit 2 ;;
  esac
done
[ ${#SIGNER[@]} -gt 0 ] || { echo "Pick a signer: --account <keystore name> or --browser." >&2; exit 2; }

say() { echo "[$(date +%H:%M:%S)] $*"; }
num() { cast call "$CRAFTERS" "$1" --rpc-url "$RPC_URL" 2>/dev/null | awk '{print $1}'; }
# The collection's errors a simulated seal() can give: name:selector pairs.
ERRS=""
for e in NoSecret RevealTooSoon EntropyExpired AlreadyRevealed EntropyUnavailable; do ERRS="$ERRS $e:$(cast sig "$e()")"; done
why() {
  local pair
  for pair in $ERRS; do
    if grep -qi -- "${pair#*:0x}" <<<"$1" || grep -q -- "${pair%%:*}" <<<"$1"; then echo "${pair%%:*}"; return; fi
  done
  echo other
}

[ "$(cast code "$CRAFTERS" --rpc-url "$RPC_URL" 2>/dev/null)" != 0x ] || { echo "No contract at $CRAFTERS." >&2; exit 2; }
say "Watching I'M DIO at $CRAFTERS ($(cast call "$CRAFTERS" 'name()(string)' --rpc-url "$RPC_URL" 2>/dev/null))."
seen="" said=""
while true; do
  if out=$(cast call "$CRAFTERS" "seal()(uint256)" --rpc-url "$RPC_URL" 2>&1); then
    e=$(num "entropyBlock()(uint256)")
    say "Entropy block $e is over: sending seal()…"
    cast send "$CRAFTERS" "seal()" --rpc-url "$RPC_URL" "${SIGNER[@]}" | awk '/^(status|transactionHash|blockNumber)/'
    seed=$(num "seed()(uint256)")
    if [ -n "$seed" ] && [ "$seed" != 0 ]; then say "Sealed: seed $seed."; exit 0; fi
    say "That seal didn't go through; looking again."
    continue
  fi
  state=$(why "$out")
  case "$state" in
    AlreadyRevealed) say "Already sealed: seed $(num 'seed()(uint256)')."; exit 0 ;;
    NoSecret) [ "$said" = NoSecret ] || say "Waiting for the owner's reveal (SecretRevealed)…" ;;
    RevealTooSoon | EntropyExpired)
      e=$(num "entropyBlock()(uint256)")
      if [ -n "$e" ] && [ "$e" != "$seen" ]; then
        moves=$(num "entropyMoves()(uint256)")
        if [ -z "$seen" ] || [ "${moves:-0}" = 0 ]; then say "SecretRevealed: the seed waits for chain block $e."
        else say "EntropyBlockMoved: the seed now waits for chain block $e (the owner's move $moves of 3)."; fi
        seen=$e
      fi
      if [ "$state" = EntropyExpired ] && [ "$said" != EntropyExpired ]; then
        if [ "$(num 'revealStatus()(uint8)')" = 5 ]; then say "Stuck: the window passed unsealed after three moves, so the reveal can't happen."; exit 1; fi
        say "This window passed unsealed (block $e): only the owner can move it on now. Waiting for EntropyBlockMoved…"
      fi ;;
    *) [ "$said" = "$state" ] || say "Couldn't seal or read the collection yet ($(tail -n 1 <<<"$out")); trying again." ;;
  esac
  said=$state
  sleep "$POLL"
done
