// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MineToken
/// @notice $MINE, earned by mining. Courier World's $STAMP (StampToken), line for line: hard-capped at 21M, counting
///         every mint so burns are permanent. A fixed launch allocation (10.5M) is minted to the pool hook at deploy
///         (locked there as liquidity); everything else is minted by the mining vault (MineVault, the one minter, set
///         once) as players earn it, at most 35,000 a day. No transfer tax: the 4% trading fee lives in the pool hook.
///         The deploy renounces ownership right after setting the minter, so nobody owns the token.
contract MineToken is ERC20, ERC20Burnable, ERC20Permit, Ownable {
    uint256 public constant MAX_SUPPLY = 21_000_000e18;

    address public minter;
    uint256 public totalMinted;

    event MinterSet(address indexed minter);

    error NotMinter();
    error CapExceeded();
    error MinterAlreadySet();
    error ZeroAddress();

    /// @param liquidity_ receives `liquidityAmount` at deploy: the pool hook on mainnet (a stand-in holder on a bare dev
    ///        chain), or nobody (0).
    constructor(address owner_, address liquidity_, uint256 liquidityAmount)
        ERC20("MineWorldCraft", "MINE")
        ERC20Permit("MineWorldCraft")
        Ownable(owner_)
    {
        if (liquidityAmount > MAX_SUPPLY) revert CapExceeded();
        if (liquidityAmount > 0) {
            if (liquidity_ == address(0)) revert ZeroAddress();
            totalMinted = liquidityAmount;
            _mint(liquidity_, liquidityAmount);
        }
    }

    /// @notice One-shot, so the owner can never swap in a different minter later.
    function setMinter(address minter_) external onlyOwner {
        if (minter != address(0)) revert MinterAlreadySet();
        if (minter_ == address(0)) revert ZeroAddress();
        minter = minter_;
        emit MinterSet(minter_);
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        if (totalMinted + amount > MAX_SUPPLY) revert CapExceeded();
        totalMinted += amount;
        _mint(to, amount);
    }

    function totalBurned() external view returns (uint256) {
        return totalMinted - totalSupply();
    }
}
