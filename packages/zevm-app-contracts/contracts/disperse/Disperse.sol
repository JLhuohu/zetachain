// SPDX-License-Identifier: MIT
pragma solidity 0.8.7;

import "@openzeppelin/contracts/interfaces/IERC20.sol";

contract Disperse {
    function disperseEther(address[] calldata recipients, uint256[] calldata values) external payable {
        require(recipients.length == values.length, "Recipients and values length mismatch");

        for (uint256 i = 0; i < recipients.length; i++) {
            (bool sent, ) = payable(recipients[i]).call{value: values[i]}("");
            require(sent, "Failed to send Ether");
        }

        uint256 balance = address(this).balance;
        if (balance > 0) {
            (bool sent, ) = payable(msg.sender).call{value: balance}("");
            require(sent, "Failed to refund remaining Ether");
        }
    }

    function disperseToken(IERC20 token, address[] calldata recipients, uint256[] calldata values) external {
        uint256 total = 0;
        for (uint256 i = 0; i < recipients.length; i++) total += values[i];
        require(token.transferFrom(msg.sender, address(this), total));
        for (uint256 i = 0; i < recipients.length; i++) require(token.transfer(recipients[i], values[i]));
    }

    function disperseTokenSimple(IERC20 token, address[] calldata recipients, uint256[] calldata values) external {
        for (uint256 i = 0; i < recipients.length; i++)
            require(token.transferFrom(msg.sender, recipients[i], values[i]));
    }
}
