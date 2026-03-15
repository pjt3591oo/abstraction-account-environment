/**
 * 번들러 서버(port 4337)를 경유하여 UserOperation을 제출하는 클라이언트 스크립트
 *
 * 사전 조건:
 *   1. npx hardhat node          (로컬 노드)
 *   2. npm run deploy            (컨트랙트 배포)
 *   3. npm run bundler           (번들러 서버)
 */
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

const BUNDLER_URL = "http://localhost:4337";

/** 번들러에 JSON-RPC 요청 */
async function rpcCall(method: string, params: any[] = []): Promise<any> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params });
  const res = await fetch(BUNDLER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const json = await res.json();
  if (json.error) {
    throw new Error(`RPC error [${json.error.code}]: ${json.error.message}`);
  }
  return json.result;
}

/** UserOp의 bigint 필드를 hex string으로 변환 (JSON 직렬화용) */
function serializeUserOp(op: PackedUserOperation) {
  return {
    sender: op.sender,
    nonce: "0x" + op.nonce.toString(16),
    initCode: op.initCode,
    callData: op.callData,
    accountGasLimits: op.accountGasLimits,
    preVerificationGas: "0x" + op.preVerificationGas.toString(16),
    gasFees: op.gasFees,
    paymasterAndData: op.paymasterAndData,
    signature: op.signature,
  };
}

async function main() {
  // 배포된 주소 로드
  const addressesPath = path.join(__dirname, "..", "deployments", "addresses.json");
  if (!fs.existsSync(addressesPath)) {
    console.error("ERROR: deployments/addresses.json이 없습니다.");
    console.error("먼저 다음을 실행하세요:");
    console.error("  1. npm run node");
    console.error("  2. npm run deploy");
    console.error("  3. npm run bundler");
    process.exit(1);
  }
  const addresses: DeployedAddresses = JSON.parse(fs.readFileSync(addressesPath, "utf-8"));

  const provider = ethers.provider;
  const signers = await ethers.getSigners();
  const funder = signers[0];
  const paymasterSigner = signers[1];
  const recipient = signers[5];

  // 새 owner 지갑
  const owner = Wallet.createRandom().connect(provider);

  console.log("=== 번들러 인프라 테스트 ===\n");

  // ──────────────────────────────────────
  // Step 1: 번들러 health check
  // ──────────────────────────────────────
  console.log("--- Step 1: 번들러 연결 확인 ---");
  try {
    const entryPoints = await rpcCall("eth_supportedEntryPoints");
    console.log("  지원 EntryPoint:", entryPoints);
    const chainId = await rpcCall("eth_chainId");
    console.log("  Chain ID:", chainId);
  } catch (e: any) {
    console.error("  번들러 연결 실패:", e.message);
    console.error("  번들러가 실행 중인지 확인하세요: npm run bundler");
    process.exit(1);
  }

  // ──────────────────────────────────────
  // Step 2: 컨트랙트 인스턴스 & 카운터팩추얼 주소
  // ──────────────────────────────────────
  console.log("\n--- Step 2: 스마트 계정 주소 계산 ---");
  const entryPoint = await ethers.getContractAt("EntryPoint", addresses.entryPoint);
  const factory = await ethers.getContractAt("SimpleAccountFactory", addresses.simpleAccountFactory);
  const paymaster = await ethers.getContractAt("VerifyingPaymaster", addresses.verifyingPaymaster);

  const sender = await factory["getAddress(address,uint256)"](owner.address, 0);
  console.log("  Owner EOA:", owner.address);
  console.log("  Smart Account (counterfactual):", sender);

  // 스마트 계정에 ETH 전송
  const fundTx = await funder.sendTransaction({ to: sender, value: parseEther("2") });
  await fundTx.wait();
  console.log("  Smart Account에 2 ETH 전송 완료");

  // ──────────────────────────────────────
  // Step 3: 첫 번째 UserOp (계정 배포 + ETH 전송) → 번들러 제출
  // ──────────────────────────────────────
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

  // Paymaster 서명
  console.log("  Paymaster 서명 중...");
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
  const pmSig = await paymasterSigner.signMessage(getBytes(pmHash));
  userOp.paymasterAndData = solidityPacked(
    ["address", "uint128", "uint128", "bytes", "bytes"],
    [addresses.verifyingPaymaster, pmValidationGas, pmPostOpGas, encodedTimestamps, pmSig]
  );

  // Owner 서명
  console.log("  Owner 서명 중...");
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

  // 번들러에 제출
  console.log("  번들러에 UserOp 제출 중...");
  const recipientBefore = await provider.getBalance(recipient.address);

  const opHash1 = await rpcCall("eth_sendUserOperation", [
    serializeUserOp(userOp),
    addresses.entryPoint,
  ]);
  console.log("  번들러 응답 - UserOp Hash:", opHash1);

  // 처리 대기 (번들러가 handleOps 호출 후 블록에 포함될 때까지)
  await new Promise((r) => setTimeout(r, 2000));

  // ──────────────────────────────────────
  // Step 4: 결과 검증
  // ──────────────────────────────────────
  console.log("\n--- Step 4: 첫 번째 UserOp 결과 검증 ---");

  const code = await provider.getCode(sender);
  const deployed = code !== "0x";
  console.log("  스마트 계정 배포됨:", deployed ? "YES" : "NO");

  const recipientAfter = await provider.getBalance(recipient.address);
  const transferred = recipientAfter - recipientBefore;
  console.log("  Recipient에게 전송된 ETH:", ethers.formatEther(transferred));

  if (!deployed) {
    console.error("\n  FAIL: 스마트 계정이 배포되지 않았습니다.");
    process.exit(1);
  }
  if (transferred !== parseEther("0.1")) {
    console.error("\n  FAIL: ETH 전송 금액이 일치하지 않습니다.");
    process.exit(1);
  }
  console.log("  PASS");

  // ──────────────────────────────────────
  // Step 5: 두 번째 UserOp (배포 후 트랜잭션) → 번들러 제출
  // ──────────────────────────────────────
  console.log("\n--- Step 5: 두 번째 UserOp (0.2 ETH 전송) ---");

  const nonce2 = await entryPoint.getNonce(sender, 0);
  console.log("  현재 nonce:", nonce2.toString());

  const callData2 = encodeExecute(recipient.address, parseEther("0.2"), "0x");

  const pmAndDataDummy2 = solidityPacked(
    ["address", "uint128", "uint128", "bytes", "bytes"],
    [addresses.verifyingPaymaster, pmValidationGas, pmPostOpGas, encodedTimestamps, dummySignature]
  );

  let userOp2: PackedUserOperation = {
    sender,
    nonce: nonce2,
    initCode: "0x",
    callData: callData2,
    accountGasLimits: packAccountGasLimits(200000n, 200000n),
    preVerificationGas: 100000n,
    gasFees: packGasFees(maxPriorityFeePerGas, maxFeePerGas),
    paymasterAndData: pmAndDataDummy2,
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
  const opHash2Raw = await entryPoint.getUserOpHash({
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
  userOp2.signature = await owner.signMessage(getBytes(opHash2Raw));

  // 번들러에 제출
  console.log("  번들러에 UserOp 제출 중...");
  const recipientBefore2 = await provider.getBalance(recipient.address);

  const opHash2 = await rpcCall("eth_sendUserOperation", [
    serializeUserOp(userOp2),
    addresses.entryPoint,
  ]);
  console.log("  번들러 응답 - UserOp Hash:", opHash2);

  await new Promise((r) => setTimeout(r, 2000));

  // ──────────────────────────────────────
  // Step 6: 두 번째 UserOp 결과 검증
  // ──────────────────────────────────────
  console.log("\n--- Step 6: 두 번째 UserOp 결과 검증 ---");

  const recipientAfter2 = await provider.getBalance(recipient.address);
  const transferred2 = recipientAfter2 - recipientBefore2;
  console.log("  Recipient에게 전송된 ETH:", ethers.formatEther(transferred2));

  const finalNonce = await entryPoint.getNonce(sender, 0);
  console.log("  최종 nonce:", finalNonce.toString());

  if (transferred2 !== parseEther("0.2")) {
    console.error("\n  FAIL: 두 번째 ETH 전송 금액이 일치하지 않습니다.");
    process.exit(1);
  }
  console.log("  PASS");

  // ──────────────────────────────────────
  // 최종 요약
  // ──────────────────────────────────────
  console.log("\n=== 인프라 테스트 결과 ===");
  console.log("  [PASS] 번들러 연결 (eth_supportedEntryPoints, eth_chainId)");
  console.log("  [PASS] 첫 번째 UserOp: 계정 배포 + 0.1 ETH 전송 (번들러 경유)");
  console.log("  [PASS] 두 번째 UserOp: 0.2 ETH 전송 (번들러 경유)");
  console.log("  [PASS] Paymaster 가스비 대납 정상 동작");
  console.log("\n  모든 인프라 테스트 통과!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
