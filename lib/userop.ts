import { ethers, AbiCoder, solidityPacked, keccak256, getBytes } from "ethers";
import { PackedUserOperation } from "./types";

/**
 * verificationGasLimit(상위 128비트) + callGasLimit(하위 128비트)를 bytes32로 패킹
 */
export function packAccountGasLimits(
  verificationGasLimit: bigint,
  callGasLimit: bigint
): string {
  return solidityPacked(
    ["uint128", "uint128"],
    [verificationGasLimit, callGasLimit]
  );
}

/**
 * maxPriorityFeePerGas(상위 128비트) + maxFeePerGas(하위 128비트)를 bytes32로 패킹
 */
export function packGasFees(
  maxPriorityFeePerGas: bigint,
  maxFeePerGas: bigint
): string {
  return solidityPacked(
    ["uint128", "uint128"],
    [maxPriorityFeePerGas, maxFeePerGas]
  );
}

/**
 * paymasterAndData 필드 구성:
 * [20B paymaster address][16B validationGas][16B postOpGas][paymaster-specific data]
 */
export function buildPaymasterAndData(
  paymasterAddress: string,
  paymasterValidationGasLimit: bigint,
  paymasterPostOpGasLimit: bigint,
  validUntil: number,
  validAfter: number,
  signature: string = "0x" + "00".repeat(65) // dummy signature
): string {
  const abiCoder = AbiCoder.defaultAbiCoder();
  const encodedTimestamps = abiCoder.encode(
    ["uint48", "uint48"],
    [validUntil, validAfter]
  );

  return solidityPacked(
    ["address", "uint128", "uint128", "bytes", "bytes"],
    [
      paymasterAddress,
      paymasterValidationGasLimit,
      paymasterPostOpGasLimit,
      encodedTimestamps,
      signature,
    ]
  );
}

/**
 * initCode 구성: factory address + createAccount calldata
 */
export function buildInitCode(
  factoryAddress: string,
  ownerAddress: string,
  salt: bigint = 0n
): string {
  const iface = new ethers.Interface([
    "function createAccount(address owner, uint256 salt) returns (address)",
  ]);
  const createAccountData = iface.encodeFunctionData("createAccount", [
    ownerAddress,
    salt,
  ]);
  return solidityPacked(["address", "bytes"], [factoryAddress, createAccountData]);
}

/**
 * PackedUserOperation의 해시를 계산 (off-chain)
 * EntryPoint의 getUserOpHash와 동일한 결과를 반환
 */
export function getUserOpHash(
  userOp: PackedUserOperation,
  entryPointAddress: string,
  chainId: bigint
): string {
  const abiCoder = AbiCoder.defaultAbiCoder();

  // 내부 해시: userOp의 각 필드를 인코딩
  const packedUserOp = abiCoder.encode(
    [
      "address",
      "uint256",
      "bytes32",
      "bytes32",
      "bytes32",
      "uint256",
      "bytes32",
      "bytes32",
    ],
    [
      userOp.sender,
      userOp.nonce,
      keccak256(userOp.initCode),
      keccak256(userOp.callData),
      userOp.accountGasLimits,
      userOp.preVerificationGas,
      keccak256(userOp.paymasterAndData),
      userOp.gasFees,
    ]
  );

  const userOpHash = keccak256(packedUserOp);

  // 최종 해시: userOpHash + entryPoint + chainId
  return keccak256(
    abiCoder.encode(
      ["bytes32", "address", "uint256"],
      [userOpHash, entryPointAddress, chainId]
    )
  );
}

/**
 * SimpleAccount의 execute 함수 calldata 생성
 */
export function encodeExecute(
  target: string,
  value: bigint,
  data: string
): string {
  const iface = new ethers.Interface([
    "function execute(address dest, uint256 value, bytes calldata func)",
  ]);
  return iface.encodeFunctionData("execute", [target, value, data]);
}
