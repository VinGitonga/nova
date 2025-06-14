# Nova 🌟

Modernize group finance with Nova's decentralized AI Agent. Pool funds, vote fairly, and grow wealth as a community.

## Overview

Nova is a decentralized AI agent that revolutionizes traditional group finance (Chama) by leveraging blockchain technology and smart contracts. Powered by Coinbase's AI Agent Kit for secure crypto transactions and XMTP for seamless communication, Nova enables communities to pool funds, make collective decisions, and grow wealth together in a transparent and fair manner.

## Key Features

### 1. Smart Fund Pooling
- **Decentralized Contributions**: Members can contribute funds directly to the pool using their Ethereum wallets
- **Transparent Tracking**: Real-time visibility of individual contributions and pool size
- **Automated Processing**: Instant verification and processing of contributions via Coinbase AI Agent Kit
- **Fair Distribution**: Interest and profits are distributed proportionally based on contributions

### 2. Democratic Decision Making
- **Weighted Voting**: Voting power is proportional to contribution size
- **Transparent Proposals**: Clear visibility of all proposals and their status
- **Automated Execution**: Smart contract-based execution of approved decisions
- **Fair Governance**: 60% approval threshold ensures majority consensus

### 3. Smart Lending System
- **Automated Loan Processing**: AI-powered loan request evaluation
- **Fair Interest Rates**: Standardized 10% interest rate for all loans
- **Collateral Management**: 20% contribution requirement as collateral
- **Payment Tracking**: Automated tracking of loan payments and interest

### 4. Interest Distribution
- **Automated Calculations**: Smart calculation of interest shares
- **Fair Distribution**: Proportional distribution based on contribution size
- **Transparent Tracking**: Clear visibility of all distributions
- **Instant Processing**: Automated execution of interest payments

### 5. Investment Opportunities
- **Community Proposals**: Members can propose investment opportunities
- **Democratic Voting**: Community decides on investment proposals
- **Transparent Tracking**: Clear visibility of investment performance
- **Fair Profit Sharing**: Profits distributed proportionally to contributions


## Screenshots
[![Screenshot-2025-06-14-at-00-28-52.png](https://i.postimg.cc/25ZNjLpp/Screenshot-2025-06-14-at-00-28-52.png)](https://postimg.cc/8FN0t5Pw)

[![Screenshot-2025-06-14-at-00-29-06.png](https://i.postimg.cc/prkgcDjj/Screenshot-2025-06-14-at-00-29-06.png)](https://postimg.cc/q6hbz6jB)

[![Screenshot-2025-06-14-at-00-29-55.png](https://i.postimg.cc/761v0vYm/Screenshot-2025-06-14-at-00-29-55.png)](https://postimg.cc/R60bxDtH)

[![Screenshot-2025-06-14-at-00-30-04.png](https://i.postimg.cc/MHzCYsnx/Screenshot-2025-06-14-at-00-30-04.png)](https://postimg.cc/FdnCrVbn)

[![Screenshot-2025-06-14-at-00-30-20.png](https://i.postimg.cc/76r85PD5/Screenshot-2025-06-14-at-00-30-20.png)](https://postimg.cc/sBm08rMz)

[![Screenshot-2025-06-14-at-00-30-28.png](https://i.postimg.cc/9Xp5fjkf/Screenshot-2025-06-14-at-00-30-28.png)](https://postimg.cc/JtGdTSMw)

[![Screenshot-2025-06-14-at-00-30-35.png](https://i.postimg.cc/RVZr6DrL/Screenshot-2025-06-14-at-00-30-35.png)](https://postimg.cc/Sj31HVxn)


## Architecture 

[![Frame-1116607522.png](https://i.postimg.cc/MHBLfDh0/Frame-1116607522.png)](https://postimg.cc/SYydwWQj)


## Proof of Deployment
https://base-sepolia.blockscout.com/tx/0x538dfa8a3923eaedf39c7a208c50a90440d1734ab62e1cc3965a522c0e4a0250

## Technical Stack

### Core Technologies
- **Coinbase AI Agent Kit**: Powers secure crypto transactions
- **XMTP Protocol**: Enables real-time communication between users and the AI agent

### AI Integration
- **Transaction Verification**: Automated verification of blockchain transactions
- **Risk Assessment**: AI-powered loan and investment evaluation
- **Decision Support**: Smart suggestions for community decisions
- **Automated Processing**: Streamlined execution of approved actions

### Communication Layer
- **Real-time Updates**: Instant notifications via XMTP
- **Secure Messaging**: End-to-end encrypted communication
- **Transaction Status**: Live updates on contribution and loan status

## Getting Started

### Prerequisites
- Ethereum wallet (e.g., MetaMask, Coinbase)
- ETH for gas fees
- XMTP-enabled messaging client
- Node JS
- Bun

### Local Setup

1. Clone the repository:
```bash
git clone https://github.com/yourusername/nova.git
cd nova
```

2. Set up the server:
```bash
cd server
yarn install
```

3. Set up the client:
```bash
cd ../client
yarn install
```

4. Configure environment variables:

For the server (in `server` directory):
```bash
cp .env.example .env
```
Edit `.env` with your configuration:
- `NETWORK_ID`: Your network ID
- `OPENAI_API_KEY`: Your OpenAI API key
- `CDP_API_KEY_NAME`: Your CDP API key name
- `CDP_API_KEY`: Your CDP API key
- `CDP_API_KEY_PRIVATE_KEY`: Your CDP API private key
- `XMTP_ENV`: XMTP environment (default: dev)
- `WALLET_KEY`: Your wallet key
- `ENCRYPTION_KEY`: Your encryption key
- `CDP_WALLET_SECRET`: Your CDP wallet secret
- `WALLET_MNEMONIC_PHRASE`: Your wallet mnemonic phrase
- `TELEGRAM_BOT_TOKEN`: Your Telegram bot token
- `COINGECKO_API_KEY`: Your CoinGecko API key

For the client (in `client` directory):

Create a `.env` with your configuration:
- `NEXT_PUBLIC_ONCHAINKIT_API_KEY`: Your Onchainkit API Key from Coinbase developer portal.

5. Start the development servers:

In one terminal (server):
```bash
cd server
bun --watch app.ts
```

In another terminal (client):
```bash
cd client
yarn dev
```

6. Access the application:
- Frontend: http://localhost:3000