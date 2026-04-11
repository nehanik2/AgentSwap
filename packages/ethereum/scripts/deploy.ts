/**
 * Hardhat deployment script for HashedTimelockETH.
 * Run via: pnpm --filter @agentswap/ethereum deploy:local
 *
 * On success, writes the contract address to ../../.env.local so other
 * packages can pick it up without manual copy-paste.
 */

import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("Deploying HashedTimelockETH...");
  console.log("  Deployer:", deployer.address);
  console.log("  Balance: ", ethers.formatEther(balance), "ETH");

  const Factory = await ethers.getContractFactory("HashedTimelockETH");
  const htlc = await Factory.deploy();
  await htlc.waitForDeployment();

  const address = await htlc.getAddress();
  console.log("✅ HashedTimelockETH deployed at:", address);

  // Write address to .env.local so start-demo.sh can source it
  const envPath = path.resolve(__dirname, "../../../.env.local");
  const line = `\nETH_HTLC_CONTRACT_ADDRESS=${address}\n`;

  if (fs.existsSync(envPath)) {
    const existing = fs.readFileSync(envPath, "utf8");
    // Replace existing line or append
    if (existing.includes("ETH_HTLC_CONTRACT_ADDRESS=")) {
      fs.writeFileSync(envPath, existing.replace(/ETH_HTLC_CONTRACT_ADDRESS=.*/g, `ETH_HTLC_CONTRACT_ADDRESS=${address}`));
    } else {
      fs.appendFileSync(envPath, line);
    }
  } else {
    fs.writeFileSync(envPath, line);
  }

  console.log("  Address written to .env.local");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
