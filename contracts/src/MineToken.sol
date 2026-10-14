// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title MineToken
/// @notice $MINE, MineWorldCraft's token. A fixed supply of 1,000,000,000, all minted once, here, at deploy: half to
///         the pool hook (MineHook), which locks it in the $MINE/IMD Uniswap v4 pool for good, and half to the vault
///         (MiningSites), which pays it out only to players for what they earn in the game. A plain ERC-20 with
///         EIP-2612 permit and burn: no owner, no minting after deploy, no transfer tax, no blocklist. The 4%
///         trading fee is taken by the pool's hook, not by the token, so wallet-to-wallet transfers are never taxed.
contract MineToken is ERC20, ERC20Burnable, ERC20Permit {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    /// @notice Locked as single-sided liquidity in the pool.
    uint256 public constant POOL_SUPPLY = 500_000_000e18;
    /// @notice Held by MiningSites for players to earn.
    uint256 public constant VAULT_SUPPLY = TOTAL_SUPPLY - POOL_SUPPLY;

    /// @notice Received POOL_SUPPLY at deploy: the pool hook on Robinhood Chain (a stand-in on a bare dev chain).
    address public immutable pool;
    /// @notice Received VAULT_SUPPLY at deploy: MiningSites.
    address public immutable vault;

    error ZeroAddress();

    constructor(address pool_, address vault_) ERC20("MineWorldCraft", "MINE") ERC20Permit("MineWorldCraft") {
        if (pool_ == address(0) || vault_ == address(0)) revert ZeroAddress();
        pool = pool_;
        vault = vault_;
        _mint(pool_, POOL_SUPPLY);
        _mint(vault_, VAULT_SUPPLY);
    }

    /// @notice Nobody controls the token. (Explorers read this as renounced.)
    function owner() external pure returns (address) {
        return address(0);
    }
}
