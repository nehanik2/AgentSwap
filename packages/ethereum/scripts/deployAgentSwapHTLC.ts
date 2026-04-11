/**
 * Hardhat deployment script for AgentSwapHTLC.
 *
 * Usage:
 *   pnpm --filter @agentswap/ethereum deploy:agentswap          # Ganache
 *   pnpm --filter @agentswap/ethereum deploy:agentswap:sepolia   # Sepolia
 *
 * On success this script:
 *   1. Logs the deployed contract address to stdout.
 *   2. Writes / updates packages/ethereum/deployments/{network}.json with full
 *      deployment metadata (address, deployer, block, timestamp, tx hash).
 *   3. Writes / updates ../../.env.local with AGENTSWAP_HTLC_CONTRACT_ADDRESS
 *      so start-demo.sh and other packages can pick it up without manual edits.
 */

import hre, { ethers } from "hardhat";
import fs from "fs";
import path from "path";

interface DeploymentRecord {
  contract: string;
  address: string;
  deployer: string;
  network: string;
  chainId: number;
  blockNumber: number;
  txHash: string;
  deployedAt: string;
}

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  const network = hre.network.name;
  const { chainId } = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("=".repeat(60));
  console.log("  Deploying AgentSwapHTLC");
  console.log("=".repeat(60));
  console.log("  Network  :", network, `(chainId ${chainId})`);
  console.log("  Deployer :", deployer.address);
  console.log("  Balance  :", ethers.formatEther(balance), "ETH");
  console.log();

  const Factory = await ethers.getContractFactory("AgentSwapHTLC");
  const htlc = await Factory.deploy();
  await htlc.waitForDeployment();

  const address = await htlc.getAddress();
  const deployTx = htlc.deploymentTransaction();
  if (!deployTx) throw new Error("Deployment transaction not found");

  const receipt = await deployTx.wait(1);
  if (!receipt) throw new Error("Deployment receipt not found");

  console.log("✅ AgentSwapHTLC deployed");
  console.log("   Address     :", address);
  console.log("   Tx hash     :", receipt.hash);
  console.log("   Block       :", receipt.blockNumber);
  console.log();

  // ── 1. Write deployments/{network}.json ──────────────────────────────────

  const deploymentsDir = path.resolve(__dirname, "../deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });

  const outPath = path.join(deploymentsDir, `${network}.json`);

  // Read existing records (array) so we can append rather than overwrite history.
  let records: DeploymentRecord[] = [];
  if (fs.existsSync(outPath)) {
    try {
      records = JSON.parse(fs.readFileSync(outPath, "utf8")) as DeploymentRecord[];
    } catch {
      records = [];
    }
  }

  const record: DeploymentRecord = {
    contract: "AgentSwapHTLC",
    address,
    deployer: deployer.address,
    network,
    chainId: Number(chainId),
    blockNumber: receipt.blockNumber,
    txHash: receipt.hash,
    deployedAt: new Date().toISOString(),
  };

  // Replace latest record for this contract or push a new one.
  const existingIdx = records.findIndex((r) => r.contract === "AgentSwapHTLC");
  if (existingIdx >= 0) {
    records[existingIdx] = record;
  } else {
    records.push(record);
  }

  fs.writeFileSync(outPath, JSON.stringify(records, null, 2) + "\n");
  console.log("   Deployment record saved to:", path.relative(process.cwd(), outPath));

  // ── 2. Update .env.local ─────────────────────────────────────────────────

  const envLocalPath = path.resolve(__dirname, "../../../.env.local");
  const envKey = "AGENTSWAP_HTLC_CONTRACT_ADDRESS";
  const envLine = `${envKey}=${address}`;

  if (fs.existsSync(envLocalPath)) {
    const existing = fs.readFileSync(envLocalPath, "utf8");
    const updated = existing.includes(`${envKey}=`)
      ? existing.replace(new RegExp(`${envKey}=.*`), envLine)
      : existing.trimEnd() + "\n" + envLine + "\n";
    fs.writeFileSync(envLocalPath, updated);
  } else {
    fs.writeFileSync(envLocalPath, envLine + "\n");
  }

  console.log(`   ${envKey} written to .env.local`);
  console.log();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
