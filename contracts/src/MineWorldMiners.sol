// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

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

/// @title MineWorldMiners
/// @notice 999 MineWorldCraft Miners: outfits for your miner in MineWorldCraft (a copy of Courier World's audited
///         Courier Skins). Cosmetic only; they never change what anyone earns. Minted blind for ETH, then revealed:
///         the design of each miner comes from a shuffle of the full 999-card deck, keyed by a seed committed before
///         the mint and revealed after it.
///
///         The 5% royalty is enforced. Every transfer is checked by a transfer validator (OpenSea's creator fee
///         enforcement registry at launch), so marketplaces can only move miners in sales that pay it. Holders can
///         always move their own miners between wallets. The validator can be replaced (if marketplaces move to a
///         new one) but never removed, and the 5% rate is fixed.
/// @dev Trust: the owner sets the price (never 0), the treasury (mint money and the royalty), the pictures' address
///      (until frozen), the collection's website and social links and its page (contractURI), and the transfer
///      validator, which decides which transfers between wallets go through: it can't move anyone's miners, but a bad
///      one could hold transfers up (mints never touch it). The owner reveals with the committed secret and can't
///      pick designs (see `reveal`). Ownership moves in two steps and can't be renounced, so the links can always be
///      updated. Holders' miners and ETH are never within the owner's reach.
contract MineWorldMiners is ERC721, ERC2981, Ownable2Step, ICreatorToken {
    using Strings for uint256;

    uint256 public constant MAX_SUPPLY = 999;
    uint256 public constant MAX_PER_TX = 10;
    uint96 public constant ROYALTY_BPS = 500;
    uint256 public constant DESIGNS = 16;
    /// @notice The longest website or social link (bytes).
    uint256 public constant MAX_LINK = 256;

    /// @dev validateTransfer(address,address,address,uint256)
    bytes4 private constant VALIDATE_TRANSFER = 0xcaee23ea;

    uint256 public price;
    bool public saleOpen;
    /// @notice The block the sale was last closed in; the reveal must come in a later one.
    uint256 public saleClosedAt;
    uint256 public totalMinted;
    address public treasury;

    bytes32 public immutable seedCommit;
    uint256 public seed; // 0 until revealed

    address public transferValidator;
    string public imageBase;
    bool public imagesFrozen;
    /// @notice The project's website, shown as the collection's link on marketplaces ("" until set).
    string public website;
    /// @notice A social link (X, Discord...), shown in the collection's description ("" until set).
    string public social;
    /// @dev Replaces the built-in collection metadata when set (see contractURI).
    string private customContractURI;

    event Revealed(uint256 seed);
    event SaleOpen(bool open);
    event PriceSet(uint256 price);
    event TreasurySet(address indexed treasury);
    event ImageBaseSet(string imageBase);
    event ImagesFrozen();
    event LinksSet(string website, string social);
    /// @notice ERC-7572: marketplaces re-read contractURI when they see this.
    event ContractURIUpdated();
    /// @notice ERC-4906: marketplaces re-read these tokens' metadata.
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    error SaleClosed();
    error BadQuantity();
    error SoldOut();
    error WrongPayment();
    error NotRevealed();
    error AlreadyRevealed();
    error SaleStillOpen();
    error RevealTooSoon();
    error ZeroPrice();
    error BadSecret();
    error ZeroAddress();
    error NotAContract();
    error ImagesAreFrozen();
    error BadDesign();
    /// @notice The treasury can't be this contract (it refuses ETH, so no mint could pay it).
    error BadTreasury();
    /// @notice A link is too long, or has a character that would break the collection's JSON (", \ or a control).
    error BadLink();
    /// @notice Ownership can only be handed over (two-step), never renounced: the links must stay updatable.
    error CannotRenounce();

    constructor(
        address owner_,
        address treasury_,
        uint256 price_,
        bytes32 seedCommit_,
        address validator_,
        string memory imageBase_
    ) ERC721("MineWorldCraft Miners", "MWCM") Ownable(owner_) {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(this)) revert BadTreasury();
        if (price_ == 0) revert ZeroPrice();
        treasury = treasury_;
        price = price_;
        seedCommit = seedCommit_;
        imageBase = imageBase_;
        _setDefaultRoyalty(treasury_, ROYALTY_BPS);
        _setValidator(validator_);
    }

    // ---------------------------------------------------------------- mint

    function mint(uint256 quantity) external payable {
        if (!saleOpen) revert SaleClosed();
        if (quantity == 0 || quantity > MAX_PER_TX) revert BadQuantity();
        if (totalMinted + quantity > MAX_SUPPLY) revert SoldOut();
        if (msg.value != price * quantity) revert WrongPayment();
        for (uint256 i = 0; i < quantity; i++) {
            _mint(msg.sender, ++totalMinted);
        }
        // Paid straight to the treasury, with anything ever forced in here: this contract never holds ETH.
        Address.sendValue(payable(treasury), address(this).balance);
    }

    // ---------------------------------------------------------------- reveal

    /// @notice Fix every miner's design, and end the sale for good. The committed secret is mixed with the
    ///         previous block's hash, and the sale must have been closed in an earlier block than this one: that
    ///         hash didn't exist yet while anyone could mint, so nobody (the owner included) could mint knowing a
    ///         design. On Robinhood Chain, an Arbitrum chain, `block.number` follows the parent chain, so "an
    ///         earlier block" means waiting for the next parent-chain block (about 12 seconds) after closing.
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

    /// @notice The design a miner turned out to be: an index into the list below (0 Classic Miner ... 15 Crystal
    ///         Miner). Each token takes a different card of the 999-card deck, so if every miner is minted each
    ///         design appears exactly as often as its supply says.
    function designOf(uint256 tokenId) public view returns (uint256) {
        if (seed == 0) revert NotRevealed();
        _requireOwned(tokenId);
        return _designAt(_shuffle(tokenId - 1));
    }

    /// @notice How many of a design are in the deck.
    function supplyOf(uint256 design) public pure returns (uint256) {
        if (design >= DESIGNS) revert BadDesign();
        // 5 commons of 120, 4 rares of 60, 2 rares of 40, 2 legendaries of 20, 3 mythics of 13.
        if (design < 5) return 120;
        if (design < 9) return 60;
        if (design < 11) return 40;
        if (design < 13) return 20;
        return 13;
    }

    /// @dev Card `slot` of the unshuffled deck, dealt in design order.
    function _designAt(uint256 slot) internal pure returns (uint256 design) {
        uint256 end;
        for (design = 0; design < DESIGNS; design++) {
            end += supplyOf(design);
            if (slot < end) return design;
        }
        revert BadDesign();
    }

    /// @dev A keyed shuffle of 0..998: a 4-round Feistel network on 10 bits (a permutation of 0..1023), repeated
    ///      until it lands inside the deck. Different inputs always give different outputs.
    function _shuffle(uint256 x) internal view returns (uint256) {
        uint256 s = seed;
        do {
            uint256 l = x >> 5;
            uint256 r = x & 31;
            for (uint256 i = 0; i < 4; i++) {
                (l, r) = (r, l ^ (uint256(keccak256(abi.encode(s, i, r))) & 31));
            }
            x = (l << 5) | r;
        } while (x >= MAX_SUPPLY);
        return x;
    }

    // ---------------------------------------------------------------- metadata

    function designName(uint256 design) public pure returns (string memory) {
        string[16] memory names = [
            "Classic Miner",
            "Lumberjack",
            "Farmer",
            "Explorer",
            "Builder",
            "Knight",
            "Ninja",
            "Astronaut",
            "Deep Diver",
            "Lava Walker",
            "Frost Miner",
            "Gold Miner",
            "Diamond Miner",
            "Shadow Miner",
            "Neon Miner",
            "Crystal Miner"
        ];
        if (design >= DESIGNS) revert BadDesign();
        return names[design];
    }

    function rarityOf(uint256 design) public pure returns (string memory) {
        if (design >= DESIGNS) revert BadDesign();
        if (design < 5) return "Common";
        if (design < 11) return "Rare";
        if (design < 13) return "Legendary";
        return "Mythic";
    }

    /// @dev The image file for a design, as served under `imageBase`.
    function _key(uint256 design) private pure returns (string memory) {
        string[16] memory keys = [
            "classic",
            "lumberjack",
            "farmer",
            "explorer",
            "builder",
            "knight",
            "ninja",
            "astronaut",
            "diver",
            "lava",
            "frost",
            "gold",
            "diamond",
            "shadow",
            "neon",
            "crystal"
        ];
        return keys[design];
    }

    /// @notice Metadata written on-chain; only the picture is fetched from `imageBase`.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        string memory id = tokenId.toString();
        string memory json;
        if (seed == 0) {
            json = string.concat(
                '{"name":"MineWorldCraft Miner #', id,
                '","description":"A sealed MineWorldCraft Miner. Its design is revealed after the mint.","image":"',
                imageBase, 'mystery.png","attributes":[{"trait_type":"Status","value":"Sealed"}]}'
            );
        } else {
            uint256 d = _designAt(_shuffle(tokenId - 1));
            json = string.concat(
                '{"name":"', designName(d), " #", id,
                '","description":"A miner outfit to wear in MineWorldCraft. Cosmetic only: it changes how you look, never what you earn.","image":"',
                imageBase, _key(d), '.png","attributes":[{"trait_type":"Design","value":"', designName(d),
                '"},{"trait_type":"Rarity","value":"', rarityOf(d), '"}]}'
            );
        }
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// @notice The collection's page on marketplaces (ERC-7572): its name, description, pictures, and the website and
    ///         social links once the owner has set them (`setLinks`).
    function contractURI() external view returns (string memory) {
        if (bytes(customContractURI).length != 0) return customContractURI;
        string memory links;
        if (bytes(website).length != 0) links = string.concat(" Website: ", website);
        if (bytes(social).length != 0) links = string.concat(links, " Social: ", social);
        string memory json = string.concat(
            '{"name":"MineWorldCraft Miners","description":"999 limited miner outfits to wear in MineWorldCraft, a blocky mining world on Robinhood Chain. Miners are cosmetic: everyone in the game sees yours, and they never change what you earn.',
            links,
            '","image":"',
            imageBase,
            'collection.png","featured_image":"',
            imageBase,
            'collection.png","banner_image":"',
            imageBase,
            'banner.png"'
        );
        if (bytes(website).length != 0) json = string.concat(json, ',"external_link":"', website, '"');
        json = string.concat(json, "}");
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// @notice Every miner `owner` holds, so the game can list them without scanning event logs.
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

    /// @notice Never free: every miner is paid for.
    function setPrice(uint256 price_) external onlyOwner {
        if (price_ == 0) revert ZeroPrice();
        price = price_;
        emit PriceSet(price_);
    }

    /// @notice Moves mint payments and the royalty together. The 5% rate never changes.
    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(this)) revert BadTreasury();
        treasury = treasury_;
        _setDefaultRoyalty(treasury_, ROYALTY_BPS);
        emit TreasurySet(treasury_);
    }

    /// @notice Where the pictures live (ending in "/"), until frozen.
    function setImageBase(string calldata imageBase_) external onlyOwner {
        if (imagesFrozen) revert ImagesAreFrozen();
        imageBase = imageBase_;
        emit ImageBaseSet(imageBase_);
        emit ContractURIUpdated();
        if (totalMinted != 0) emit BatchMetadataUpdate(1, totalMinted);
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

    function _checkLink(string calldata link) private pure {
        bytes calldata b = bytes(link);
        if (b.length > MAX_LINK) revert BadLink();
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (c < 0x20 || c == 0x7f || c == '"' || c == "\\") revert BadLink();
        }
    }

    /// @notice Point the collection's metadata somewhere else (a JSON URL), or back to the built-in one ("").
    function setContractURI(string calldata uri) external onlyOwner {
        customContractURI = uri;
        emit ContractURIUpdated();
    }

    function freezeImages() external onlyOwner {
        imagesFrozen = true;
        emit ImagesFrozen();
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
