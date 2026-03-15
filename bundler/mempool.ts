import { PackedUserOperation } from "../lib/types";

/**
 * 간단한 인메모리 UserOperation 메모리풀
 */
export class Mempool {
  private ops: PackedUserOperation[] = [];

  add(op: PackedUserOperation): void {
    this.ops.push(op);
    console.log(`[Mempool] UserOp 추가됨 (sender: ${op.sender}). 대기 중: ${this.ops.length}`);
  }

  drain(): PackedUserOperation[] {
    const pending = [...this.ops];
    this.ops = [];
    return pending;
  }

  size(): number {
    return this.ops.length;
  }
}
