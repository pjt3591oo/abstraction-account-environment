import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import {
  packAccountGasLimits,
  packGasFees,
  buildInitCode,
  encodeExecute,
} from "../lib/userop";
import { PackedUserOperation, DeployedAddresses } from "../lib/types";
import { AbiCoder, solidityPacked, getBytes, parseEther, Wallet } from "ethers";

async function main() {
  // 배포된 주소 로드
  const addressesPath = path.join(__dirname, "..", "deployments", "addresses.json");
  const addresses: DeployedAddresses = JSON.parse(fs.readFileSync(addressesPath, "utf-8"));

  const provider = ethers.provider;
  const signers = await ethers.getSigners();
  const bundler = signers[0];
  const recipient = signers[4];

  // Paymaster signer (Hardhat account #1)
  const paymasterSigner = signers[1];

  // 새로운 owner 지갑 생성
  const owner = Wallet.createRandom().connect(provider);
  console.log("=== ERC-4337 전체 플로우 테스트 ===\n");
  console.log("Owner (EOA):", owner.address);
  console.log("Recipient:", recipient.address);
  console.log("EntryPoint:", addresses.entryPoint);
  console.log("Factory:", addresses.simpleAccountFactory);
  console.log("Paymaster:", addresses.verifyingPaymaster);

  // 컨트랙트 인스턴스
  const entryPoint = await ethers.getContractAt("EntryPoint", addresses.entryPoint);
  const factory = await ethers.getContractAt("SimpleAccountFactory", addresses.simpleAccountFactory);
  const paymaster = await ethers.getContractAt("VerifyingPaymaster", addresses.verifyingPaymaster);
  const chainId = (await provider.getNetwork()).chainId;

  // ========================================
  // Step 1: 카운터팩추얼 주소 계산
  // ========================================
  console.log("\n--- Step 1: 카운터팩추얼 주소 계산 ---");
  const sender = await factory["getAddress(address,uint256)"](owner.address, 0);
  console.log("Smart Account 주소 (아직 배포 전):", sender);

  const code = await provider.getCode(sender);
  console.log("현재 코드:", code === "0x" ? "(비어있음 - 아직 배포 안됨)" : "이미 배포됨");

  // ========================================
  // Step 2: 스마트 계정에 ETH 전송
  // ========================================
  console.log("\n--- Step 2: 스마트 계정에 ETH 전송 ---");
  const fundTx = await bundler.sendTransaction({
    to: sender,
    value: parseEther("2"),
  });
  await fundTx.wait();
  console.log("2 ETH 전송 완료. 잔액:", ethers.formatEther(await provider.getBalance(sender)), "ETH");

  // ========================================
  // Step 3: 첫 번째 UserOp 구성 (계정 배포 + ETH 전송)
  // ========================================
  console.log("\n--- Step 3: 첫 번째 UserOp 구성 (계정 배포 + 0.1 ETH 전송) ---");

  const initCode = buildInitCode(addresses.simpleAccountFactory, owner.address, 0n);
  const callData = encodeExecute(recipient.address, parseEther("0.1"), "0x");

  const verificationGasLimit = 500000n;
  const callGasLimit = 200000n;
  const preVerificationGas = 100000n;
  const maxPriorityFeePerGas = ethers.parseUnits("1", "gwei");
  const maxFeePerGas = ethers.parseUnits("2", "gwei");
  const pmValidationGas = 100000n;
  const pmPostOpGas = 50000n;

  const abiCoder = AbiCoder.defaultAbiCoder();
  const encodedTimestamps = abiCoder.encode(["uint48", "uint48"], [0, 0]);
  const dummySignature = "0x" + "00".repeat(65);

  const paymasterAndDataDummy = solidityPacked(
    ["address", "uint128", "uint128", "bytes", "bytes"],
    [addresses.verifyingPaymaster, pmValidationGas, pmPostOpGas, encodedTimestamps, dummySignature]
  );

  let userOp: PackedUserOperation = {
    sender,
    nonce: 0n,
    initCode,
    callData,
    accountGasLimits: packAccountGasLimits(verificationGasLimit, callGasLimit),
    preVerificationGas,
    gasFees: packGasFees(maxPriorityFeePerGas, maxFeePerGas),
    paymasterAndData: paymasterAndDataDummy,
    signature: "0x",
  };

  // ========================================
  // Step 4: Paymaster 서명
  // ========================================
  console.log("\n--- Step 4: Paymaster 서명 ---");
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
  console.log("Paymaster 서명 완료:", pmSignature.slice(0, 20) + "...");

  userOp.paymasterAndData = solidityPacked(
    ["address", "uint128", "uint128", "bytes", "bytes"],
    [addresses.verifyingPaymaster, pmValidationGas, pmPostOpGas, encodedTimestamps, pmSignature]
  );

  // ========================================
  // Step 5: Owner 서명
  // ========================================
  console.log("\n--- Step 5: Owner 서명 ---");
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
  console.log("Owner 서명 완료:", userOp.signature.slice(0, 20) + "...");

  // ========================================
  // Step 6: EntryPoint에 직접 제출 (또는 번들러 사용)
  // ========================================
  console.log("\n--- Step 6: EntryPoint.handleOps 실행 ---");
  const recipientBalanceBefore = await provider.getBalance(recipient.address);

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
  console.log("트랜잭션 해시:", receipt!.hash);
  console.log("Gas used:", receipt!.gasUsed.toString());

  // ========================================
  // Step 7: 결과 검증
  // ========================================
  console.log("\n--- Step 7: 결과 검증 ---");

  // 스마트 계정 배포 확인
  const deployedCode = await provider.getCode(sender);
  console.log("스마트 계정 배포됨:", deployedCode !== "0x" ? "YES" : "NO");

  // ETH 전송 확인
  const recipientBalanceAfter = await provider.getBalance(recipient.address);
  const transferred = recipientBalanceAfter - recipientBalanceBefore;
  console.log("Recipient에게 전송된 ETH:", ethers.formatEther(transferred), "ETH");

  // UserOperationEvent 확인
  for (const log of receipt!.logs) {
    try {
      const parsed = entryPoint.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "UserOperationEvent") {
        console.log("\nUserOperationEvent:");
        console.log("  userOpHash:", parsed.args.userOpHash);
        console.log("  sender:", parsed.args.sender);
        console.log("  paymaster:", parsed.args.paymaster);
        console.log("  success:", parsed.args.success);
        console.log("  actualGasCost:", ethers.formatEther(parsed.args.actualGasCost), "ETH");
      }
    } catch {}
  }

  // ========================================
  // Step 8: 두 번째 UserOp (배포 후 추가 트랜잭션)
  // ========================================
  console.log("\n\n--- Step 8: 두 번째 UserOp (0.2 ETH 전송) ---");

  const nonce2 = await entryPoint.getNonce(sender, 0);
  console.log("현재 nonce:", nonce2.toString());

  const callData2 = encodeExecute(recipient.address, parseEther("0.2"), "0x");

  const paymasterAndDataDummy2 = solidityPacked(
    ["address", "uint128", "uint128", "bytes", "bytes"],
    [addresses.verifyingPaymaster, pmValidationGas, pmPostOpGas, encodedTimestamps, dummySignature]
  );

  let userOp2: PackedUserOperation = {
    sender,
    nonce: nonce2,
    initCode: "0x", // 이미 배포됨
    callData: callData2,
    accountGasLimits: packAccountGasLimits(200000n, 200000n),
    preVerificationGas: 100000n,
    gasFees: packGasFees(maxPriorityFeePerGas, maxFeePerGas),
    paymasterAndData: paymasterAndDataDummy2,
    signature: "0x",
  };

  // Paymaster 서명
  const pmHash2 = await paymaster.getHash(
    {
      sender: userOp2.sender,
      nonce: userOp2.nonce,
      initCode: userOp2.initCode,
      callData: userOp2.callData,
      accountGasLimits: userOp2.accountGasLimits,
      preVerificationGas: userOp2.preVerificationGas,
      gasFees: userOp2.gasFees,
      paymasterAndData: userOp2.paymasterAndData,
      signature: userOp2.signature,
    },
    0, 0
  );
  const pmSig2 = await paymasterSigner.signMessage(getBytes(pmHash2));
  userOp2.paymasterAndData = solidityPacked(
    ["address", "uint128", "uint128", "bytes", "bytes"],
    [addresses.verifyingPaymaster, pmValidationGas, pmPostOpGas, encodedTimestamps, pmSig2]
  );

  // Owner 서명
  const opHash2 = await entryPoint.getUserOpHash({
    sender: userOp2.sender,
    nonce: userOp2.nonce,
    initCode: userOp2.initCode,
    callData: userOp2.callData,
    accountGasLimits: userOp2.accountGasLimits,
    preVerificationGas: userOp2.preVerificationGas,
    gasFees: userOp2.gasFees,
    paymasterAndData: userOp2.paymasterAndData,
    signature: userOp2.signature,
  });
  userOp2.signature = await owner.signMessage(getBytes(opHash2));

  // 실행
  const recipientBefore2 = await provider.getBalance(recipient.address);
  const tx2 = await entryPoint.handleOps(
    [{
      sender: userOp2.sender,
      nonce: userOp2.nonce,
      initCode: userOp2.initCode,
      callData: userOp2.callData,
      accountGasLimits: userOp2.accountGasLimits,
      preVerificationGas: userOp2.preVerificationGas,
      gasFees: userOp2.gasFees,
      paymasterAndData: userOp2.paymasterAndData,
      signature: userOp2.signature,
    }],
    bundler.address
  );
  const receipt2 = await tx2.wait();
  const recipientAfter2 = await provider.getBalance(recipient.address);
  console.log("두 번째 UserOp 성공! 전송된 ETH:", ethers.formatEther(recipientAfter2 - recipientBefore2));
  console.log("Gas used:", receipt2!.gasUsed.toString());

  console.log("\n=== 전체 플로우 테스트 완료! ===");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
