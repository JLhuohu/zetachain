import { FakeContract, smock } from "@defi-wonderland/smock";
import { BigNumber } from "@ethersproject/bignumber";
import { AddressZero, MaxUint256 } from "@ethersproject/constants";
import { parseEther, parseUnits } from "@ethersproject/units";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai, { expect } from "chai";
import { ethers } from "hardhat";

import { getMultiChainSwapUniV2, getMultiChainSwapZetaConnector } from "../lib/multi-chain-swap/MultiChainSwap.helpers";
import { getAddress } from "../lib/shared/address.helpers";
import { getNow, getZetaMock } from "../lib/shared/deploy.helpers";
import {
  ERC20__factory,
  IERC20,
  IUniswapV2Router02,
  MultiChainSwapUniV2,
  MultiChainSwapZetaConnector,
  UniswapV2Router02__factory
} from "../typechain-types";
import { USDC_ADDR } from "./MultiChainSwap.constants";
import { parseUniswapLog, parseZetaLog } from "./test.helpers";

chai.should();
chai.use(smock.matchers);

const HARDHAT_CHAIN_ID = 1337;

describe("MultiChainSwap tests", () => {
  let uniswapRouterFork: IUniswapV2Router02;
  let WETH: string;
  let zetaTokenMock: IERC20;
  let USDCTokenContract: IERC20;
  let zetaConnectorMock: MultiChainSwapZetaConnector;

  let multiChainSwapContractA: MultiChainSwapUniV2;
  const chainAId = 1;

  let multiChainSwapContractB: MultiChainSwapUniV2;
  const chainBId = 2;

  let zetaConnectorSmock: FakeContract<MultiChainSwapZetaConnector>;
  let multiChainSwapContractWithSmock: MultiChainSwapUniV2;

  let accounts: SignerWithAddress[];
  let deployer: SignerWithAddress;
  let account1: SignerWithAddress;

  const encoder = new ethers.utils.AbiCoder();

  const ZETA_USDC_PRICE = BigNumber.from("1455462180");

  const addZetaEthLiquidity = async () => {
    const tx1 = await zetaTokenMock.approve(uniswapRouterFork.address, MaxUint256);
    await tx1.wait();

    // 2 ZETA = 1 ETH
    const tx2 = await uniswapRouterFork.addLiquidityETH(
      zetaTokenMock.address,
      parseUnits("1000"),
      0,
      0,
      deployer.address,
      (await getNow()) + 360,
      { value: parseUnits("500") }
    );
    await tx2.wait();
  };

  const clearUSDCBalance = async (account: SignerWithAddress) => {
    const balance = await USDCTokenContract.balanceOf(account.address);
    const w = ethers.Wallet.createRandom();
    const tx = await USDCTokenContract.connect(account).transfer(w.address, balance);
    await tx.wait();
  };

  const swapZetaToUSDC = async (signer: SignerWithAddress, zetaValueAndGas: BigNumber) => {
    const path = [zetaTokenMock.address, WETH, USDC_ADDR];
    const tx = await uniswapRouterFork
      .connect(signer)
      .swapExactTokensForTokens(zetaValueAndGas, 0, path, signer.address, (await getNow()) + 360);

    await tx.wait();
  };

  beforeEach(async () => {
    const uniswapRouterAddr = getAddress("uniswapV2Router02", {
      customNetworkName: "eth-mainnet",
      customZetaNetwork: "mainnet"
    });
    accounts = await ethers.getSigners();
    [deployer, account1] = accounts;

    const uniswapRouterFactory = new UniswapV2Router02__factory(deployer);
    uniswapRouterFork = uniswapRouterFactory.attach(uniswapRouterAddr);

    WETH = await uniswapRouterFork.WETH();

    zetaTokenMock = await getZetaMock();
    zetaConnectorMock = await getMultiChainSwapZetaConnector(zetaTokenMock.address);

    const ERC20Factory = new ERC20__factory(deployer);
    USDCTokenContract = ERC20Factory.attach(USDC_ADDR);

    multiChainSwapContractA = await getMultiChainSwapUniV2({
      deployParams: [zetaConnectorMock.address, zetaTokenMock.address, uniswapRouterAddr]
    });

    multiChainSwapContractB = await getMultiChainSwapUniV2({
      deployParams: [zetaConnectorMock.address, zetaTokenMock.address, uniswapRouterAddr]
    });

    zetaConnectorSmock = await smock.fake("MultiChainSwapZetaConnector");
    multiChainSwapContractWithSmock = await getMultiChainSwapUniV2({
      deployParams: [zetaConnectorSmock.address, zetaTokenMock.address, uniswapRouterAddr]
    });

    const encodedCrossChainAddressB = ethers.utils.solidityPack(["address"], [multiChainSwapContractB.address]);
    multiChainSwapContractA.setInteractorByChainId(chainBId, encodedCrossChainAddressB);
    multiChainSwapContractWithSmock.setInteractorByChainId(chainBId, encodedCrossChainAddressB);

    const encodedCrossChainAddressA = ethers.utils.solidityPack(["address"], [multiChainSwapContractA.address]);
    multiChainSwapContractB.setInteractorByChainId(chainAId, encodedCrossChainAddressA);

    await clearUSDCBalance(deployer);
    await clearUSDCBalance(account1);
  });

  describe("swapTokensForTokensCrossChain", () => {
    it("Should revert if the destinationChainId is not in the storage", async () => {
      await expect(
        multiChainSwapContractA.swapETHForTokensCrossChain(
          ethers.utils.solidityPack(["address"], [account1.address]),
          zetaTokenMock.address,
          false,
          0,
          10,
          MaxUint256,
          MaxUint256,
          {
            value: parseUnits("1")
          }
        )
      ).to.be.revertedWith("InvalidDestinationChainId");
    });

    it("Should revert if the sourceInputToken isn't provided", async () => {
      await expect(
        multiChainSwapContractA.swapTokensForTokensCrossChain(
          AddressZero,
          BigNumber.from(10),
          ethers.utils.solidityPack(["address"], [account1.address]),
          zetaTokenMock.address,
          false,
          0,
          chainBId,
          MaxUint256,
          MaxUint256
        )
      ).to.be.revertedWith("MissingSourceInputTokenAddress");
    });

    it("Should revert if the destinationOutToken isn't provided", async () => {
      await expect(
        multiChainSwapContractA.swapTokensForTokensCrossChain(
          zetaTokenMock.address,
          BigNumber.from(10),
          ethers.utils.solidityPack(["address"], [account1.address]),
          AddressZero,
          false,
          0,
          chainBId,
          MaxUint256,
          MaxUint256
        )
      ).to.be.revertedWith("OutTokenInvariant");
    });

    it("Should not perform any trade if the input token is Zeta", async () => {
      await addZetaEthLiquidity();
      await swapZetaToUSDC(deployer, parseUnits("10"));

      expect(await zetaTokenMock.balanceOf(account1.address)).to.be.eq(0);

      const ZETA_TO_TRANSFER = parseUnits("1");

      const tx1 = await zetaTokenMock.approve(multiChainSwapContractA.address, ZETA_TO_TRANSFER);
      await tx1.wait();

      const tx3 = await USDCTokenContract.approve(multiChainSwapContractA.address, ZETA_USDC_PRICE);
      await tx3.wait();

      const tx2 = await multiChainSwapContractA.swapTokensForTokensCrossChain(
        zetaTokenMock.address,
        ZETA_USDC_PRICE,
        ethers.utils.solidityPack(["address"], [account1.address]),
        zetaTokenMock.address,
        false,
        0,
        chainBId,
        MaxUint256,
        MaxUint256
      );

      const result = await tx2.wait();
      const eventNames = parseUniswapLog(result.logs);
      expect(eventNames.filter(e => e === "Swap")).to.have.lengthOf(0);
    });

    it("Should trade the input token for Zeta", async () => {
      await addZetaEthLiquidity();
      await swapZetaToUSDC(deployer, parseUnits("10"));

      expect(await zetaTokenMock.balanceOf(account1.address)).to.be.eq(0);

      const ZETA_TO_TRANSFER = parseUnits("1");

      const tx1 = await zetaTokenMock.approve(multiChainSwapContractA.address, ZETA_TO_TRANSFER);
      await tx1.wait();

      const tx3 = await USDCTokenContract.approve(multiChainSwapContractA.address, ZETA_USDC_PRICE);
      await tx3.wait();

      const tx2 = await multiChainSwapContractA.swapTokensForTokensCrossChain(
        USDC_ADDR,
        ZETA_USDC_PRICE,
        ethers.utils.solidityPack(["address"], [account1.address]),
        zetaTokenMock.address,
        false,
        0,
        chainBId,
        MaxUint256,
        MaxUint256
      );

      const result = await tx2.wait();
      const eventNames = parseUniswapLog(result.logs);
      expect(eventNames.filter(e => e === "Swap")).to.have.lengthOf(2);
    });

    it("Should trade zeta for the output token", async () => {
      await addZetaEthLiquidity();
      await swapZetaToUSDC(deployer, parseUnits("10"));

      expect(await zetaTokenMock.balanceOf(account1.address)).to.be.eq(0);

      const ZETA_TO_TRANSFER = parseUnits("1");

      const tx1 = await zetaTokenMock.approve(multiChainSwapContractA.address, ZETA_TO_TRANSFER);
      await tx1.wait();

      const tx3 = await USDCTokenContract.approve(multiChainSwapContractA.address, ZETA_USDC_PRICE);
      await tx3.wait();

      const tx2 = await multiChainSwapContractA.swapTokensForTokensCrossChain(
        zetaTokenMock.address,
        ZETA_USDC_PRICE,
        ethers.utils.solidityPack(["address"], [account1.address]),
        USDC_ADDR,
        false,
        0,
        chainBId,
        MaxUint256,
        MaxUint256
      );

      const result = await tx2.wait();
      const eventNames = parseUniswapLog(result.logs);
      expect(eventNames.filter(e => e === "Swap")).to.have.lengthOf(2);
    });

    it("Should trade input token for zeta and zeta for the output token", async () => {
      await addZetaEthLiquidity();
      await swapZetaToUSDC(deployer, parseUnits("10"));

      expect(await zetaTokenMock.balanceOf(account1.address)).to.be.eq(0);

      const ZETA_TO_TRANSFER = parseUnits("1");

      const tx1 = await zetaTokenMock.approve(multiChainSwapContractA.address, ZETA_TO_TRANSFER);
      await tx1.wait();

      const tx3 = await USDCTokenContract.approve(multiChainSwapContractA.address, ZETA_USDC_PRICE);
      await tx3.wait();

      const tx2 = await multiChainSwapContractA.swapTokensForTokensCrossChain(
        USDC_ADDR,
        ZETA_USDC_PRICE,
        ethers.utils.solidityPack(["address"], [account1.address]),
        USDC_ADDR,
        false,
        0,
        chainBId,
        MaxUint256,
        MaxUint256
      );

      const result = await tx2.wait();
      const eventNames = parseUniswapLog(result.logs);
      expect(eventNames.filter(e => e === "Swap")).to.have.lengthOf(4);
    });

    it("Should call connector.send", async () => {
      await addZetaEthLiquidity();
      await swapZetaToUSDC(deployer, parseUnits("10"));

      expect(await zetaTokenMock.balanceOf(account1.address)).to.be.eq(0);

      const ZETA_TO_TRANSFER = parseUnits("1");

      const tx1 = await zetaTokenMock.approve(multiChainSwapContractWithSmock.address, ZETA_TO_TRANSFER);
      await tx1.wait();

      const tx3 = await USDCTokenContract.approve(multiChainSwapContractWithSmock.address, ZETA_USDC_PRICE);
      await tx3.wait();

      const tx2 = await multiChainSwapContractWithSmock.swapTokensForTokensCrossChain(
        USDC_ADDR,
        ZETA_USDC_PRICE,
        ethers.utils.solidityPack(["address"], [account1.address]),
        USDC_ADDR,
        false,
        0,
        chainBId,
        MaxUint256,
        MaxUint256
      );

      zetaConnectorSmock.send.atCall(0).should.be.called;
    });

    it("Should emit a SentTokenSwap event", async () => {
      await addZetaEthLiquidity();
      await swapZetaToUSDC(deployer, parseUnits("10"));

      const originAddressInitialZetaBalance = await zetaTokenMock.balanceOf(deployer.address);
      expect(await zetaTokenMock.balanceOf(account1.address)).to.be.eq(0);

      const ZETA_TO_TRANSFER = parseUnits("1");

      const tx1 = await zetaTokenMock.approve(multiChainSwapContractA.address, ZETA_TO_TRANSFER);
      await tx1.wait();

      const tx3 = await USDCTokenContract.approve(multiChainSwapContractA.address, ZETA_USDC_PRICE);
      await tx3.wait();

      const tx2 = await multiChainSwapContractA.swapTokensForTokensCrossChain(
        USDC_ADDR,
        ZETA_USDC_PRICE,
        ethers.utils.solidityPack(["address"], [account1.address]),
        USDC_ADDR,
        false,
        0,
        chainBId,
        MaxUint256,
        MaxUint256
      );

      const result = await tx2.wait();
      const eventNames = parseZetaLog(result.logs);

      expect(eventNames.filter(e => e === "Swapped")).to.have.lengthOf(1);
    });

    it("Should revert if the destinationChainId is not in the storage", async () => {
      const call = multiChainSwapContractA.swapTokensForTokensCrossChain(
        USDC_ADDR,
        ZETA_USDC_PRICE,
        ethers.utils.solidityPack(["address"], [account1.address]),
        USDC_ADDR,
        false,
        0,
        chainBId + 5,
        MaxUint256,
        MaxUint256
      );

      await expect(call).to.be.revertedWith("InvalidDestinationChainId");
    });

    it("Should revert if the sourceInputToken isn't provided", async () => {
      const call = multiChainSwapContractA.swapTokensForTokensCrossChain(
        AddressZero,
        ZETA_USDC_PRICE,
        ethers.utils.solidityPack(["address"], [account1.address]),
        USDC_ADDR,
        false,
        0,
        chainBId,
        MaxUint256,
        MaxUint256
      );

      await expect(call).to.be.revertedWith("MissingSourceInputTokenAddress");
    });

    it("Should revert if the destinationOutToken isn't provided", async () => {
      const call = multiChainSwapContractA.swapTokensForTokensCrossChain(
        USDC_ADDR,
        ZETA_USDC_PRICE,
        ethers.utils.solidityPack(["address"], [account1.address]),
        AddressZero,
        false,
        0,
        chainBId,
        MaxUint256,
        MaxUint256
      );

      await expect(call).to.be.revertedWith("OutTokenInvariant");
    });
  });

  describe("onZetaMessage", () => {
    it("Should revert if the caller is not ZetaConnector", async () => {
      await expect(
        multiChainSwapContractA.onZetaMessage({
          destinationAddress: multiChainSwapContractB.address,
          message: encoder.encode(["address"], [multiChainSwapContractA.address]),
          sourceChainId: chainBId,
          zetaTxSenderAddress: ethers.utils.solidityPack(["address"], [multiChainSwapContractA.address]),
          zetaValue: 0
        })
      )
        .to.be.revertedWith("InvalidCaller")
        .withArgs(deployer.address);
    });

    it("Should revert if the zetaTxSenderAddress it not in interactorsByChainId", async () => {
      await expect(
        zetaConnectorMock.callOnZetaMessage(
          ethers.utils.solidityPack(["address"], [multiChainSwapContractB.address]),
          chainAId,
          multiChainSwapContractB.address,
          0,
          encoder.encode(["address"], [multiChainSwapContractB.address])
        )
      ).to.be.revertedWith("InvalidZetaMessageCall");
    });
  });

  describe("onZetaRevert", () => {
    it("Should revert if the caller is not ZetaConnector", async () => {
      await expect(
        multiChainSwapContractA.onZetaRevert({
          destinationAddress: ethers.utils.solidityPack(["address"], [multiChainSwapContractB.address]),
          destinationChainId: chainBId,
          message: encoder.encode(["address"], [multiChainSwapContractA.address]),
          remainingZetaValue: 0,
          sourceChainId: chainAId,
          zetaTxSenderAddress: deployer.address
        })
      )
        .to.be.revertedWith("InvalidCaller")
        .withArgs(deployer.address);
    });

    it("Should trade the returned Zeta back for the input zeta token", async () => {
      await addZetaEthLiquidity();
      await swapZetaToUSDC(deployer, parseUnits("10"));

      const tx1 = await zetaTokenMock.transfer(multiChainSwapContractA.address, parseUnits("100"));
      await tx1.wait();

      const originAddressInitialZetaBalance = await zetaTokenMock.balanceOf(deployer.address);

      const message = encoder.encode(
        ["bytes32", "address", "address", "uint256", "bytes", "address", "bool", "uint256", "bool"],
        [
          "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          deployer.address,
          zetaTokenMock.address,
          0,
          "0xffffffff",
          multiChainSwapContractA.address,
          true,
          0,
          false
        ]
      );

      const tx2 = await zetaConnectorMock.callOnZetaRevert(
        multiChainSwapContractA.address,
        HARDHAT_CHAIN_ID,
        chainBId,
        encoder.encode(["address"], [multiChainSwapContractB.address]),
        10,
        0,
        message
      );

      await tx2.wait();

      const originAddressFinalZetaBalance = await zetaTokenMock.balanceOf(deployer.address);
      expect(originAddressFinalZetaBalance).to.be.eq(originAddressInitialZetaBalance.add(10));
    });

    it("Should trade the returned Zeta back for the input token", async () => {
      await addZetaEthLiquidity();
      await swapZetaToUSDC(deployer, parseUnits("10"));

      const tx1 = await zetaTokenMock.transfer(multiChainSwapContractA.address, parseUnits("100"));
      await tx1.wait();

      const originAddressInitialUSDCBalance = await USDCTokenContract.balanceOf(deployer.address);

      const message = encoder.encode(
        ["bytes32", "address", "address", "uint256", "bytes", "address", "bool", "uint256", "bool"],
        [
          "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          deployer.address,
          USDCTokenContract.address,
          0,
          "0xffffffff",
          multiChainSwapContractA.address,
          true,
          0,
          false
        ]
      );

      const tx2 = await zetaConnectorMock.callOnZetaRevert(
        multiChainSwapContractA.address,
        HARDHAT_CHAIN_ID,
        chainBId,
        encoder.encode(["address"], [multiChainSwapContractB.address]),
        parseUnits("1"),
        0,
        message
      );

      await tx2.wait();

      const originAddressFinalUSDCBalance = await USDCTokenContract.balanceOf(deployer.address);
      expect(originAddressFinalUSDCBalance).to.be.lt(originAddressInitialUSDCBalance.add(ZETA_USDC_PRICE));
      expect(originAddressFinalUSDCBalance).to.be.gt(
        originAddressInitialUSDCBalance
          .add(ZETA_USDC_PRICE)
          .mul(995)
          .div(1000)
      );
    });

    it("Should trade the returned ETH back to the caller", async () => {
      await addZetaEthLiquidity();
      await swapZetaToUSDC(deployer, parseUnits("10"));

      const tx1 = await zetaTokenMock.transfer(multiChainSwapContractA.address, parseUnits("100"));
      await tx1.wait();

      const originAddressInitialETHBalance = await ethers.provider.getBalance(deployer.address);

      const message = encoder.encode(
        ["bytes32", "address", "address", "uint256", "bytes", "address", "bool", "uint256", "bool"],
        [
          "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          deployer.address,
          WETH,
          0,
          "0xffffffff",
          multiChainSwapContractA.address,
          true,
          0,
          true
        ]
      );

      const tx2 = await zetaConnectorMock.callOnZetaRevert(
        multiChainSwapContractA.address,
        HARDHAT_CHAIN_ID,
        chainBId,
        encoder.encode(["address"], [multiChainSwapContractB.address]),
        parseUnits("2"),
        0,
        message
      );

      await tx2.wait();

      const originAddressFinalETHBalance = await ethers.provider.getBalance(deployer.address);
      expect(originAddressFinalETHBalance).to.be.gt(originAddressInitialETHBalance.add("1"));
      expect(originAddressFinalETHBalance).to.be.lt(
        originAddressInitialETHBalance
          .add("1")
          .mul(1005)
          .div(1000)
      );
    });

    it("Should emit a RevertedSwap event", async () => {
      await addZetaEthLiquidity();
      await swapZetaToUSDC(deployer, parseUnits("10"));

      const tx1 = await zetaTokenMock.transfer(multiChainSwapContractA.address, parseUnits("100"));
      await tx1.wait();

      const originAddressInitialETHBalance = await ethers.provider.getBalance(deployer.address);

      const message = encoder.encode(
        ["bytes32", "address", "address", "uint256", "bytes", "address", "bool", "uint256", "bool"],
        [
          "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          deployer.address,
          WETH,
          0,
          "0xffffffff",
          multiChainSwapContractA.address,
          true,
          0,
          true
        ]
      );

      const tx2 = await zetaConnectorMock.callOnZetaRevert(
        multiChainSwapContractA.address,
        HARDHAT_CHAIN_ID,
        chainBId,
        encoder.encode(["address"], [multiChainSwapContractB.address]),
        parseUnits("2"),
        0,
        message
      );

      const result = await tx2.wait();
      const eventNames = parseZetaLog(result.logs);
      expect(eventNames.filter(e => e === "RevertedSwap")).to.have.lengthOf(1);
    });
  });
});
