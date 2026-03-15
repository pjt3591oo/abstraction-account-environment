import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { DeployedAddresses } from "../lib/types";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  // 1. EntryPoint 배포
  console.log("\n--- EntryPoint 배포 ---");
  const EntryPoint = await ethers.getContractFactory("EntryPoint");
  const entryPoint = await EntryPoint.deploy();
  await entryPoint.waitForDeployment();
  const entryPointAddress = await entryPoint.getAddress();
  console.log("EntryPoint:", entryPointAddress);

  // 2. SimpleAccountFactory 배포
  console.log("\n--- SimpleAccountFactory 배포 ---");
  const SimpleAccountFactory = await ethers.getContractFactory("SimpleAccountFactory");
  const factory = await SimpleAccountFactory.deploy(entryPointAddress);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("SimpleAccountFactory:", factoryAddress);

  // 3. VerifyingPaymaster 배포
  // Paymaster signer: Hardhat의 두 번째 계정 사용
  const signers = await ethers.getSigners();
  const paymasterSigner = signers[1];
  console.log("\n--- VerifyingPaymaster 배포 ---");
  console.log("Paymaster Signer:", paymasterSigner.address);

  const VerifyingPaymaster = await ethers.getContractFactory("VerifyingPaymaster");
  const paymaster = await VerifyingPaymaster.deploy(entryPointAddress, paymasterSigner.address);
  await paymaster.waitForDeployment();
  const paymasterAddress = await paymaster.getAddress();
  console.log("VerifyingPaymaster:", paymasterAddress);

  // 4. Paymaster에 ETH 예치 (EntryPoint를 통해)
  console.log("\n--- Paymaster 자금 예치 ---");
  const depositTx = await entryPoint.depositTo(paymasterAddress, {
    value: ethers.parseEther("10"),
  });
  await depositTx.wait();
  const depositInfo = await entryPoint.getDepositInfo(paymasterAddress);
  console.log("Paymaster deposit:", ethers.formatEther(depositInfo.deposit), "ETH");

  // 5. Paymaster 스테이킹
  console.log("\n--- Paymaster 스테이킹 ---");
  const stakeTx = await paymaster.addStake(1, {
    value: ethers.parseEther("1"),
  });
  await stakeTx.wait();
  console.log("Paymaster staked: 1 ETH (unstake delay: 1 sec)");

  // 6. 배포 주소 저장
  const addresses: DeployedAddresses = {
    entryPoint: entryPointAddress,
    simpleAccountFactory: factoryAddress,
    verifyingPaymaster: paymasterAddress,
    paymasterSigner: paymasterSigner.address,
  };

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(deploymentsDir, "addresses.json"),
    JSON.stringify(addresses, null, 2)
  );

  console.log("\n=== 배포 완료 ===");
  console.log(JSON.stringify(addresses, null, 2));
  console.log("\n주소가 deployments/addresses.json에 저장되었습니다.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
