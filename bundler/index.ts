import express from "express";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { Mempool } from "./mempool";
import { BundleBuilder } from "./builder";
import { PackedUserOperation, DeployedAddresses } from "../lib/types";
import { getUserOpHash } from "../lib/userop";

const PORT = 4337;
const RPC_URL = "http://127.0.0.1:8545";

// Hardhat 기본 계정 #2를 번들러 지갑으로 사용
// Account #2: 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
const BUNDLER_PRIVATE_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

async function main() {
  // 배포된 주소 로드
  const addressesPath = path.join(__dirname, "..", "deployments", "addresses.json");
  if (!fs.existsSync(addressesPath)) {
    console.error("deployments/addresses.json이 없습니다. 먼저 'npm run deploy'를 실행하세요.");
    process.exit(1);
  }
  const addresses: DeployedAddresses = JSON.parse(fs.readFileSync(addressesPath, "utf-8"));

  // Provider & Wallet 설정
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const bundlerWallet = new ethers.Wallet(BUNDLER_PRIVATE_KEY, provider);
  const chainId = (await provider.getNetwork()).chainId;

  console.log(`[Bundler] Chain ID: ${chainId}`);
  console.log(`[Bundler] EntryPoint: ${addresses.entryPoint}`);
  console.log(`[Bundler] Bundler wallet: ${bundlerWallet.address}`);

  // Mempool & Builder 초기화
  const mempool = new Mempool();
  const builder = new BundleBuilder(addresses.entryPoint, bundlerWallet, mempool);

  // Express 서버 설정
  const app = express();
  app.use(express.json());

  app.post("/", async (req, res) => {
    const { jsonrpc, id, method, params } = req.body;

    if (jsonrpc !== "2.0") {
      return res.json({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid JSON-RPC" } });
    }

    try {
      switch (method) {
        case "eth_sendUserOperation": {
          const [userOpRaw, entryPointAddr] = params;

          if (entryPointAddr.toLowerCase() !== addresses.entryPoint.toLowerCase()) {
            return res.json({
              jsonrpc: "2.0", id,
              error: { code: -32602, message: "Unsupported EntryPoint" },
            });
          }

          const userOp: PackedUserOperation = {
            sender: userOpRaw.sender,
            nonce: BigInt(userOpRaw.nonce),
            initCode: userOpRaw.initCode,
            callData: userOpRaw.callData,
            accountGasLimits: userOpRaw.accountGasLimits,
            preVerificationGas: BigInt(userOpRaw.preVerificationGas),
            gasFees: userOpRaw.gasFees,
            paymasterAndData: userOpRaw.paymasterAndData,
            signature: userOpRaw.signature,
          };

          // UserOp 해시 계산
          const opHash = getUserOpHash(userOp, addresses.entryPoint, chainId);

          // 메모리풀에 추가
          mempool.add(userOp);

          // 즉시 번들 제출 시도
          await builder.tryBuild();

          return res.json({ jsonrpc: "2.0", id, result: opHash });
        }

        case "eth_supportedEntryPoints": {
          return res.json({ jsonrpc: "2.0", id, result: [addresses.entryPoint] });
        }

        case "eth_chainId": {
          return res.json({ jsonrpc: "2.0", id, result: `0x${chainId.toString(16)}` });
        }

        default:
          return res.json({
            jsonrpc: "2.0", id,
            error: { code: -32601, message: `Method not found: ${method}` },
          });
      }
    } catch (error: any) {
      console.error("[Bundler] Error:", error.message);
      return res.json({
        jsonrpc: "2.0", id,
        error: { code: -32000, message: error.message },
      });
    }
  });

  // 서버 시작
  app.listen(PORT, () => {
    console.log(`\n[Bundler] JSON-RPC 서버가 http://localhost:${PORT} 에서 실행 중`);
    console.log("[Bundler] 지원하는 메서드:");
    console.log("  - eth_sendUserOperation(userOp, entryPoint)");
    console.log("  - eth_supportedEntryPoints()");
    console.log("  - eth_chainId()");
    console.log("");
  });

  // 주기적 번들 빌더도 백그라운드에서 실행 (3초마다)
  builder.start(3000);
}

main().catch(console.error);
