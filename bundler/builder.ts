import { ethers } from "ethers";
import { Mempool } from "./mempool";

// EntryPoint ABI (handleOps만 필요)
const ENTRYPOINT_ABI = [
  "function handleOps(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address payable beneficiary)",
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
];

/**
 * 번들 빌더: 메모리풀에서 UserOp을 가져와 EntryPoint.handleOps에 제출
 */
export class BundleBuilder {
  private entryPoint: ethers.Contract;
  private bundlerWallet: ethers.Wallet;
  private mempool: Mempool;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    entryPointAddress: string,
    bundlerWallet: ethers.Wallet,
    mempool: Mempool
  ) {
    this.entryPoint = new ethers.Contract(
      entryPointAddress,
      ENTRYPOINT_ABI,
      bundlerWallet
    );
    this.bundlerWallet = bundlerWallet;
    this.mempool = mempool;
  }

  /**
   * 주기적으로 번들 제출 시작
   */
  start(intervalMs: number = 3000): void {
    console.log(`[Builder] ${intervalMs}ms 간격으로 번들 빌더 시작`);
    this.intervalId = setInterval(() => this.tryBuild(), intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[Builder] 번들 빌더 중지됨");
    }
  }

  /**
   * 즉시 번들 제출 시도
   */
  async tryBuild(): Promise<string | null> {
    const ops = this.mempool.drain();
    if (ops.length === 0) {
      return null;
    }

    console.log(`[Builder] ${ops.length}개의 UserOp 번들 제출 중...`);

    try {
      // UserOp당 가스 합산으로 gasLimit 계산
      // (verificationGas + callGas + preVerificationGas + paymasterGas) * ops 수 + 오버헤드
      const gasPerOp = 1_000_000n;
      const gasLimit = gasPerOp * BigInt(ops.length) + 100_000n;

      const tx = await this.entryPoint.handleOps(
        ops.map((op) => ({
          sender: op.sender,
          nonce: op.nonce,
          initCode: op.initCode,
          callData: op.callData,
          accountGasLimits: op.accountGasLimits,
          preVerificationGas: op.preVerificationGas,
          gasFees: op.gasFees,
          paymasterAndData: op.paymasterAndData,
          signature: op.signature,
        })),
        this.bundlerWallet.address, // beneficiary
        { gasLimit }
      );

      console.log(`[Builder] 트랜잭션 전송됨: ${tx.hash}`);

      const receipt = await tx.wait();
      console.log(`[Builder] 트랜잭션 확인됨! Gas used: ${receipt!.gasUsed}`);

      // UserOperationEvent 로그 파싱
      for (const log of receipt!.logs) {
        try {
          const parsed = this.entryPoint.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          if (parsed && parsed.name === "UserOperationEvent") {
            console.log(`[Builder] UserOp 성공 - sender: ${parsed.args.sender}, success: ${parsed.args.success}`);
          }
        } catch {
          // 다른 이벤트는 무시
        }
      }

      return tx.hash;
    } catch (error: any) {
      console.error("[Builder] 번들 제출 실패:", error.message);
      // revert reason 파싱 시도
      if (error.data) {
        try {
          const reason = ethers.toUtf8String("0x" + error.data.slice(138));
          console.error("[Builder] Revert reason:", reason);
        } catch {
          console.error("[Builder] Raw error data:", error.data);
        }
      }
      return null;
    }
  }
}
