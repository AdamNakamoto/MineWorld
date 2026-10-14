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

/// @title MineWorldCrafters
/// @notice 3,333 MineWorld Crafters: pixel-art characters for MineWorldCraft, drawn and stored entirely on chain
///         (CrafterArt). In the game each one boosts its holder's mining by its rarity and level (the game's server
///         applies it to what it counts as earned; every payout stays within MiningSites' and the vault's limits).
///         Minted blind (free at launch), then
///         revealed: each token's hair, outfit, eyes and gaze come from a keyed shuffle of the token ids, so no two
///         Crafters share that combination, and its background, skin, hat and blush are weighted picks from its own
///         hash. The rules are the same as web/crafters.js, so the game and the chain agree on every Crafter.
///         Each one's rarity shows in its picture: Legendary with the gold background, Rare with the night background
///         or a hard hat, Common otherwise (about 6%, 25% and 69% of them), and it's listed as a trait. More traits
///         can come from an attributes extension the owner points the collection at (`setAttributesExtension`): at
///         launch CrafterLevels, which keeps each Crafter's "Level" (bought with $MINE; it stays with the token when
///         the Crafter changes hands). New stats can show on marketplaces that way without touching this contract.
///
///         The 5% royalty is enforced. Every transfer is checked by a transfer validator (OpenSea's creator fee
///         enforcement registry at launch), so marketplaces can only move Crafters in sales that pay it. Holders can
///         always move their own Crafters between wallets. The validator can be replaced (if marketplaces move to a
///         new one) but never removed, and the 5% rate is fixed.
/// @dev Trust: the owner sets the price (0 allowed), the per-wallet mint limit, the treasury (mint money and the
///      royalty), the collection's website and social links, its picture and banner and its page (contractURI), the
///      attributes extension (its traits are added to every token's metadata as it writes them), and the transfer
///      validator, which decides which transfers between wallets go through: it can't move anyone's Crafters, but a
///      bad one could hold transfers up (mints never touch it). The links, pictures and extension can be changed at
///      any time, sold out or not. The art, the rarity and the 5% royalty can't be changed. The owner
///      reveals with the committed secret and can't pick looks (see `reveal`). Ownership moves in two steps and can't
///      be renounced, so the links can always be updated. Holders' Crafters and ETH are never within the owner's reach.
contract MineWorldCrafters is ERC721, ERC2981, Ownable2Step, ICreatorToken, ICrafterMetadata {
    using Strings for uint256;

    uint256 public constant MAX_SUPPLY = CrafterRules.SUPPLY;
    uint256 public constant MAX_PER_TX = 5;
    /// @notice The highest per-wallet limit the owner can set.
    uint256 public constant MAX_WALLET_LIMIT = 50;
    uint96 public constant ROYALTY_BPS = 500;
    /// @notice The longest website, social or picture link (bytes).
    uint256 public constant MAX_LINK = 256;

    /// @dev validateTransfer(address,address,address,uint256)
    bytes4 private constant VALIDATE_TRANSFER = 0xcaee23ea;

    /// @notice Draws every Crafter (fixed for good).
    CrafterArt public immutable art;
    bytes32 public immutable seedCommit;

    /// @notice Per Crafter, in wei (0: free).
    uint256 public price;
    /// @notice How many Crafters one wallet can mint in all.
    uint256 public walletLimit = 10;
    bool public saleOpen;
    /// @notice The block the sale was last closed in; the reveal must come in a later one.
    uint256 public saleClosedAt;
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

    event Revealed(uint256 seed);
    event SaleOpen(bool open);
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
    error BadWalletLimit();
    error WrongPayment();
    error NotRevealed();
    error AlreadyRevealed();
    error SaleStillOpen();
    error RevealTooSoon();
    error BadSecret();
    error ZeroAddress();
    error NotAContract();
    /// @notice The treasury can't be this contract (it refuses ETH, so no paid mint could go through).
    error BadTreasury();
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
    ) ERC721("MineWorld Crafters", "CRAFTER") Ownable(owner_) {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(this)) revert BadTreasury();
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
    function mint(uint256 quantity) external payable {
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

    /// @notice Fix every Crafter's look, and end the sale for good. The committed secret is mixed with the previous
    ///         block's hash, and the sale must have been closed in an earlier block than this one: that hash didn't
    ///         exist yet while anyone could mint, so nobody (the owner included) could mint knowing a look. On
    ///         Robinhood Chain, an Arbitrum chain, `block.number` follows the parent chain, so "an earlier block"
    ///         means waiting for the next parent-chain block (about 12 seconds) after closing.
    function reveal(uint256 secret) external onlyOwner {
        if (seed != 0) revert AlreadyRevealed();
        if (saleOpen) revert SaleStillOpen();
        if (block.number <= saleClosedAt) revert RevealTooSoon();
        if (keccak256(abi.encode(secret)) != seedCommit) revert BadSecret();
        uint256 s = uint256(keccak256(abi.encode(secret, blockhash(block.number - 1))));
        seed = s == 0 ? 1 : s;
        emit Revealed(seed);
        if (totalMinted != 0) emit BatchMetadataUpdate(1, totalMinted);
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

    /// @notice The extra traits the attributes extension gives `tokenId`, as JSON objects separated by commas ("" with
    ///         no extension, or if it can't be read: the metadata never breaks for it).
    function extraAttributes(uint256 tokenId) public view returns (string memory extra) {
        _requireOwned(tokenId);
        address x = attributesExtension;
        if (x == address(0)) return "";
        try ICrafterAttributes(x).attributesOf(tokenId) returns (string memory a) {
            extra = a;
        } catch {}
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
                '{"name":"MineWorld Crafter #',
                tokenId.toString(),
                '","description":"A sealed MineWorld Crafter. Its look is revealed after the mint.","image":"data:image/svg+xml;base64,',
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
                '{"name":"MineWorld Crafter #',
                tokenId.toString(),
                '","description":"A pixel-art character for MineWorldCraft, drawn and stored entirely on chain. No two Crafters look alike. Each Crafter boosts its owner\'s mining in MineWorldCraft by its rarity and level: faster mining, more $MINE per block and a higher daily cap, for active play only.","image":"data:image/svg+xml;base64,',
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
            '{"name":"MineWorld Crafters","description":"3,333 pixel-art characters for MineWorldCraft, a blocky mining world on Robinhood Chain. Every Crafter is drawn and stored entirely on chain, and no two look alike. Each Crafter boosts its owner\'s mining in MineWorldCraft by its rarity and level: faster mining, more $MINE per block and a higher daily cap, for active play only.',
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
    ///         contract: enforcement can be moved, never switched off.
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

    function setSaleOpen(bool open) external onlyOwner {
        if (seed != 0) revert AlreadyRevealed();
        saleOpen = open;
        if (!open) saleClosedAt = block.number;
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

    /// @notice Moves mint payments and the royalty together. The 5% rate never changes.
    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(this)) revert BadTreasury();
        treasury = treasury_;
        _setDefaultRoyalty(treasury_, ROYALTY_BPS);
        emit TreasurySet(treasury_);
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
    ///         validator again). It can be handed over in two steps.
    function renounceOwnership() public view override onlyOwner {
        revert CannotRenounce();
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981) returns (bool) {
        return interfaceId == type(ICreatorToken).interfaceId || interfaceId == bytes4(0x49064906) // ERC-4906
            || super.supportsInterface(interfaceId);
    }
}
