// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Extra traits for MineWorld Crafters, kept outside the NFT so new ones can show on marketplaces without
///         touching it (CrafterLevels gives each Crafter's "Level"). MineWorldCrafters appends them to every token's
///         attributes once its owner points it at one (`setAttributesExtension`).
interface ICrafterAttributes {
    /// @notice Crafter `tokenId`'s extra attributes, as JSON objects separated by commas and without brackets (for
    ///         example `{"trait_type":"Level","value":2,"max_value":5}`), or "" for none.
    function attributesOf(uint256 tokenId) external view returns (string memory);
}

/// @notice What MineWorldCrafters lets its attributes extension (and its owner) ask for: marketplaces re-reading some
///         Crafters' metadata (ERC-4906), after their extra attributes changed.
interface ICrafterMetadata {
    function refreshMetadata(uint256 fromTokenId, uint256 toTokenId) external;
}
