import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  networks: {
    // Ganache running via docker-compose (pnpm docker:up)
    localhost: {
      url: process.env.ETH_RPC_URL ?? "http://localhost:8545",
      chainId: 1337,
      // Ganache pre-funds deterministic accounts from the default mnemonic.
      // In CI / demo, override with the actual funded key from .env.
      accounts: process.env.ETH_BUYER_PRIVATE_KEY
        ? [process.env.ETH_BUYER_PRIVATE_KEY]
        : {
            mnemonic:
              "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
          },
    },
    // Ethereum Sepolia testnet — set SEPOLIA_RPC_URL + ETH_BUYER_PRIVATE_KEY in .env
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL ?? "",
      chainId: 11155111,
      accounts: process.env.ETH_BUYER_PRIVATE_KEY
        ? [process.env.ETH_BUYER_PRIVATE_KEY]
        : [],
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: {
    // Increase timeout for time-travel tests that mine extra blocks.
    timeout: 60_000,
  },
};

export default config;
