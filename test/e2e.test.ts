import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Wallet, getBytes, parseEther, AbiCoder, solidityPacked } from "ethers";
import {
  packAccountGasLimits,
  packGasFees,
  buildInitCode,
  encodeExecute,
} from "../lib/userop";
import { PackedUserOperation } from "../lib/types";

describe("ERC-4337 전체 플로우", function () {
  let entryPoint: Contract;
  let factory: Contract;
  let paymaster: Contract;
  let owner: Wallet;
  let paymasterSigner: Wallet;
  let bundler: any; // HardhatEthersSigner
  let recipient: any;
  let chainId: bigint;

  before(async function () {
    // 타임아웃 증가 (컴파일 시간 포함)
    this.timeout(120000);

    const signers = await ethers.getSigners();
    bundler = signers[0];
    recipient = signers[3];

    // 랜덤 지갑 생성 (owner, paymasterSigner)
    const provider = ethers.provider;
    owner = Wallet.createRandom().connect(provider);
    paymasterSigner = Wallet.createRandom().connect(provider);
    chainId = (await provider.getNetwork()).chainId;

    // 1. EntryPoint 배포
    const EntryPoint = await ethers.getContractFactory("EntryPoint");
    entryPoint = await EntryPoint.deploy();
    await entryPoint.waitForDeployment();

    // 2. SimpleAccountFactory 배포
    const Factory = await ethers.getContractFactory("SimpleAccountFactory");
    factory = await Factory.deploy(await entryPoint.getAddress());
    await factory.waitForDeployment();

    // 3. VerifyingPaymaster 배포
    const Paymaster = await ethers.getContractFactory("VerifyingPaymaster");
    paymaster = await Paymaster.deploy(
      await entryPoint.getAddress(),
      paymasterSigner.address
    );
    await paymaster.waitForDeployment();

    // 4. Paymaster에 ETH 예치
    await entryPoint.depositTo(await paymaster.getAddress(), {
      value: parseEther("10"),
    });

    // 5. Paymaster 스테이킹
    await paymaster.addStake(1, { value: parseEther("1") });
  });

  it("UserOp으로 스마트 계정을 배포하고 Paymaster가 가스비를 대납해야 한다", async function () {
    this.timeout(60000);

    const entryPointAddress = await entryPoint.getAddress();
    const factoryAddress = await factory.getAddress();
    const paymasterAddress = await paymaster.getAddress();

    // 카운터팩추얼 주소 계산 (ethers의 getAddress()와 이름 충돌 방지)
    const sender = await factory["getAddress(address,uint256)"](owner.address, 0);
    console.log("  Counterfactual account address:", sender);

    // initCode 구성
    const initCode = buildInitCode(factoryAddress, owner.address, 0n);

    // callData: 0.01 ETH를 recipient에게 전송
    const callData = encodeExecute(recipient.address, parseEther("0.01"), "0x");

    // 가스 파라미터
    const verificationGasLimit = 500000n;
    const callGasLimit = 200000n;
    const preVerificationGas = 100000n;
    const maxPriorityFeePerGas = ethers.parseUnits("1", "gwei");
    const maxFeePerGas = ethers.parseUnits("2", "gwei");
    const paymasterValidationGasLimit = 100000n;
    const paymasterPostOpGasLimit = 50000n;

    // UserOp 구성 (paymasterAndData에 더미 서명)
    const abiCoder = AbiCoder.defaultAbiCoder();
    const encodedTimestamps = abiCoder.encode(["uint48", "uint48"], [0, 0]);
    const dummySignature = "0x" + "00".repeat(65);

    const paymasterAndDataWithDummy = solidityPacked(
      ["address", "uint128", "uint128", "bytes", "bytes"],
      [
        paymasterAddress,
        paymasterValidationGasLimit,
        paymasterPostOpGasLimit,
        encodedTimestamps,
        dummySignature,
      ]
    );

    let userOp: PackedUserOperation = {
      sender,
      nonce: 0n,
      initCode,
      callData,
      accountGasLimits: packAccountGasLimits(verificationGasLimit, callGasLimit),
      preVerificationGas,
      gasFees: packGasFees(maxPriorityFeePerGas, maxFeePerGas),
      paymasterAndData: paymasterAndDataWithDummy,
      signature: "0x",
    };

    // Paymaster 서명
    const pmHash = await paymaster.getHash(
      {
        sender: userOp.sender,
        nonce: userOp.nonce,
        initCode: userOp.initCode,
        callData: userOp.callData,
        accountGasLimits: userOp.accountGasLimits,
        preVerificationGas: userOp.preVerificationGas,
        gasFees: userOp.gasFees,
        paymasterAndData: userOp.paymasterAndData,
        signature: userOp.signature,
      },
      0, // validUntil
      0  // validAfter
    );
    const pmSignature = await paymasterSigner.signMessage(getBytes(pmHash));

    // paymasterAndData에 실제 서명 삽입
    userOp.paymasterAndData = solidityPacked(
      ["address", "uint128", "uint128", "bytes", "bytes"],
      [
        paymasterAddress,
        paymasterValidationGasLimit,
        paymasterPostOpGasLimit,
        encodedTimestamps,
        pmSignature,
      ]
    );

    // Owner 서명
    const userOpHash = await entryPoint.getUserOpHash({
      sender: userOp.sender,
      nonce: userOp.nonce,
      initCode: userOp.initCode,
      callData: userOp.callData,
      accountGasLimits: userOp.accountGasLimits,
      preVerificationGas: userOp.preVerificationGas,
      gasFees: userOp.gasFees,
      paymasterAndData: userOp.paymasterAndData,
      signature: userOp.signature,
    });
    userOp.signature = await owner.signMessage(getBytes(userOpHash));

    // 스마트 계정 주소에 ETH 전송 (execute에서 전송할 ETH)
    await bundler.sendTransaction({
      to: sender,
      value: parseEther("1"),
    });

    // handleOps 호출
    const recipientBalanceBefore = await ethers.provider.getBalance(recipient.address);

    const tx = await entryPoint.handleOps(
      [{
        sender: userOp.sender,
        nonce: userOp.nonce,
        initCode: userOp.initCode,
        callData: userOp.callData,
        accountGasLimits: userOp.accountGasLimits,
        preVerificationGas: userOp.preVerificationGas,
        gasFees: userOp.gasFees,
        paymasterAndData: userOp.paymasterAndData,
        signature: userOp.signature,
      }],
      bundler.address
    );
    const receipt = await tx.wait();
    console.log("  handleOps gas used:", receipt!.gasUsed.toString());

    // 검증: 스마트 계정이 배포되었는지
    const code = await ethers.provider.getCode(sender);
    expect(code).to.not.equal("0x");
    console.log("  Smart account deployed successfully!");

    // 검증: recipient에게 0.01 ETH 전송되었는지
    const recipientBalanceAfter = await ethers.provider.getBalance(recipient.address);
    expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(parseEther("0.01"));
    console.log("  ETH transfer verified: 0.01 ETH sent to recipient");

    // 검증: UserOperationEvent 이벤트 발생
    const events = receipt!.logs;
    const userOpEvent = events.find((log: any) => {
      try {
        const parsed = entryPoint.interface.parseLog({ topics: log.topics, data: log.data });
        return parsed?.name === "UserOperationEvent";
      } catch { return false; }
    });
    expect(userOpEvent).to.not.be.undefined;
    console.log("  UserOperationEvent emitted!");
  });

  it("배포된 계정에서 두 번째 UserOp을 실행해야 한다", async function () {
    this.timeout(60000);

    const entryPointAddress = await entryPoint.getAddress();
    const paymasterAddress = await paymaster.getAddress();
    const sender = await factory["getAddress(address,uint256)"](owner.address, 0);

    // nonce 가져오기
    const nonce = await entryPoint.getNonce(sender, 0);
    expect(nonce).to.equal(1n);

    // callData: 0.05 ETH를 recipient에게 전송
    const callData = encodeExecute(recipient.address, parseEther("0.05"), "0x");

    const verificationGasLimit = 200000n;
    const callGasLimit = 200000n;
    const preVerificationGas = 100000n;
    const maxPriorityFeePerGas = ethers.parseUnits("1", "gwei");
    const maxFeePerGas = ethers.parseUnits("2", "gwei");
    const paymasterValidationGasLimit = 100000n;
    const paymasterPostOpGasLimit = 50000n;

    const abiCoder = AbiCoder.defaultAbiCoder();
    const encodedTimestamps = abiCoder.encode(["uint48", "uint48"], [0, 0]);
    const dummySignature = "0x" + "00".repeat(65);

    const paymasterAndDataWithDummy = solidityPacked(
      ["address", "uint128", "uint128", "bytes", "bytes"],
      [paymasterAddress, paymasterValidationGasLimit, paymasterPostOpGasLimit, encodedTimestamps, dummySignature]
    );

    let userOp: PackedUserOperation = {
      sender,
      nonce,
      initCode: "0x", // 이미 배포됨
      callData,
      accountGasLimits: packAccountGasLimits(verificationGasLimit, callGasLimit),
      preVerificationGas,
      gasFees: packGasFees(maxPriorityFeePerGas, maxFeePerGas),
      paymasterAndData: paymasterAndDataWithDummy,
      signature: "0x",
    };

    // Paymaster 서명
    const pmHash = await paymaster.getHash(
      {
        sender: userOp.sender,
        nonce: userOp.nonce,
        initCode: userOp.initCode,
        callData: userOp.callData,
        accountGasLimits: userOp.accountGasLimits,
        preVerificationGas: userOp.preVerificationGas,
        gasFees: userOp.gasFees,
        paymasterAndData: userOp.paymasterAndData,
        signature: userOp.signature,
      },
      0, 0
    );
    const pmSignature = await paymasterSigner.signMessage(getBytes(pmHash));

    userOp.paymasterAndData = solidityPacked(
      ["address", "uint128", "uint128", "bytes", "bytes"],
      [paymasterAddress, paymasterValidationGasLimit, paymasterPostOpGasLimit, encodedTimestamps, pmSignature]
    );

    // Owner 서명
    const userOpHash = await entryPoint.getUserOpHash({
      sender: userOp.sender,
      nonce: userOp.nonce,
      initCode: userOp.initCode,
      callData: userOp.callData,
      accountGasLimits: userOp.accountGasLimits,
      preVerificationGas: userOp.preVerificationGas,
      gasFees: userOp.gasFees,
      paymasterAndData: userOp.paymasterAndData,
      signature: userOp.signature,
    });
    userOp.signature = await owner.signMessage(getBytes(userOpHash));

    // 실행
    const recipientBalanceBefore = await ethers.provider.getBalance(recipient.address);

    const tx = await entryPoint.handleOps(
      [{
        sender: userOp.sender,
        nonce: userOp.nonce,
        initCode: userOp.initCode,
        callData: userOp.callData,
        accountGasLimits: userOp.accountGasLimits,
        preVerificationGas: userOp.preVerificationGas,
        gasFees: userOp.gasFees,
        paymasterAndData: userOp.paymasterAndData,
        signature: userOp.signature,
      }],
      bundler.address
    );
    const receipt = await tx.wait();
    console.log("  Second UserOp gas used:", receipt!.gasUsed.toString());

    // 검증
    const recipientBalanceAfter = await ethers.provider.getBalance(recipient.address);
    expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(parseEther("0.05"));
    console.log("  Second UserOp verified: 0.05 ETH sent to recipient");
  });
});
