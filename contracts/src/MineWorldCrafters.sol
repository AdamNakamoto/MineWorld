// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {CrafterArt, CrafterRules, Traits} from "./CrafterArt.sol";
import {FastBase64} from "./lib/FastBase64.sol";
import {ICrafterAttributes, ICrafterMetadata} from "./ICrafterAttributes.sol";

/// @notice The creator token standard (ERC721-C) that marketplaces read to find a collection's transfer rules.
interface ICreatorToken {
    event TransferValidatorUpdated(address oldValidator, address newValidator);

    function getTransferValidator() external view returns (address validator);
    function getTransferValidationFunction() external view returns (bytes4 functionSignature, bool isViewFunction);
    function setTransferValidator(address validator) external;
}

/// @notice Checks every transfer; reverts the ones the collection doesn't allow.
interface ITransferValidator721 {
    function validateTransfer(address caller, address from, address to, uint256 tokenId) external view;
}

/// @notice Arbitrum's system contract, at 0x64 on every Arbitrum chain (Robinhood Chain included): the chain's own (L2)
///         block numbers and hashes, which `block.number` and `blockhash` don't give there (they follow the parent
///         chain).
interface IArbSys {
    function arbBlockNumber() external view returns (uint256);
    /// @dev Reverts for a block that isn't one of the last 256 before the current one.
    function arbBlockHash(uint256 arbBlockNum) external view returns (bytes32);
}

/// @title MineWorldCrafters: the I'M DEGEN collection
/// @notice I'M DEGEN (symbol DEGEN): 3,333 pixel-art characters for MineWorldCraft, drawn and stored entirely on chain
///         (CrafterArt). The collection was first named MineWorld Crafters; this contract and its code keep that name,
///         and a "Crafter" in the notes below is one DEGEN. In the game each one boosts its holder's mining by its
///         rarity and level (the game's server applies it to what it counts as earned; every payout stays within
///         MiningSites' and the vault's limits). Minted blind (free at launch), then revealed: each token's hair,
///         outfit, eyes and gaze come from a keyed shuffle of the token ids, so no two Crafters share that combination,
///         and its background, skin, hat and blush are weighted picks from its own hash. The rules are the same as web/crafters.js, so the game and the chain agree on every Crafter.
///         Each one's rarity shows in its picture: Legendary with the gold background, Rare with the night background
///         or a hard hat, Common otherwise (about 6%, 25% and 69% of them), and it's listed as a trait. More traits
///         can come from an attributes extension the owner points the collection at (`setAttributesExtension`): at
///         launch CrafterLevels, which keeps each Crafter's "Level" (bought with $MINE; it stays with the token when
///         the Crafter changes hands). New stats can show on marketplaces that way without touching this contract.
///
///         The 5% royalty is enforced. Every transfer is checked by a transfer validator (OpenSea's creator fee
///         enforcement registry at launch), so marketplaces can only move Crafters in sales that pay it. Holders can
///         always move their own Crafters between wallets. The validator can be replaced (if marketplaces move to a
///         new one) but never set to nothing, and the 5% rate is fixed. Enforcement is only as strict as that
///         validator, though, and the owner chooses it: see `setTransferValidator`.
/// @dev Trust: the owner sets the price (0 allowed), the per-wallet mint limit, the treasury (mint money and the
///      royalty), the collection's website and social links, its picture and banner and its page (contractURI), the
///      attributes extension (its traits are added to every token's metadata as it writes them), and the transfer
///      validator, which decides which transfers between wallets go through: it can't move anyone's Crafters, but a
///      bad one could hold transfers up (mints never touch it), and a lax one, or a looser policy for this collection
///      on OpenSea's registry, relaxes the royalty's enforcement. The links, pictures and extension can be changed at
///      any time, sold out or not. The art, the rarity and the 5% royalty rate can't be changed. The owner publishes
///      the committed secret before the block whose hash completes the seed exists, and anyone then seals it, so the
///      owner can't pick looks nor know them before everyone else (see `reveal` and `seal`). Its one lever: if a whole
///      window passes with nobody sealing, it alone can re-roll, at most three times, each in public
///      (`moveEntropyOn`). As it alone knows when it will reveal, in practice it decides whether a window is sealed
///      unless holders run a sealer (tools/sealer.sh) at the reveal time it announces: at most a best of four public
///      seeds. The mint is for wallets only (`mint`), within a per-address limit.
///      Ownership moves in two steps and can't be renounced, so the links can always be updated. Holders' Crafters
///      and ETH are never within the owner's reach.
contract MineWorldCrafters is ERC721, ERC2981, Ownable2Step, ICreatorToken, ICrafterMetadata {
    using Strings for uint256;

    uint256 public constant MAX_SUPPLY = CrafterRules.SUPPLY;
    uint256 public constant MAX_PER_TX = 5;
    /// @notice The highest per-wallet limit the owner can set.
    uint256 public constant MAX_WALLET_LIMIT = 50;
    uint96 public constant ROYALTY_BPS = 500;
    /// @notice The longest website, social or picture link (bytes).
    uint256 public constant MAX_LINK = 256;
    /// @notice The gas the attributes extension gets for each token's traits (plenty for CrafterLevels' few
    ///         thousand), whatever gas tokenURI was given: a gas-hungry extension can't starve the picture.
    uint256 public constant EXTENSION_GAS = 300_000;
    /// @notice The longest traits the extension can add (bytes); longer ones are left out.
    uint256 public constant MAX_EXTRA_ATTRIBUTES = 4_096;
    /// @notice ArbSys, Arbitrum's system contract. Where it has no code (a local chain), plain `block.number` and
    ///         `blockhash` stand in for its block numbers and hashes.
    address public constant ARB_SYS = address(100);
    /// @notice How many blocks back the chain gives a block's hash (ArbSys and `blockhash` alike): the time anyone has
    ///         to `seal` once the entropy block is over.
    uint256 public constant ENTROPY_WINDOW = 256;
    /// @notice How many times, in all, the owner can move the entropy block on after a window nobody sealed in.
    uint256 public constant MAX_ENTROPY_MOVES = 3;
    /// @notice How many of the window's last blocks `revealStatus` already reads as `Expired`, though `seal` still
    ///         works in them: about 3 seconds of Robinhood Chain's ~0.1 s blocks, so a seal sent on seeing `Sealable`
    ///         reaches the sequencer and lands in time.
    uint256 public constant SEAL_MARGIN = 30;

    /// @dev validateTransfer(address,address,address,uint256)
    bytes4 private constant VALIDATE_TRANSFER = 0xcaee23ea;

    /// @notice Where the reveal stands: `None` (the secret isn't public yet), `Waiting` (it is; the entropy block
    ///         isn't over), `Sealable` (anyone can `seal` now, with SEAL_MARGIN blocks to spare, and everyone can
    ///         already work the seed out), `Expired` (the window is over or about to be: `seal` still works in its last
    ///         SEAL_MARGIN blocks, then only the owner can move the entropy block on, `moveEntropyOn`), `Revealed` (the
    ///         seed is set), `Stuck` (expired with no move left: the Crafters stay sealed for good).
    enum RevealStatus {
        None,
        Waiting,
        Sealable,
        Expired,
        Revealed,
        Stuck
    }

    /// @notice Draws every Crafter (fixed for good).
    CrafterArt public immutable art;
    bytes32 public immutable seedCommit;

    /// @notice Per Crafter, in wei (0: free).
    uint256 public price;
    /// @notice How many Crafters one wallet can mint in all: 3 at launch (the owner can change it, 1 to
    ///         MAX_WALLET_LIMIT).
    uint256 public walletLimit = 3;
    bool public saleOpen;
    /// @notice The secret committed at deploy (`seedCommit`), public from `reveal` on.
    uint256 public revealedSecret;
    /// @notice The chain block whose hash `seal` mixes with the secret: the one after `reveal`'s (an Arbitrum L2 block
    ///         number on Robinhood Chain), moved on by the owner (`moveEntropyOn`) if nobody sealed in time. 0 until
    ///         `reveal`.
    uint256 public entropyBlock;
    /// @notice How many times the owner has moved the entropy block on (at most MAX_ENTROPY_MOVES).
    uint256 public entropyMoves;
    uint256 public totalMinted;
    /// @notice How many Crafters each wallet has minted (transfers don't change it).
    mapping(address => uint256) public mintedBy;
    address public treasury;

    uint256 public seed; // 0 until revealed

    address public transferValidator;
    /// @notice The project's website, shown as the collection's link on marketplaces ("" until set).
    string public website;
    /// @notice A social link (X, Discord...), shown in the collection's description ("" until set).
    string public social;
    /// @notice The collection's picture and banner on marketplaces (URLs: OpenSea doesn't take data: URIs for these).
    string public collectionImage;
    string public bannerImage;
    /// @dev Replaces the built-in collection metadata when set (see contractURI).
    string private customContractURI;
    /// @notice Adds traits to every Crafter's metadata (CrafterLevels at launch, for "Level"); none: no extra traits.
    address public attributesExtension;

    /// @notice The seed is set (by `seal`): every Crafter's look is fixed and public.
    event Revealed(uint256 seed);
    event SaleOpen(bool open);
    /// @notice The owner published the secret; the hash of chain block `entropyBlock` (not yet made) completes the seed.
    event SecretRevealed(uint256 secret, uint256 entropyBlock);
    /// @notice Nobody sealed in time, so the owner moved the seed on to chain block `entropyBlock` (its `moves`-th move,
    ///         of MAX_ENTROPY_MOVES).
    event EntropyBlockMoved(uint256 entropyBlock, uint256 moves);
    event PriceSet(uint256 price);
    event WalletLimitSet(uint256 limit);
    event TreasurySet(address indexed treasury);
    event LinksSet(string website, string social);
    event CollectionImagesSet(string image, string banner);
    /// @notice ERC-7572: marketplaces re-read contractURI when they see this.
    event ContractURIUpdated();
    /// @notice ERC-4906: marketplaces re-read this token's metadata.
    event MetadataUpdate(uint256 _tokenId);
    /// @notice ERC-4906: marketplaces re-read these tokens' metadata.
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);
    event AttributesExtensionSet(address indexed extension);

    error SaleClosed();
    error BadQuantity();
    error SoldOut();
    /// @notice This wallet would go over the per-wallet limit.
    error WalletLimit();
    /// @notice Only a wallet minting for itself can mint (msg.sender == tx.origin): not a contract.
    error OnlyWallets();
    error BadWalletLimit();
    error WrongPayment();
    error NotRevealed();
    error AlreadyRevealed();
    error SaleStillOpen();
    /// @notice The entropy block isn't over yet: seal from the next block on.
    error RevealTooSoon();
    /// @notice The owner hasn't published the secret yet (`reveal`), so there's nothing to seal.
    error NoSecret();
    /// @notice Nobody sealed within the window, so the entropy block's hash can't be read any more: only the owner can
    ///         move it on (`moveEntropyOn`).
    error EntropyExpired();
    /// @notice The entropy block's window isn't over: seal instead (anyone can).
    error NotExpired();
    /// @notice The owner has moved the entropy block on MAX_ENTROPY_MOVES times already.
    error NoMovesLeft();
    /// @notice The chain didn't give the entropy block's hash (never expected within the window: nothing is changed).
    error EntropyUnavailable();
    error BadSecret();
    error ZeroAddress();
    error NotAContract();
    /// @notice The treasury can't be this contract (it refuses ETH, so no paid mint could go through).
    error BadTreasury();
    /// @notice The treasury refused a plain call with no ETH (a contract with no receive or fallback, say), so it
    ///         would refuse mint money too and every paid mint would fail.
    error TreasuryRefusesEth();
    /// @notice A link is too long, or has a character that would break the collection's JSON (", \ or a control).
    error BadLink();
    /// @notice Ownership can only be handed over (two-step), never renounced: the links must stay updatable.
    error CannotRenounce();
    /// @notice Only the attributes extension or the owner can ask marketplaces to re-read metadata.
    error NotAllowed();

    constructor(
        address owner_,
        address treasury_,
        uint256 price_,
        bytes32 seedCommit_,
        address validator_,
        CrafterArt art_
    ) ERC721("I'M DEGEN", "DEGEN") Ownable(owner_) {
        _checkTreasury(treasury_);
        if (address(art_).code.length == 0) revert NotAContract();
        treasury = treasury_;
        price = price_;
        seedCommit = seedCommit_;
        art = art_;
        _setDefaultRoyalty(treasury_, ROYALTY_BPS);
        _setValidator(validator_);
    }

    // ---------------------------------------------------------------- mint

    /// @notice Mint `quantity` sealed Crafters (1 to MAX_PER_TX), paying exactly `price` each (nothing while free).
    ///         Wallets only: the caller must be the transaction's sender (msg.sender == tx.origin, else `OnlyWallets`),
    ///         so no contract mints, and one transaction can't sweep the free mint through throwaway contracts, each a
    ///         fresh address under the per-wallet limit. A determined bot then needs a funded wallet and a transaction
    ///         for every `walletLimit` Crafters (accepted). An account delegated with EIP-7702 still mints as itself,
    ///         within the same limit per address. Smart-contract wallets (a Safe, say) can't mint; they can buy.
    function mint(uint256 quantity) external payable {
        if (msg.sender != tx.origin) revert OnlyWallets();
        if (!saleOpen) revert SaleClosed();
        if (quantity == 0 || quantity > MAX_PER_TX) revert BadQuantity();
        uint256 minted = totalMinted;
        if (minted + quantity > MAX_SUPPLY) revert SoldOut();
        uint256 mine = mintedBy[msg.sender] + quantity;
        if (mine > walletLimit) revert WalletLimit();
        if (msg.value != price * quantity) revert WrongPayment();
        mintedBy[msg.sender] = mine;
        totalMinted = minted + quantity;
        for (uint256 i = 1; i <= quantity; ++i) {
            _mint(msg.sender, minted + i);
        }
        // Paid straight to the treasury, with anything ever forced in here: this contract never holds ETH.
        uint256 balance = address(this).balance;
        if (balance != 0) Address.sendValue(payable(treasury), balance);
    }

    // ---------------------------------------------------------------- reveal

    /// @notice Publish the committed secret, and end the sale for good. The sale must be closed and the secret must
    ///         match `seedCommit`. It becomes public (`revealedSecret`), and the seed waits for the hash of the chain's
    ///         next block (`entropyBlock`): `seal`, which anyone can call once that block is over, sets
    ///         seed = keccak256(abi.encode(secret, that block's hash)).
    ///
    ///         So nobody can know a look before everyone can: while anyone could mint, the secret wasn't public and the
    ///         entropy block didn't exist; when the owner publishes the secret, the entropy block doesn't exist yet
    ///         (choosing when to reveal picks nothing the owner can see); once it does, its hash and the secret are
    ///         public, so everyone can work the seed out at the same moment, and anyone can seal it. The owner's only
    ///         step after this is moving the entropy block on if nobody sealed in time (see `moveEntropyOn`).
    ///
    ///         On Robinhood Chain (an Arbitrum Orbit chain) the blocks are the chain's own L2 blocks, read from ArbSys
    ///         (0x64): numbered one after another, each hash its own block's. `block.number` and `blockhash` aren't
    ///         used there: they follow the parent chain, and when its number skips, `blockhash` returns a value 256
    ///         parent blocks old. The trust left: the sequencer produces the L2 blocks, so it could in principle steer
    ///         the entropy block's hash. On a chain without ArbSys (a local one), `block.number` and `blockhash` stand
    ///         in.
    function reveal(uint256 secret) external onlyOwner {
        if (entropyBlock != 0) revert AlreadyRevealed();
        if (saleOpen) revert SaleStillOpen();
        if (keccak256(abi.encode(secret)) != seedCommit) revert BadSecret();
        revealedSecret = secret;
        uint256 b = _chainBlock() + 1;
        entropyBlock = b;
        emit SecretRevealed(secret, b);
    }

    /// @notice Set the seed, once the entropy block is over: seed = keccak256(abi.encode(revealedSecret, its hash)),
    ///         never 0; every Crafter's look is then fixed and public. Anyone can call it, and should, at once: the
    ///         chain gives a block's hash for ENTROPY_WINDOW (256) blocks only, about 26 seconds of Robinhood Chain's
    ///         ~0.1 s L2 blocks. The game's panel sends it right after the owner's `reveal`, retrying until it lands;
    ///         any seal within the window fixes the seed for good. Later than that it reverts `EntropyExpired`: only
    ///         the owner can move the entropy block on (`moveEntropyOn`).
    ///
    ///         Expiry is decided from block numbers alone, never from a failing call: a call to ArbSys that fails (a
    ///         caller could make one run out of gas) reverts the whole seal.
    /// @return The seed.
    function seal() external returns (uint256) {
        if (seed != 0) revert AlreadyRevealed();
        uint256 b = entropyBlock;
        if (b == 0) revert NoSecret();
        uint256 current = _chainBlock();
        if (current <= b) revert RevealTooSoon();
        if (current - b > ENTROPY_WINDOW) revert EntropyExpired();
        uint256 s = uint256(keccak256(abi.encode(revealedSecret, _chainBlockHash(b))));
        seed = s == 0 ? 1 : s;
        emit Revealed(seed);
        if (totalMinted != 0) emit BatchMetadataUpdate(1, totalMinted);
        return seed;
    }

    /// @notice After a window nobody sealed in, move the seed on to the chain's next block (then seal it at once).
    ///         The owner only, and at most MAX_ENTROPY_MOVES (3) times in all, each in public (`EntropyBlockMoved`).
    ///
    ///         The trust this leaves, plainly: once a window passes unsealed, both inputs of that seed were public, so
    ///         a re-roll is a choice. Only the owner has it, only after a window in which nobody (no player, no bot,
    ///         not the panel) sealed, and at most three times; anyone who seals within a window ends it. After the
    ///         third move, an entropy block left unsealed for its whole window leaves the Crafters sealed for good, as
    ///         a lost secret would: any fallback that needed no fresh block hash could be worked out in advance (from
    ///         the secret, chosen at deploy, or a block the owner picks by timing), so the owner could steer it; a dead
    ///         end gives it nothing it couldn't do by never revealing. The owner chooses when each move happens, so it
    ///         can always be ready to seal straight after.
    /// @return next The new entropy block.
    function moveEntropyOn() external onlyOwner returns (uint256 next) {
        if (seed != 0) revert AlreadyRevealed();
        uint256 b = entropyBlock;
        if (b == 0) revert NoSecret();
        uint256 current = _chainBlock();
        if (current <= b || current - b <= ENTROPY_WINDOW) revert NotExpired();
        uint256 moves = entropyMoves + 1;
        if (moves > MAX_ENTROPY_MOVES) revert NoMovesLeft();
        entropyMoves = moves;
        next = current + 1;
        entropyBlock = next;
        emit EntropyBlockMoved(next, moves);
    }

    /// @notice Where the reveal stands (see `RevealStatus`): what a bot or the game's panel checks before sealing.
    ///         Sealable only while a seal sent now can still land in the window: up to SEAL_MARGIN (30) blocks before
    ///         its end, about 3 seconds, longer than a transaction takes to be sequenced. `seal` itself still accepts
    ///         the whole window. (A client can't compare block numbers itself: on Robinhood Chain the entropy block is
    ///         an L2 block; `chainBlock()` and `entropyBlock` give both for a bot that wants to.)
    function revealStatus() public view returns (RevealStatus) {
        if (seed != 0) return RevealStatus.Revealed;
        uint256 b = entropyBlock;
        if (b == 0) return RevealStatus.None;
        uint256 current = _chainBlock();
        if (current <= b) return RevealStatus.Waiting;
        if (current - b < ENTROPY_WINDOW - SEAL_MARGIN) return RevealStatus.Sealable;
        if (entropyMoves >= MAX_ENTROPY_MOVES && current - b > ENTROPY_WINDOW) return RevealStatus.Stuck;
        return RevealStatus.Expired;
    }

    /// @notice The chain block the reveal counts in: ArbSys's L2 block number, or `block.number` without ArbSys.
    function chainBlock() external view returns (uint256) {
        return _chainBlock();
    }

    /// @dev The current chain block (see `reveal`). A failing ArbSys call reverts: there is no fallback but a missing
    ///      ArbSys.
    function _chainBlock() private view returns (uint256) {
        return ARB_SYS.code.length == 0 ? block.number : IArbSys(ARB_SYS).arbBlockNumber();
    }

    /// @dev Chain block `b`'s hash, `b` within the window (checked by the caller); reverts rather than return 0.
    function _chainBlockHash(uint256 b) private view returns (bytes32 h) {
        h = ARB_SYS.code.length == 0 ? blockhash(b) : IArbSys(ARB_SYS).arbBlockHash(b);
        if (h == 0) revert EntropyUnavailable();
    }

    /// @notice A Crafter's traits once revealed: indexes into the tables of web/crafters-art.js (names from
    ///         CrafterArt.traitName), the same as traitsOf(seed, id) in web/crafters.js.
    function traitsOf(uint256 tokenId) external view returns (Traits memory) {
        if (seed == 0) revert NotRevealed();
        _requireOwned(tokenId);
        return _traitsFor(seed, tokenId);
    }

    /// @notice A Crafter's rarity once revealed: 0 Common, 1 Rare, 2 Legendary (rarityOf in web/crafters.js; names
    ///         from CrafterArt.traitName(8, rarity)).
    function rarityOf(uint256 tokenId) external view returns (uint8) {
        if (seed == 0) revert NotRevealed();
        _requireOwned(tokenId);
        Traits memory t = _traitsFor(seed, tokenId);
        return CrafterRules.rarity(t.background, t.hat);
    }

    /// @notice The extra traits the attributes extension gives `tokenId`, as JSON objects separated by commas. "" with
    ///         no extension, or if its answer can't be used: the call reverts or runs out of its EXTENSION_GAS, or
    ///         returns anything but one well-formed ABI string of at most MAX_EXTRA_ATTRIBUTES bytes. So whatever the
    ///         extension does, the metadata never breaks for it: at worst it shows no extra traits.
    function extraAttributes(uint256 tokenId) public view returns (string memory extra) {
        _requireOwned(tokenId);
        address x = attributesExtension;
        if (x == address(0)) return "";
        bytes4 selector = ICrafterAttributes.attributesOf.selector;
        uint256 gasStipend = EXTENSION_GAS;
        uint256 maxLength = MAX_EXTRA_ATTRIBUTES;
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, selector)
            mstore(add(m, 0x04), tokenId)
            // A fixed stipend, and nothing copied back yet: only the parts read below are.
            let ok := staticcall(gasStipend, x, m, 0x24, 0, 0)
            let size := returndatasize()
            // abi.encode(string): the offset 0x20, the length, then the bytes. Anything else is left out.
            if and(ok, iszero(lt(size, 0x40))) {
                returndatacopy(m, 0, 0x40)
                let offset := mload(m)
                let length := mload(add(m, 0x20))
                if and(eq(offset, 0x20), and(iszero(gt(length, maxLength)), iszero(gt(add(0x40, length), size)))) {
                    // The string at m: its length, then its bytes (the last word zeroed first, so no stray bytes
                    // follow them), and the free memory pointer past it.
                    mstore(m, length)
                    mstore(add(add(m, 0x20), and(length, not(31))), 0)
                    returndatacopy(add(m, 0x20), 0x40, length)
                    mstore(0x40, add(add(m, 0x20), and(add(length, 31), not(31))))
                    extra := m
                }
            }
        }
    }

    /// @dev traitsOf in web/crafters.js. The token's place in the shuffled run gives a combination of hair, outfit,
    ///      eyes and gaze (spread over all COMBOS, a different one for every token); its own hash gives the weighted
    ///      picks.
    function _traitsFor(uint256 s, uint256 id) internal pure returns (Traits memory t) {
        uint256 c = _shuffle(s, id - 1) * CrafterRules.COMBOS / MAX_SUPPLY;
        uint256 h;
        assembly ("memory-safe") {
            mstore(0x00, s)
            mstore(0x20, id)
            h := keccak256(0x00, 0x40) // keccak256(abi.encode(s, id))
        }
        uint256 hairs = CrafterRules.HAIRS;
        uint256 outfits = CrafterRules.OUTFITS;
        uint256 eyes = CrafterRules.EYES;
        t.hair = uint8(c % hairs);
        t.outfit = uint8((c / hairs) % outfits);
        t.eyes = uint8((c / (hairs * outfits)) % eyes);
        t.gaze = uint8(c / (hairs * outfits * eyes));
        t.background = CrafterRules.background(h & 0xffff);
        t.skin = CrafterRules.skin((h >> 16) & 0xffff);
        t.hat = CrafterRules.hat((h >> 32) & 0xffff);
        t.blush = CrafterRules.blush((h >> 48) & 0xffff);
    }

    /// @dev A keyed shuffle of 0..MAX_SUPPLY-1: a 4-round Feistel network on 12 bits (a permutation of 0..4095),
    ///      repeated until it lands inside the supply. Different inputs always give different outputs. The round
    ///      function is uint256(keccak256(abi.encode(s, i, r))) & 63.
    function _shuffle(uint256 s, uint256 x) internal pure returns (uint256) {
        do {
            uint256 l = x >> 6;
            uint256 r = x & 63;
            for (uint256 i = 0; i < 4; i++) {
                uint256 f;
                assembly ("memory-safe") {
                    let m := mload(0x40) // scratch past the free memory pointer, never allocated
                    mstore(m, s)
                    mstore(add(m, 0x20), i)
                    mstore(add(m, 0x40), r)
                    f := and(keccak256(m, 0x60), 63)
                }
                (l, r) = (r, l ^ f);
            }
            x = (l << 6) | r;
        } while (x >= MAX_SUPPLY);
        return x;
    }

    // ---------------------------------------------------------------- metadata

    /// @notice Metadata and picture, all on chain: the SVG drawn by CrafterArt, the traits (rarity included) as
    ///         attributes, then the attributes extension's (the level, at launch).
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        bytes memory extra = bytes(extraAttributes(tokenId));
        bytes memory end = extra.length == 0 ? bytes("]") : abi.encodePacked(",", extra, "]");
        bytes memory json;
        if (seed == 0) {
            json = abi.encodePacked(
                '{"name":"I\'M DEGEN #',
                tokenId.toString(),
                '","description":"A sealed I\'M DEGEN. Its look is revealed after the mint.","image":"data:image/svg+xml;base64,',
                FastBase64.encode(bytes(art.sealedSvg())),
                '","attributes":[{"trait_type":"Status","value":"Sealed"}',
                end,
                "}"
            );
        } else {
            Traits memory t = _traitsFor(seed, tokenId);
            bytes memory attributes = bytes(art.attributes(t));
            // Its closing "]" makes way for the extension's traits.
            assembly ("memory-safe") {
                mstore(attributes, sub(mload(attributes), 1))
            }
            json = abi.encodePacked(
                '{"name":"I\'M DEGEN #',
                tokenId.toString(),
                '","description":"A pixel-art character for MineWorldCraft, drawn and stored entirely on chain. No two DEGENs look alike. Each DEGEN boosts its owner\'s mining in MineWorldCraft by its rarity and level: faster mining, more $MINE per block and a higher daily cap, for active play only.","image":"data:image/svg+xml;base64,',
                FastBase64.encode(bytes(art.render(t))),
                '","attributes":',
                attributes,
                end,
                "}"
            );
        }
        return string.concat("data:application/json;base64,", FastBase64.encode(json));
    }

    /// @notice The collection's page on marketplaces (ERC-7572): its name and description, and its picture, banner,
    ///         website and social links once the owner has set them (`setCollectionImages`, `setLinks`).
    function contractURI() external view returns (string memory) {
        if (bytes(customContractURI).length != 0) return customContractURI;
        string memory links;
        if (bytes(website).length != 0) links = string.concat(" Website: ", website);
        if (bytes(social).length != 0) links = string.concat(links, " Social: ", social);
        string memory json = string.concat(
            '{"name":"I\'M DEGEN","description":"3,333 pixel-art characters for MineWorldCraft, a blocky mining world on Robinhood Chain. Every DEGEN is drawn and stored entirely on chain, and no two look alike. Each DEGEN boosts its owner\'s mining in MineWorldCraft by its rarity and level: faster mining, more $MINE per block and a higher daily cap, for active play only.',
            links,
            '"'
        );
        if (bytes(collectionImage).length != 0) {
            json = string.concat(json, ',"image":"', collectionImage, '","featured_image":"', collectionImage, '"');
        }
        if (bytes(bannerImage).length != 0) json = string.concat(json, ',"banner_image":"', bannerImage, '"');
        if (bytes(website).length != 0) json = string.concat(json, ',"external_link":"', website, '"');
        json = string.concat(json, "}");
        return string.concat("data:application/json;base64,", FastBase64.encode(bytes(json)));
    }

    /// @notice Every Crafter `owner` holds, so the game can list them without scanning event logs.
    function tokensOfOwner(address owner) external view returns (uint256[] memory ids) {
        uint256 n = balanceOf(owner);
        ids = new uint256[](n);
        uint256 found;
        for (uint256 id = 1; id <= totalMinted && found < n; id++) {
            if (_ownerOf(id) == owner) ids[found++] = id;
        }
    }

    // ---------------------------------------------------------------- royalty enforcement

    function getTransferValidator() external view returns (address) {
        return transferValidator;
    }

    function getTransferValidationFunction() external pure returns (bytes4 functionSignature, bool isViewFunction) {
        return (VALIDATE_TRANSFER, true);
    }

    /// @notice Point the collection at a new validator, e.g. if marketplaces move to a new registry. It must be a
    ///         contract, so the collection always names one; but the owner can relax enforcement, plainly: a validator
    ///         whose `validateTransfer` allows everything lets marketplaces skip the royalty, and on OpenSea's
    ///         registry (the launch validator) the collection's owner can also change the collection's own policy
    ///         (its list of authorizers, its security level). Any change shows on chain (`TransferValidatorUpdated`
    ///         here; the registry's own events there). The 5% rate itself never changes. (No ERC-165 check: OpenSea's
    ///         registry and Limit Break's validators, both on Robinhood Chain, share no interface id to require.)
    function setTransferValidator(address validator) external onlyOwner {
        _setValidator(validator);
    }

    function _setValidator(address validator) private {
        if (validator.code.length == 0) revert NotAContract();
        emit TransferValidatorUpdated(transferValidator, validator);
        transferValidator = validator;
    }

    /// @dev Mints skip the check; every transfer between wallets goes through the validator.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            ITransferValidator721(transferValidator).validateTransfer(msg.sender, from, to, tokenId);
        }
        return super._update(to, tokenId, auth);
    }

    // ---------------------------------------------------------------- admin

    /// @notice Open or close the mint (a pause until the reveal). Never again once the secret is public (`reveal`).
    function setSaleOpen(bool open) external onlyOwner {
        if (entropyBlock != 0) revert AlreadyRevealed();
        saleOpen = open;
        emit SaleOpen(open);
    }

    /// @notice The price of one Crafter in wei; 0 makes the mint free.
    function setPrice(uint256 price_) external onlyOwner {
        price = price_;
        emit PriceSet(price_);
    }

    /// @notice How many Crafters one wallet can mint in all (1 to MAX_WALLET_LIMIT). Lowering it never takes
    ///         anything back; wallets already over it just can't mint more.
    function setWalletLimit(uint256 limit) external onlyOwner {
        if (limit == 0 || limit > MAX_WALLET_LIMIT) revert BadWalletLimit();
        walletLimit = limit;
        emit WalletLimitSet(limit);
    }

    /// @notice Moves mint payments and the royalty together. The 5% rate never changes. The new treasury must take
    ///         ETH: it is sent a plain call with no ETH first, and refused if that fails.
    function setTreasury(address treasury_) external onlyOwner {
        _checkTreasury(treasury_);
        treasury = treasury_;
        _setDefaultRoyalty(treasury_, ROYALTY_BPS);
        emit TreasurySet(treasury_);
    }

    /// @dev Never 0, never this contract, and it must accept a plain call with no ETH (a wallet, or a contract with a
    ///      receive or fallback function): `mint` sends it ETH in the same call, so one that refused would stop every
    ///      paid mint. (A contract whose fallback takes calls but not ETH would still pass; the owner is trusted not to
    ///      choose one.)
    function _checkTreasury(address treasury_) private {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(this)) revert BadTreasury();
        bool ok;
        assembly ("memory-safe") {
            ok := call(gas(), treasury_, 0, 0, 0, 0, 0)
        }
        if (!ok) revert TreasuryRefusesEth();
    }

    /// @notice The project's website (the collection's link on marketplaces) and a social link (in its description),
    ///         at any time; "" leaves one out. Both are written into the built-in collection metadata, so they must
    ///         be plain URLs: no quotes, backslashes or control characters, at most MAX_LINK bytes.
    function setLinks(string calldata website_, string calldata social_) external onlyOwner {
        _checkLink(website_);
        _checkLink(social_);
        website = website_;
        social = social_;
        emit LinksSet(website_, social_);
        emit ContractURIUpdated();
    }

    /// @notice The collection's picture and banner on marketplaces (https:// or ipfs:// URLs; OpenSea doesn't take
    ///         data: URIs for these), at any time; "" leaves one out. Same rules as the links.
    function setCollectionImages(string calldata image, string calldata banner) external onlyOwner {
        _checkLink(image);
        _checkLink(banner);
        collectionImage = image;
        bannerImage = banner;
        emit CollectionImagesSet(image, banner);
        emit ContractURIUpdated();
    }

    function _checkLink(string calldata link) private pure {
        bytes calldata b = bytes(link);
        if (b.length > MAX_LINK) revert BadLink();
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (c < 0x20 || c == 0x7f || c == '"' || c == "\\") revert BadLink();
        }
    }

    /// @notice Where extra traits come from: a contract with `attributesOf(tokenId)` (ICrafterAttributes;
    ///         CrafterLevels at launch), or none. Its JSON goes into every token's metadata as it is, so only point
    ///         this at a contract you trust. Marketplaces are told to re-read every Crafter (ERC-4906).
    function setAttributesExtension(address extension) external onlyOwner {
        if (extension != address(0) && extension.code.length == 0) revert NotAContract();
        attributesExtension = extension;
        emit AttributesExtensionSet(extension);
        if (totalMinted != 0) emit BatchMetadataUpdate(1, totalMinted);
    }

    /// @notice Ask marketplaces to re-read Crafters `fromTokenId` to `toTokenId` (ERC-4906), when the attributes
    ///         extension's traits for them changed (a level bought, say). The extension or the owner only.
    function refreshMetadata(uint256 fromTokenId, uint256 toTokenId) external {
        if (msg.sender != attributesExtension && msg.sender != owner()) revert NotAllowed();
        if (toTokenId > totalMinted) toTokenId = totalMinted;
        if (fromTokenId == 0) fromTokenId = 1;
        if (fromTokenId > toTokenId) return;
        if (fromTokenId == toTokenId) emit MetadataUpdate(fromTokenId);
        else emit BatchMetadataUpdate(fromTokenId, toTokenId);
    }

    /// @notice Point the collection's metadata somewhere else (a JSON URL), or back to the built-in one ("").
    function setContractURI(string calldata uri) external onlyOwner {
        customContractURI = uri;
        emit ContractURIUpdated();
    }

    /// @notice Ownership can't be renounced (a renounced owner could never update the links, the price or the
    ///         validator again, nor edit the collection in OpenSea Studio, which lets only owner() do that). It can be
    ///         handed over in two steps: only ever to a wallet that can sign in to OpenSea Studio.
    function renounceOwnership() public view override onlyOwner {
        revert CannotRenounce();
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981) returns (bool) {
        return interfaceId == type(ICreatorToken).interfaceId || interfaceId == bytes4(0x49064906) // ERC-4906
            || super.supportsInterface(interfaceId);
    }
}
