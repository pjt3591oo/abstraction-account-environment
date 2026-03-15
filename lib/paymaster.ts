import { ethers, AbiCoder, getBytes, solidityPacked } from "ethers";
import { PackedUserOperation } from "./types";

/**
 * VerifyingPaymaster의 paymasterAndData를 구성하고 서명합니다.
 *
 * 플로우:
 * 1. paymasterAndData에 더미 서명을 넣은 UserOp 생성
 * 2. paymaster.getHash()로 해시 계산
 * 3. paymasterSigner가 해시에 서명
 * 4. 실제 서명으로 paymasterAndData 재구성
 */
export async function signPaymasterData(
  paymasterContract: ethers.Contract,
  paymasterSigner: ethers.Wallet,
  userOp: PackedUserOperation,
  validUntil: number,
  validAfter: number,
  paymasterValidationGasLimit: bigint,
  paymasterPostOpGasLimit: bigint
): Promise<string> {
  // 1. paymaster 컨트랙트에서 해시 가져오기
  const hash = await paymasterContract.getHash(
    userOpToStruct(userOp),
    validUntil,
    validAfter
  );

  // 2. paymasterSigner가 서명 (EIP-191 personal sign)
  const signature = await paymasterSigner.signMessage(getBytes(hash));

  // 3. 완전한 paymasterAndData 구성
  const abiCoder = AbiCoder.defaultAbiCoder();
  const encodedTimestamps = abiCoder.encode(
    ["uint48", "uint48"],
    [validUntil, validAfter]
  );

  const paymasterAddress = await paymasterContract.getAddress();

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
 * UserOp를 컨트랙트 호출 시 사용하는 구조체로 변환
 */
function userOpToStruct(userOp: PackedUserOperation) {
  return {
    sender: userOp.sender,
    nonce: userOp.nonce,
    initCode: userOp.initCode,
    callData: userOp.callData,
    accountGasLimits: userOp.accountGasLimits,
    preVerificationGas: userOp.preVerificationGas,
    gasFees: userOp.gasFees,
    paymasterAndData: userOp.paymasterAndData,
    signature: userOp.signature,
  };
}
