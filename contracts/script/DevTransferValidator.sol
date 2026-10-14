// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Local chains only: lets holders move their own Crafters and blocks every other caller, like the real registry does
/// for marketplaces that skip the royalty.
contract DevTransferValidator {
    error UnauthorizedTransfer();

    function validateTransfer(address caller, address from, address, uint256) external pure {
        if (caller != from) revert UnauthorizedTransfer();
    }
}
