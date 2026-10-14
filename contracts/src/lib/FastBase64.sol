// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Standard base64 (RFC 4648, with "=" padding), about twice as cheap as OpenZeppelin's: the Crafters'
///         tokenURI encodes some 30 KB per call (the picture, then the JSON around it). The technique is Solady's
///         (MIT): the alphabet sits in scratch memory so that `mload(i)` ends with character i, and each 3 bytes in
///         become 4 characters out with a single word store.
library FastBase64 {
    function encode(bytes memory data) internal pure returns (string memory result) {
        assembly ("memory-safe") {
            result := mload(0x40)
            let len := mload(data)
            switch len
            case 0 {
                mstore(result, 0)
                mstore(0x40, add(result, 0x20))
            }
            default {
                let encodedLen := shl(2, div(add(len, 2), 3))
                // The alphabet at 0x1f..0x5e (over the free memory pointer, set again below; the zero slot at 0x60
                // is untouched).
                mstore(0x1f, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef")
                mstore(0x3f, "ghijklmnopqrstuvwxyz0123456789+/")
                let p := add(result, 0x20)
                let end := add(p, encodedLen)
                // Zero the word after the input, so the last group reads zeros past its end.
                let dataEnd := add(add(data, 0x20), len)
                let saved := mload(dataEnd)
                mstore(dataEnd, 0)
                for {} 1 {} {
                    data := add(data, 3)
                    let input := mload(data)
                    mstore8(0, mload(and(shr(18, input), 0x3f)))
                    mstore8(1, mload(and(shr(12, input), 0x3f)))
                    mstore8(2, mload(and(shr(6, input), 0x3f)))
                    mstore8(3, mload(and(input, 0x3f)))
                    mstore(p, mload(0))
                    p := add(p, 4)
                    if iszero(lt(p, end)) { break }
                }
                mstore(dataEnd, saved)
                // Pad: one byte over a multiple of 3 ends "==", two end "=". (div(2, 0) is 0 in the EVM.)
                mstore(sub(end, div(2, mod(len, 3))), shl(240, 0x3d3d))
                mstore(end, 0)
                mstore(result, encodedLen)
                mstore(0x40, add(end, 0x20))
            }
        }
    }
}
