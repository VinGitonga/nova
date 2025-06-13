import { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import PouchDB from "pouchdb";
import { z } from "zod";
import { Address, Coinbase, Wallet, Amount } from "@coinbase/coinbase-sdk";
import { GROUP_WALLET_ADDRESS, WALLET_MNEMONIC_PHRASE } from "../constants";
import { convertWeiToUSD, getEthPriceToday } from "helpers";
import { Command } from "@langchain/langgraph";
import { ToolMessage } from "@langchain/core/messages";
import { BigNumber } from "bignumber.js";
import Decimal from "decimal.js";

interface IGroup {
	_id: "chama";
	_rev?: string;
	type: "group";
	name: string;
	totalPool: number;
}

interface IContribution {
	_id: string; // e.g., `contrib_${walletAddress}_${transactionHash}`
	_rev?: string; // PouchDB revision, optional
	type: "contribution";
	walletAddress: string;
	amountInWei: string; // Wei as string for precision
	amountInEth: number; // ETH for reference
	amountInUsd: number; // USD value at transaction time
	transactionHash?: string; // Transaction hash to prevent duplicates
	transactionTimestamp?: string; // ISO timestamp of transaction
	amount?: number; // Legacy field for backward compatibility
}

interface LoanPayment {
	amount: number;
	timestamp: string;
	transactionHash: string;
	interestAmount?: number; // Track interest portion of each payment
}

interface InterestDistribution {
	_id: string; // e.g., `interest_${loanId}_${timestamp}`
	_rev?: string;
	type: "interest_distribution";
	loanId: string;
	amount: number;
	timestamp: string;
	status: "pending" | "distributed";
	distributionDetails?: Array<{
		walletAddress: string;
		amount: number;
		transactionHash?: string;
	}>;
}

interface Loan {
	_id: string;
	_rev?: string;
	type: "loan";
	walletAddress: string;
	amount: number;
	collateral: number;
	interestRate: number;
	status: "pending" | "approved" | "rejected" | "paid";
	votes: Array<{ walletAddress: string; vote: boolean }>;
	paidAmount?: number;
	interestPaid?: number; // Track total interest paid
	payments?: LoanPayment[];
}

interface Investment {
	_id: string;
	_rev?: string;
	type: "investment";
	walletAddress: string;
	description: string;
	amount: number;
	status: "pending" | "approved" | "rejected";
	votes: Array<{ walletAddress: string; vote: boolean }>;
}

type ChamaDocument = IGroup | IContribution | Loan | Investment | InterestDistribution;

const db = new PouchDB<ChamaDocument>("chama");

export const groupSavingsTool = tool(
	async ({ amount, unit }) => {
		if (!amount || amount <= 0) {
			return "Amount must be positive.";
		}
		if (!["USD", "ETH"].includes(unit)) {
			return 'Unit must be "USD" or "ETH".';
		}

		// Fetch current ETH price in USD from CoinGecko
		let ethPriceInUSD: BigNumber;
		try {
			const response = await getEthPriceToday();
			ethPriceInUSD = new BigNumber(response);
		} catch (error) {
			console.error("Error fetching ETH price:", error);
			return "Failed to fetch ETH price. Please try again later.";
		}

		// Convert input amount to USD and ETH
		let usdAmount: BigNumber;
		let ethAmount: BigNumber;
		if (unit === "USD") {
			usdAmount = new BigNumber(amount);
			ethAmount = usdAmount.dividedBy(ethPriceInUSD);
		} else {
			ethAmount = new BigNumber(amount);
			usdAmount = ethAmount.multipliedBy(ethPriceInUSD);
		}

		return `To contribute ${unit === "USD" ? `$${usdAmount.toFixed(2)} USD` : `${ethAmount.toFixed(6)} ETH`} to the Chama pool, deposit ${ethAmount.toFixed(6)} ETH (equivalent to $${usdAmount.toFixed(
			2
		)} USD) to the group wallet address: ${GROUP_WALLET_ADDRESS}. After the transaction, use verifyGroupSavingTransactionHash with the transaction hash to confirm the deposit.`;
	},
	{
		name: "groupSavingsTool",
		description: "Advises users on the amount in ETH and USD to deposit to the Chama savings pool based on input in USD or ETH, and instructs them to verify the transaction using verifyGroupSavingTransactionHash.",
		schema: z.object({
			amount: z.number().positive().describe("Amount to deposit in the specified unit (USD or ETH)"),
			unit: z.enum(["USD", "ETH"]).describe("Unit of the amount (USD or ETH)"),
		}),
	}
);

export const verifyGroupSavingTransactionHash = tool(
	async ({ hash }, config: RunnableConfig) => {
		const walletAddress = config?.configurable?.walletAddress;
		if (!walletAddress) {
			return "Wallet address missing in configuration.";
		}

		// Fetch transactions for the group wallet
		const transactions = await getWalletTransactions(GROUP_WALLET_ADDRESS);

		// Find transaction by hash and verify it goes to the group wallet
		const transaction = transactions.data.find((item) => item.content().hash === hash && item.content().to.toLowerCase() === GROUP_WALLET_ADDRESS.toLowerCase());

		if (!transaction) {
			return `No transaction found with hash ${hash} for group wallet ${GROUP_WALLET_ADDRESS}.`;
		}

		const amountInWei = transaction.content().value;
		const from = transaction.content().from;
		const transactionTimestamp = transaction.content().block_timestamp;

		// Check for duplicate transaction
		const contribId = `contrib_${walletAddress}_${hash}`;
		try {
			const existingContrib = await db.get(contribId);
			if (existingContrib) {
				return `Transaction ${hash} has already been processed for wallet ${walletAddress}.`;
			}
		} catch (error) {
			if (error.status !== 404) {
				console.error("Error checking existing contribution:", error);
				return "Error verifying transaction uniqueness.";
			}
		}

		// Convert wei to USD (and ETH, assuming convertWeiToUSD returns both)
		let transactionAmts;
		try {
			transactionAmts = await convertWeiToUSD(amountInWei);
		} catch (error) {
			console.error("Error converting amount:", error);
			return "Failed to convert transaction amount to USD.";
		}

		// Save contribution to PouchDB
		const contribution: IContribution = {
			_id: contribId,
			type: "contribution",
			walletAddress: from,
			amountInWei,
			amountInEth: transactionAmts.ethAmount?.toNumber() || new BigNumber(amountInWei).dividedBy("1000000000000000000").toNumber(),
			amountInUsd: transactionAmts.usdAmount.toNumber(),
			transactionHash: hash,
			transactionTimestamp,
		};

		try {
			await db.put(contribution);
		} catch (error) {
			console.error("Error saving contribution:", error);
			return "Failed to save contribution to database.";
		}

		// Update group total pool
		let groupDoc: IGroup;
		try {
			groupDoc = (await db.get("chama").catch(
				() =>
					({
						_id: "chama",
						type: "group",
						name: "Chama",
						totalPool: 0,
					} as IGroup)
			)) as IGroup;

			groupDoc.totalPool += contribution.amountInUsd;
			await db.put(groupDoc);
		} catch (error) {
			console.error("Error updating group pool:", error);
			return "Failed to update group savings pool.";
		}

		return `Verified transaction ${hash}. Deposited ${contribution.amountInEth.toFixed(6)} ETH ($${contribution.amountInUsd.toFixed(2)} USD) to the Chama pool. Total pool: ${groupDoc.totalPool.toFixed(2)} USD.`;
	},
	{
		name: "verifyGroupSavingTransactionHash",
		description: "Verifies a group savings transaction deposit using a transaction hash, converts the amount to USD, and saves it to the database. Prevents duplicate processing of the same transaction.",
		schema: z.object({
			hash: z.string().describe("Transaction hash for the deposit to the group savings account"),
		}),
	}
);

async function getWalletTransactions(walletAddress: string) {
	const address = new Address("base-sepolia", walletAddress);

	let transactions = await address.listTransactions({ limit: 5 });
	return transactions;
}

async function getBalance() {
	const wallet = await Wallet.import({ mnemonicPhrase: WALLET_MNEMONIC_PHRASE });
	const balance = await wallet.getBalance(Coinbase.assets.Eth);
	console.log("balance", balance.toString());
	// console.log("address", await wallet.getDefaultAddress());
}

async function transferMoney(walletAddress: string, amountInEth: Decimal) {
	const wallet = await Wallet.import({ mnemonicPhrase: WALLET_MNEMONIC_PHRASE });

	await getBalance();

	const transfer = await wallet.createTransfer({
		amount: amountInEth.toNumber(),
		assetId: Coinbase.assets.Eth,
		destination: walletAddress,
	});

	try {
		await transfer.wait();

		return transfer.getTransaction().getTransactionHash();
	} catch (err) {
		console.log("transfer fail: error", err);
		return null;
	}
}

export const lendingTool = tool(
	async ({ amount }, config) => {
		const walletAddress = config?.configurable?.walletAddress;
		if (!walletAddress) {
			return "Wallet address missing in configuration.";
		}

		if (!amount || amount <= 0) {
			return "Loan amount must be positive.";
		}

		// Check for existing active loans
		const existingLoans = (await db.allDocs({ include_docs: true })).rows
			.filter((row) => row.doc?.type === "loan" && 
				(row.doc as Loan).walletAddress === walletAddress && 
				(row.doc as Loan).status === "approved")
			.map((row) => row.doc as Loan);

		if (existingLoans.length > 0) {
			return `Cannot apply for a new loan while having an active loan. Please repay your existing loan first.`;
		}

		// Constants for loan requirements
		const REQUIRED_CONTRIBUTION_PERCENTAGE = 20; // 20% of loan amount required as contribution

		// Get all documents and filter for contributions from this wallet
		const allDocs = await db.allDocs({ include_docs: true });
		const contributions = allDocs.rows.filter((row) => row.doc?.type === "contribution" && (row.doc as IContribution).walletAddress === walletAddress).map((row) => row.doc as IContribution);

		// Calculate total contribution from this wallet
		const totalContribution = contributions.reduce((sum, contrib) => sum + (contrib.amountInUsd || 0), 0);
		const requiredContribution = (amount * REQUIRED_CONTRIBUTION_PERCENTAGE) / 100;

		if (totalContribution < requiredContribution) {
			return `Need to contribute at least $${requiredContribution.toFixed(2)} USD (${REQUIRED_CONTRIBUTION_PERCENTAGE}% of $${amount}) to borrow. Current contribution: $${totalContribution.toFixed(2)}.`;
		}

		// Check pool funds
		let groupDoc: IGroup;
		try {
			groupDoc = (await db.get("chama")) as IGroup;
		} catch (error) {
			groupDoc = { _id: "chama", type: "group", name: "Chama", totalPool: 0 } as IGroup;
		}
		if (groupDoc.totalPool < amount) {
			return `Insufficient funds in Chama pool ($${groupDoc.totalPool.toFixed(2)} USD). Need at least $${amount.toFixed(2)} USD for the loan.`;
		}

		// Set fixed interest rate
		const interestRate = 10; // Fixed at 10%, adjustable if specified

		// Create loan
		const loanId = `loan_${Date.now()}`;
		try {
			await db.put({
				_id: loanId,
				type: "loan",
				walletAddress,
				amount,
				collateral: 0,
				interestRate,
				status: "pending",
				votes: [],
			} as Loan);
		} catch (error) {
			return "Failed to create loan request.";
		}

		return new Command({
			update: {
				loanId,
				messages: [new ToolMessage({ content: `Loan request ${loanId} created for $${amount.toFixed(2)} USD. Interest: ${interestRate}%. Awaiting group vote.`, tool_call_id: config.toolCall.id })],
			},
		});
	},
	{
		name: "lendingTool",
		description: "Requests a loan from the Chama pool, requiring a contribution of at least 20% of the loan amount and sufficient pool funds. Uses a fixed 10% interest rate.",
		schema: z.object({
			amount: z.number().positive().describe("Loan amount in USD"),
		}),
	}
);

export const votingTool = tool(
	async ({ loanId, vote }, config: RunnableConfig) => {
		const walletAddress = config["configurable"]["walletAddress"];
		if (!walletAddress) {
			return "Wallet address missing in configuration.";
		}

		const currentLoanId = loanId ?? config["configurable"]["loanId"];

		// Get the latest version of the loan document
		let loan: Loan;
		try {
			loan = (await db.get(currentLoanId)) as Loan;
		} catch (error) {
			throw new Error(`Loan ${loanId} not found.`);
		}

		if (loan.status !== "pending") {
			return `Loan ${loanId} is not open for voting. Status: ${loan.status}.`;
		}

		const existingVote = loan.votes.find((v) => v.walletAddress === walletAddress);
		if (existingVote) {
			// Even if user already voted, check if loan can be approved
			const group = (await db.get("chama").catch(() => {
				throw new Error("Chama pool not found.");
			})) as IGroup;

			// Get all documents for contribution calculation
			const allDocs = await db.allDocs({ include_docs: true });

			// Calculate total voting weight from approving votes
			const totalVotes = await loan.votes.reduce(async (acc: Promise<number>, v: { walletAddress: string; vote: boolean }) => {
				if (!v.vote) return acc; // Only count approving votes

				const voterContribs = allDocs.rows.filter((row) => row.doc?.type === "contribution" && (row.doc as IContribution).walletAddress === v.walletAddress).map((row) => row.doc as IContribution);

				const voterWeight = voterContribs.reduce((sum, contrib) => sum + (contrib.amountInUsd || 0), 0);
				return (await acc) + voterWeight;
			}, Promise.resolve(0));

			const totalPool = group.totalPool;
			const approvalRatio = totalVotes / totalPool;

			if (approvalRatio >= 0.6) {
				// Try to update loan status with conflict handling
				let retryCount = 0;
				const maxRetries = 3;

				while (retryCount < maxRetries) {
					try {
						loan.status = "approved";
						await db.put(loan);
						break;
					} catch (error) {
						if (error.name === "conflict") {
							loan = (await db.get(currentLoanId)) as Loan;
							if (loan.status !== "pending") {
								return `Loan ${loanId} has already been ${loan.status}.`;
							}
							loan.status = "approved";
							retryCount++;
							if (retryCount === maxRetries) {
								return "Failed to update loan status after multiple attempts. Please try again.";
							}
						} else {
							throw error;
						}
					}
				}

				try {
					// transfer the funds
					const ethPriceInUSD = await getEthPriceToday();
					// Convert USD amount to ETH using Decimal for precision
					const ethAmount = new Decimal(loan.amount).dividedBy(new Decimal(ethPriceInUSD));
					console.log("Transfer amount in ETH:", ethAmount.toString());
					await getBalance();
					const txHash = await transferMoney(loan.walletAddress, ethAmount);
					console.log("txtttt", txHash);

					if (!txHash) {
						// Revert loan status if transfer fails
						retryCount = 0;
						while (retryCount < maxRetries) {
							try {
								loan.status = "pending";
								await db.put(loan);
								break;
							} catch (error) {
								console.log("error8888828", error);
								if (error.name === "conflict") {
									loan = (await db.get(currentLoanId)) as Loan;
									loan.status = "pending";
									retryCount++;
									if (retryCount === maxRetries) {
										return "Failed to revert loan status after transfer failure. Please contact support.";
									}
								} else {
									throw error;
								}
							}
						}
						return `Loan ${loanId} has reached approval threshold (${(approvalRatio * 100).toFixed(2)}%). However, the fund transfer failed. Please try again.`;
					}

					return `Loan ${loanId} has been approved and funded. Approval ratio: ${(approvalRatio * 100).toFixed(2)}%. Transferred ${ethAmount.toString()} ETH ($${loan.amount.toFixed(2)} USD) to ${
						loan.walletAddress
					}. Transaction hash: ${txHash}`;
				} catch (error) {
					console.log("error99", error);
					// Revert loan status if transfer fails
					retryCount = 0;
					while (retryCount < maxRetries) {
						try {
							loan.status = "pending";
							await db.put(loan);
							break;
						} catch (error) {
							console.log("5636errrro", error);
							if (error.name === "conflict") {
								loan = (await db.get(currentLoanId)) as Loan;
								loan.status = "pending";
								retryCount++;
								if (retryCount === maxRetries) {
									return "Failed to revert loan status after transfer failure. Please contact support.";
								}
							} else {
								throw error;
							}
						}
					}
					return `Loan ${loanId} has reached approval threshold (${(approvalRatio * 100).toFixed(2)}%). However, the fund transfer failed: ${error.message}. Please try again.`;
				}
			}

			return `Already voted on loan ${loanId}. Current approval ratio: ${(approvalRatio * 100).toFixed(2)}%.`;
		}

		// Get all documents and filter for contributions from this wallet
		const allDocs = await db.allDocs({ include_docs: true });
		const voterContributions = allDocs.rows.filter((row) => row.doc?.type === "contribution" && (row.doc as IContribution).walletAddress === walletAddress).map((row) => row.doc as IContribution);

		// Calculate total contribution from this wallet
		const voterTotalContribution = voterContributions.reduce((sum, contrib) => sum + (contrib.amountInUsd || 0), 0);
		if (voterTotalContribution === 0) {
			return `Cannot vote without any contributions. Please contribute to the Chama pool first.`;
		}

		// Add the vote and try to save with conflict handling
		loan.votes.push({ walletAddress, vote });

		let retryCount = 0;
		const maxRetries = 3;

		while (retryCount < maxRetries) {
			try {
				await db.put(loan);
				break; // Success, exit the retry loop
			} catch (error) {
				if (error.name === "conflict") {
					// Get the latest version and retry
					loan = (await db.get(currentLoanId)) as Loan;
					// Check if vote was already added in the meantime
					if (loan.votes.some((v) => v.walletAddress === walletAddress)) {
						return `Already voted on loan ${loanId}.`;
					}
					// Re-add the vote to the latest version
					loan.votes.push({ walletAddress, vote });
					retryCount++;
					if (retryCount === maxRetries) {
						return "Failed to record vote after multiple attempts. Please try again.";
					}
				} else {
					throw error; // Re-throw if it's not a conflict error
				}
			}
		}

		const group = (await db.get("chama").catch(() => {
			throw new Error("Chama pool not found.");
		})) as IGroup;

		// Calculate total voting weight from approving votes
		const totalVotes = await loan.votes.reduce(async (acc: Promise<number>, v: { walletAddress: string; vote: boolean }) => {
			if (!v.vote) return acc; // Only count approving votes

			const voterContribs = allDocs.rows.filter((row) => row.doc?.type === "contribution" && (row.doc as IContribution).walletAddress === v.walletAddress).map((row) => row.doc as IContribution);

			const voterWeight = voterContribs.reduce((sum, contrib) => sum + (contrib.amountInUsd || 0), 0);
			return (await acc) + voterWeight;
		}, Promise.resolve(0));

		const totalPool = group.totalPool;
		const approvalRatio = totalVotes / totalPool;

		if (approvalRatio >= 0.6) {
			// Try to update loan status with conflict handling
			retryCount = 0;
			while (retryCount < maxRetries) {
				try {
					loan.status = "approved";
					await db.put(loan);
					break;
				} catch (error) {
					console.log("erroroor", error);
					if (error.name === "conflict") {
						loan = (await db.get(currentLoanId)) as Loan;
						if (loan.status !== "pending") {
							return `Loan ${loanId} has already been ${loan.status}.`;
						}
						loan.status = "approved";
						retryCount++;
						if (retryCount === maxRetries) {
							return "Failed to update loan status after multiple attempts. Please try again.";
						}
					} else {
						throw error;
					}
				}
			}

			try {
				// transfer the funds
				const ethPriceInUSD = await getEthPriceToday();
				// Convert USD amount to ETH using Decimal for precision
				const ethAmount = new Decimal(loan.amount).dividedBy(new Decimal(ethPriceInUSD));
				console.log("Transfer amount in ETH:", ethAmount.toString());
				const txHash = await transferMoney(loan.walletAddress, ethAmount);

				if (!txHash) {
					// Revert loan status if transfer fails
					retryCount = 0;
					while (retryCount < maxRetries) {
						try {
							loan.status = "pending";
							await db.put(loan);
							break;
						} catch (error) {
							if (error.name === "conflict") {
								loan = (await db.get(currentLoanId)) as Loan;
								loan.status = "pending";
								retryCount++;
								if (retryCount === maxRetries) {
									return "Failed to revert loan status after transfer failure. Please contact support.";
								}
							} else {
								throw error;
							}
						}
					}
					return `Loan ${loanId} has reached approval threshold (${(approvalRatio * 100).toFixed(2)}%). However, the fund transfer failed. Please try again.`;
				}

				return `Loan ${loanId} has been approved and funded. Approval ratio: ${(approvalRatio * 100).toFixed(2)}%. Transferred ${ethAmount.toString()} ETH ($${loan.amount.toFixed(2)} USD) to ${
					loan.walletAddress
				}. Transaction hash: ${txHash}`;
			} catch (error) {
				console.log("error97", error);
				// Revert loan status if transfer fails
				retryCount = 0;
				while (retryCount < maxRetries) {
					try {
						loan.status = "pending";
						await db.put(loan);
						break;
					} catch (error) {
						console.log("error44", error);
						if (error.name === "conflict") {
							loan = (await db.get(currentLoanId)) as Loan;
							loan.status = "pending";
							retryCount++;
							if (retryCount === maxRetries) {
								return "Failed to revert loan status after transfer failure. Please contact support.";
							}
						} else {
							throw error;
						}
					}
				}
				return `Loan ${loanId} has reached approval threshold (${(approvalRatio * 100).toFixed(2)}%). However, the fund transfer failed: ${error.message}. Please try again.`;
			}
		}

		return `Vote (${vote ? "approve" : "reject"}) recorded on loan ${loanId}. Current approval ratio: ${(approvalRatio * 100).toFixed(2)}%.`;
	},
	{
		name: "votingTool",
		description: "Casts a vote on a loan request, weighted by contributions in the Chama pool. Requires at least 60% of total pool value in approving votes to pass.",
		schema: z.object({
			loanId: z.string().describe("ID of the loan to vote on"),
			vote: z.boolean().describe("Vote: true to approve, false to reject"),
		}),
	}
);

export const investmentTool = tool(
	async ({ description, amount, action }, config) => {
		const walletAddress = config["configurable"]["walletAddress"];
		if (!walletAddress) {
			return "Wallet address missing in configuration.";
		}

		if (action !== "propose") {
			return "Invalid action. Use 'propose'.";
		}

		if (amount <= 0) {
			return "Investment amount must be positive.";
		}

		const group = (await db.get("chama").catch(() => {
			throw new Error("Chama pool not found.");
		})) as IGroup;
		if (amount > group.totalPool) {
			return `Investment amount (${amount}) exceeds Chama pool (${group.totalPool}).`;
		}

		const investId = `invest_${Date.now()}`;
		await db.put({
			_id: investId,
			type: "investment",
			walletAddress,
			description,
			amount,
			status: "pending",
			votes: [],
		} as Investment);

		return new Command({
			update: {
				investmentId: investId,
				messages: [new ToolMessage({ content: `Investment ${investId} proposed for ${amount}: ${description}. Please confirm proposal details.`, tool_call_id: config.toolCall.id })],
			},
		});
	},
	{
		name: "investmentTool",
		description: "Proposes an investment project for voting in the Chama pool.",
		schema: z.object({
			description: z.string().describe("Description of the investment project"),
			amount: z.number().positive().describe("Investment amount"),
			action: z.enum(["propose"]).describe("Action: propose an investment"),
		}),
	}
);

export const investmentVotingTool = tool(
	async ({ investmentId, vote }, config) => {
		const walletAddress = config["configurable"]["walletAddress"];
		if (!walletAddress) {
			return "Wallet address missing in configuration.";
		}

		const currentInvestmentId = investmentId ?? config["configurable"]["investmentId"];

		// Get the latest version of the investment document
		let investment: Investment;
		try {
			investment = (await db.get(currentInvestmentId)) as Investment;
		} catch (error) {
			throw new Error(`Investment ${currentInvestmentId} not found.`);
		}

		if (investment.status !== "pending") {
			return `Investment ${currentInvestmentId} is not open for voting. Status: ${investment.status}.`;
		}

		const existingVote = investment.votes.find((v) => v.walletAddress === walletAddress);
		if (existingVote) {
			// Even if user already voted, check if investment can be approved
			const group = (await db.get("chama").catch(() => {
				throw new Error("Chama pool not found.");
			})) as IGroup;

			// Get all documents for contribution calculation
			const allDocs = await db.allDocs({ include_docs: true });

			// Calculate total voting weight from approving votes
			const totalVotes = await investment.votes.reduce(async (acc: Promise<number>, v: { walletAddress: string; vote: boolean }) => {
				if (!v.vote) return acc; // Only count approving votes

				const voterContribs = allDocs.rows.filter((row) => row.doc?.type === "contribution" && (row.doc as IContribution).walletAddress === v.walletAddress).map((row) => row.doc as IContribution);

				const voterWeight = voterContribs.reduce((sum, contrib) => sum + (contrib.amountInUsd || 0), 0);
				return (await acc) + voterWeight;
			}, Promise.resolve(0));

			const totalPool = group.totalPool;
			const approvalRatio = totalVotes / totalPool;

			if (approvalRatio >= 0.7) { // Higher threshold for investments (70% vs 60% for loans)
				// Try to update investment status with conflict handling
				let retryCount = 0;
				const maxRetries = 3;

				while (retryCount < maxRetries) {
					try {
						investment.status = "approved";
						await db.put(investment);
						break;
					} catch (error) {
						if (error.name === "conflict") {
							investment = (await db.get(currentInvestmentId)) as Investment;
							if (investment.status !== "pending") {
								return `Investment ${currentInvestmentId} has already been ${investment.status}.`;
							}
							investment.status = "approved";
							retryCount++;
							if (retryCount === maxRetries) {
								return "Failed to update investment status after multiple attempts. Please try again.";
							}
						} else {
							throw error;
						}
					}
				}

				return `Investment ${currentInvestmentId} has been approved. Approval ratio: ${(approvalRatio * 100).toFixed(2)}%.`;
			}

			return `Already voted on investment ${currentInvestmentId}. Current approval ratio: ${(approvalRatio * 100).toFixed(2)}%.`;
		}

		// Get all documents and filter for contributions from this wallet
		const allDocs = await db.allDocs({ include_docs: true });
		const voterContributions = allDocs.rows.filter((row) => row.doc?.type === "contribution" && (row.doc as IContribution).walletAddress === walletAddress).map((row) => row.doc as IContribution);

		// Calculate total contribution from this wallet
		const voterTotalContribution = voterContributions.reduce((sum, contrib) => sum + (contrib.amountInUsd || 0), 0);
		if (voterTotalContribution === 0) {
			return `Cannot vote without any contributions. Please contribute to the Chama pool first.`;
		}

		// Add the vote and try to save with conflict handling
		investment.votes.push({ walletAddress, vote });

		let retryCount = 0;
		const maxRetries = 3;

		while (retryCount < maxRetries) {
			try {
				await db.put(investment);
				break; // Success, exit the retry loop
			} catch (error) {
				if (error.name === "conflict") {
					// Get the latest version and retry
					investment = (await db.get(currentInvestmentId)) as Investment;
					// Check if vote was already added in the meantime
					if (investment.votes.some((v) => v.walletAddress === walletAddress)) {
						return `Already voted on investment ${currentInvestmentId}.`;
					}
					// Re-add the vote to the latest version
					investment.votes.push({ walletAddress, vote });
					retryCount++;
					if (retryCount === maxRetries) {
						return "Failed to record vote after multiple attempts. Please try again.";
					}
				} else {
					throw error; // Re-throw if it's not a conflict error
				}
			}
		}

		const group = (await db.get("chama").catch(() => {
			throw new Error("Chama pool not found.");
		})) as IGroup;

		// Calculate total voting weight from approving votes
		const totalVotes = await investment.votes.reduce(async (acc: Promise<number>, v: { walletAddress: string; vote: boolean }) => {
			if (!v.vote) return acc; // Only count approving votes

			const voterContribs = allDocs.rows.filter((row) => row.doc?.type === "contribution" && (row.doc as IContribution).walletAddress === v.walletAddress).map((row) => row.doc as IContribution);

			const voterWeight = voterContribs.reduce((sum, contrib) => sum + (contrib.amountInUsd || 0), 0);
			return (await acc) + voterWeight;
		}, Promise.resolve(0));

		const totalPool = group.totalPool;
		const approvalRatio = totalVotes / totalPool;

		if (approvalRatio >= 0.7) { // Higher threshold for investments (70% vs 60% for loans)
			// Try to update investment status with conflict handling
			retryCount = 0;
			while (retryCount < maxRetries) {
				try {
					investment.status = "approved";
					await db.put(investment);
					break;
				} catch (error) {
					if (error.name === "conflict") {
						investment = (await db.get(currentInvestmentId)) as Investment;
						if (investment.status !== "pending") {
							return `Investment ${currentInvestmentId} has already been ${investment.status}.`;
						}
						investment.status = "approved";
						retryCount++;
						if (retryCount === maxRetries) {
							return "Failed to update investment status after multiple attempts. Please try again.";
						}
					} else {
						throw error;
					}
				}
			}

			return `Investment ${currentInvestmentId} has been approved. Approval ratio: ${(approvalRatio * 100).toFixed(2)}%.`;
		}

		return `Vote (${vote ? "approve" : "reject"}) recorded on investment ${currentInvestmentId}. Current approval ratio: ${(approvalRatio * 100).toFixed(2)}%.`;
	},
	{
		name: "investmentVotingTool",
		description: "Casts a vote on an investment proposal, weighted by contributions in the Chama pool. Requires at least 70% of total pool value in approving votes to pass.",
		schema: z.object({
			investmentId: z.string().optional().describe("ID of the investment to vote on (optional if set in memory)"),
			vote: z.boolean().describe("Vote: true to approve, false to reject"),
		}),
	}
);

export const askHumanTool = tool(
	(_) => {
		return "Waiting for human input.";
	},
	{
		name: "askHuman",
		description: "Ask the human for input (e.g., approve, reject, adjust with JSON input).",
		schema: z.string(),
	}
);

export const checkContributionBalanceTool = tool(
	async ({}, config: RunnableConfig) => {
		const walletAddress = config["configurable"]["walletAddress"];
		if (!walletAddress) {
			return "Wallet address missing in configuration.";
		}

		// Get all documents and filter for contributions from this wallet
		const allDocs = await db.allDocs({ include_docs: true });
		const contributions = allDocs.rows.filter((row) => row.doc?.type === "contribution" && (row.doc as IContribution).walletAddress === walletAddress).map((row) => row.doc as IContribution);

		const totalContribution = contributions.reduce((sum, contrib) => sum + (contrib.amountInUsd || 0), 0);

		const groupDoc = (await db.get("chama").catch(
			() =>
				({
					_id: "chama",
					type: "group",
					name: "Chama",
					totalPool: 0,
				} as IGroup)
		)) as IGroup;

		if (totalContribution === 0 && contributions.length === 0) {
			return `No contribution record. Deposit funds to join with 'deposit 10'.`;
		}

		return `Balance:\n- Contribution: ${totalContribution}\n- Total Chama Pool: ${groupDoc.totalPool}.`;
	},
	{
		name: "checkContributionBalanceTool",
		description: "Retrieves the user's contribution balance and total Chama pool size.",
		schema: z.object({}),
	}
);

export const checkLoanBalanceTool = tool(
	async ({}, config: RunnableConfig) => {
		const walletAddress = config["configurable"]["walletAddress"];
		if (!walletAddress) {
			return "Wallet address missing in configuration.";
		}

		const loans = (await db.allDocs({ include_docs: true })).rows
			.filter((row) => row.doc?.type === "loan" && 
				((row.doc as Loan).status === "approved" || (row.doc as Loan).status === "paid"))
			.map((row) => row.doc as Loan);

		if (!loans.length) {
			return `No active loans found.`;
		}

		let totalBalance = 0;
		let response = `Loan Balance:\n`;
		for (const loan of loans) {
			const principal = loan.amount;
			const interest = (principal * (loan.interestRate / 100) * 30) / 365;
			const totalDue = principal + interest;
			const paidAmount = loan.paidAmount || 0;
			const remaining = totalDue - paidAmount;
			totalBalance += remaining;

			response += `- ${loan._id}:\n`;
			response += `  Principal: $${principal.toFixed(2)}\n`;
			response += `  Interest: $${interest.toFixed(2)}\n`;
			response += `  Total Due: $${totalDue.toFixed(2)}\n`;
			response += `  Paid: $${paidAmount.toFixed(2)}\n`;
			response += `  Remaining: $${remaining.toFixed(2)}\n`;
			response += `  Status: ${loan.status}\n`;
			
			// Show payment history if available
			if (loan.payments && loan.payments.length > 0) {
				response += `  Payment History:\n`;
				loan.payments.forEach((payment, index) => {
					const date = new Date(payment.timestamp).toLocaleString();
					response += `    ${index + 1}. $${payment.amount.toFixed(2)} on ${date}\n`;
					response += `       Transaction: ${payment.transactionHash}\n`;
				});
			}

			if (remaining > 0) {
				response += `  To pay remaining amount, send $${remaining.toFixed(2)} USD worth of ETH to ${GROUP_WALLET_ADDRESS} and use verifyLoanRepaymentTool with the transaction hash.\n`;
			}
			response += `\n`;
		}
		response += `Total Outstanding: $${totalBalance.toFixed(2)}`;

		return response;
	},
	{
		name: "checkLoanBalanceTool",
		description: "Retrieves the user's total outstanding loan balance, including principal, interest, paid amounts, and payment history.",
		schema: z.object({}),
	}
);

export const verifyLoanRepaymentTool = tool(
	async ({ hash }, config: RunnableConfig) => {
		const walletAddress = config["configurable"]["walletAddress"];
		if (!walletAddress) {
			return "Wallet address missing in configuration.";
		}

		// Fetch transactions for the group wallet
		const transactions = await getWalletTransactions(GROUP_WALLET_ADDRESS);

		// Find transaction by hash and verify it goes to the group wallet
		const transaction = transactions.data.find((item) => item.content().hash === hash && item.content().from.toLowerCase() === walletAddress.toLowerCase());

		if (!transaction) {
			return `No transaction found with hash ${hash} from wallet ${walletAddress} to group wallet ${GROUP_WALLET_ADDRESS}.`;
		}

		const amountInWei = transaction.content().value;
		const transactionTimestamp = transaction.content().block_timestamp;

		// Convert wei to USD
		let transactionAmts;
		try {
			transactionAmts = await convertWeiToUSD(amountInWei);
		} catch (error) {
			console.error("Error converting amount:", error);
			return "Failed to convert transaction amount to USD.";
		}

		// Get all active loans for this wallet
		const loans = (await db.allDocs({ include_docs: true })).rows
			.filter((row) => row.doc?.type === "loan" && 
				((row.doc as Loan).status === "approved" || (row.doc as Loan).status === "paid"))
			.map((row) => row.doc as Loan);

		if (!loans.length) {
			return `No active loans found for wallet ${walletAddress}.`;
		}

		// Calculate total outstanding amount and track remaining amounts
		let totalOutstanding = 0;
		let remainingAmounts: { loanId: string; remaining: number }[] = [];

		for (const loan of loans) {
			const principal = loan.amount;
			const interest = (principal * (loan.interestRate / 100) * 30) / 365;
			const totalDue = principal + interest;
			const paidAmount = loan.paidAmount || 0;
			const remaining = totalDue - paidAmount;
			totalOutstanding += remaining;
			remainingAmounts.push({ loanId: loan._id, remaining });
		}

		// Check if payment amount is positive
		if (transactionAmts.usdAmount.toNumber() <= 0) {
			return `Payment amount must be greater than 0.`;
		}

		// Process payment and update loans
		let remainingPayment = transactionAmts.usdAmount.toNumber();
		let response = `Payment of $${remainingPayment.toFixed(2)} USD (${transactionAmts.ethAmount?.toNumber().toFixed(6)} ETH) processed.\n\n`;

		// First, process all loan payments
		for (const loan of loans) {
			if (remainingPayment <= 0) break;

			const principal = loan.amount;
			const interest = (principal * (loan.interestRate / 100) * 30) / 365;
			const totalDue = principal + interest;
			const paidAmount = loan.paidAmount || 0;
			const remaining = totalDue - paidAmount;

			if (remaining > 0) {
				const paymentForThisLoan = Math.min(remaining, remainingPayment);
				const previousPaidAmount = loan.paidAmount || 0;
				loan.paidAmount = previousPaidAmount + paymentForThisLoan;
				remainingPayment -= paymentForThisLoan;

				// Calculate interest portion of this payment
				const remainingPrincipal = principal - (previousPaidAmount - (loan.interestPaid || 0));
				const interestPortion = Math.min(
					paymentForThisLoan,
					remaining - remainingPrincipal
				);
				
				// Update total interest paid
				loan.interestPaid = (loan.interestPaid || 0) + interestPortion;

				// Initialize payments array if it doesn't exist
				if (!loan.payments) {
					loan.payments = [];
				}

				// Add payment to history with interest breakdown
				loan.payments.push({
					amount: paymentForThisLoan,
					timestamp: transactionTimestamp,
					transactionHash: hash,
					interestAmount: interestPortion
				});

				// If loan is fully paid, create interest distribution record
				if (loan.paidAmount >= totalDue) {
					loan.status = "paid";
					
					// Create interest distribution record
					const interestDistId = `interest_${loan._id}_${Date.now()}`;
					const interestDistribution: InterestDistribution = {
						_id: interestDistId,
						type: "interest_distribution",
						loanId: loan._id,
						amount: loan.interestPaid,
						timestamp: transactionTimestamp,
						status: "pending"
					};
					
					try {
						await db.put(interestDistribution);
						response += `Interest distribution record created for $${loan.interestPaid.toFixed(2)}.\n`;
					} catch (error) {
						console.error("Error creating interest distribution record:", error);
					}
				}

				await db.put(loan);

				response += `Loan ${loan._id}:\n`;
				response += `- Total due: $${totalDue.toFixed(2)}\n`;
				response += `- Previously paid: $${previousPaidAmount.toFixed(2)}\n`;
				response += `- This payment: $${paymentForThisLoan.toFixed(2)}\n`;
				response += `  - Principal: $${(paymentForThisLoan - interestPortion).toFixed(2)}\n`;
				response += `  - Interest: $${interestPortion.toFixed(2)}\n`;
				response += `- Remaining: $${(totalDue - loan.paidAmount).toFixed(2)}\n`;
				response += `- Status: ${loan.status}\n\n`;
			}
		}

		// If there's remaining payment after all loans are paid, add it to contributions
		if (remainingPayment > 0) {
			const contribId = `contrib_${walletAddress}_${hash}`;
			try {
				// Check if contribution already exists
				await db.get(contribId);
				response += `Note: Excess payment of $${remainingPayment.toFixed(2)} was already added to contributions.\n`;
			} catch (error) {
				if (error.status === 404) {
					// Create new contribution with excess amount
					const contribution: IContribution = {
						_id: contribId,
						type: "contribution",
						walletAddress,
						amountInWei,
						amountInEth: transactionAmts.ethAmount?.toNumber() || new BigNumber(amountInWei).dividedBy("1000000000000000000").toNumber(),
						amountInUsd: remainingPayment,
						transactionHash: hash,
						transactionTimestamp,
					};

					await db.put(contribution);

					// Update group total pool
					let groupDoc: IGroup;
					try {
						groupDoc = (await db.get("chama")) as IGroup;
					} catch (error) {
						groupDoc = { _id: "chama", type: "group", name: "Chama", totalPool: 0 } as IGroup;
					}
					groupDoc.totalPool += remainingPayment;
					await db.put(groupDoc);

					response += `Excess payment of $${remainingPayment.toFixed(2)} has been added to your contributions.\n`;
					response += `Updated total pool: $${groupDoc.totalPool.toFixed(2)}\n`;
				} else {
					throw error;
				}
			}
		}

		// Add summary of remaining amounts
		response += `\nRemaining amounts to be paid:\n`;
		for (const { loanId, remaining } of remainingAmounts) {
			if (remaining > 0) {
				response += `- ${loanId}: $${remaining.toFixed(2)}\n`;
			}
		}

		return response;
	},
	{
		name: "verifyLoanRepaymentTool",
		description: "Verifies a loan repayment transaction using a transaction hash, converts the amount to USD, and processes partial or full payments. Any excess amount is added to the user's contributions. Tracks interest payments for distribution.",
		schema: z.object({
			hash: z.string().describe("Transaction hash for the loan repayment to the group wallet"),
		}),
	}
);

export const checkLoanEligibilityTool = tool(
	async ({}, config: RunnableConfig) => {
		const walletAddress = config["configurable"]["walletAddress"];
		if (!walletAddress) {
			return "Wallet address missing in configuration.";
		}

		// Get all documents and filter for contributions from this wallet
		const allDocs = await db.allDocs({ include_docs: true });
		const contributions = allDocs.rows.filter((row) => row.doc?.type === "contribution" && (row.doc as IContribution).walletAddress === walletAddress).map((row) => row.doc as IContribution);

		if (contributions.length === 0) {
			return `No contribution record. Deposit funds to become eligible for loans with 'deposit 10'.`;
		}

		// Sum up all contributions
		const totalContribution = contributions.reduce((sum, contrib) => sum + (contrib.amountInUsd || 0), 0);
		const maxLoan = totalContribution * 5;
		return `Eligible for a loan up to ${maxLoan} based on total contribution of ${totalContribution}.`;
	},
	{
		name: "checkLoanEligibilityTool",
		description: "Calculates the maximum loan amount the user is eligible for (5x contribution).",
		schema: z.object({}),
	}
);

export const checkPaymentHistoryTool = tool(
	async ({}, config: RunnableConfig) => {
		const walletAddress = config["configurable"]["walletAddress"];
		if (!walletAddress) {
			return "Wallet address missing in configuration.";
		}

		const contribId = `contrib_${walletAddress}`;
		const contrib = (await db.get(contribId).catch(
			() =>
				({
					_id: contribId,
					type: "contribution",
					walletAddress,
					amountInWei: "0",
					amountInEth: 0,
					amountInUsd: 0,
					amount: 0,
				} as IContribution)
		)) as IContribution;

		const loans = (await db.allDocs({ include_docs: true })).rows.filter((row) => row.doc?.type === "loan").map((row) => row.doc as Loan);

		const investments = (await db.allDocs({ include_docs: true })).rows.filter((row) => row.doc?.type === "investment").map((row) => row.doc as Investment);

		let response = `Payment History:\n`;
		response += `- Contributions: ${contrib.amountInUsd > 0 ? `Total ${contrib.amountInUsd}` : "None"}\n`;
		response += `- Loans: ${loans.length ? loans.map((l) => `${l._id}: ${l.amount} (${l.status}, Created: ${new Date(parseInt(l._id.split("_")[1])).toLocaleString()})`).join(", ") : "None"}\n`;
		response += `- Investments: ${investments.length ? investments.map((i) => `${i._id}: ${i.amount} (${i.status}, Created: ${new Date(parseInt(i._id.split("_")[1])).toLocaleString()})`).join(", ") : "None"}`;

		return response;
	},
	{
		name: "checkPaymentHistoryTool",
		description: "Retrieves the user's group pool activity.",
		schema: z.object({}),
	}
);

export const checkGroupStatusTool = tool(
	async () => {
		const groupDoc = (await db.get("chama").catch(
			() =>
				({
					_id: "chama",
					type: "group",
					name: "Chama",
					totalPool: 0,
				} as IGroup)
		)) as IGroup;

		const loans = (await db.allDocs({ include_docs: true })).rows.filter((row) => row.doc?.type === "loan").map((row) => row.doc as Loan);

		const investments = (await db.allDocs({ include_docs: true })).rows.filter((row) => row.doc?.type === "investment").map((row) => row.doc as Investment);

		let response = `Chama Pool Status:\n`;
		response += `- Total Pool: ${groupDoc.totalPool}\n`;
		response += `- Active Loans: ${loans.length ? loans.map((l) => `${l._id}: ${l.amount} (${l.status})`).join(", ") : "None"}\n`;
		response += `- Proposed Investments: ${investments.length ? investments.map((i) => `${i._id}: ${i.amount} (${i.status})`).join(", ") : "None"}`;

		return response;
	},
	{
		name: "checkGroupStatusTool",
		description: "Provides an overview of the Chama pool, including total pool size, active loans, and proposed investments.",
		schema: z.object({}),
	}
);

export const checkWalletAddressTool = tool(
	async ({}, config: RunnableConfig) => {
		const walletAddress = config["configurable"]["walletAddress"];
		if (!walletAddress || !walletAddress.startsWith("0x")) {
			return "Invalid or missing wallet address in configuration.";
		}
		return `Wallet Address: ${walletAddress}`;
	},
	{
		name: "checkWalletAddressTool",
		description: "Returns the user's wallet address from configuration or prompts for clarification if missing.",
		schema: z.object({}),
	}
);

export const distributeInterestTool = tool(
	async ({ interestDistributionId }, config: RunnableConfig) => {
		const walletAddress = config["configurable"]["walletAddress"];
		if (!walletAddress) {
			return "Wallet address missing in configuration.";
		}

		// Get the interest distribution record
		let interestDistribution: InterestDistribution;
		try {
			interestDistribution = (await db.get(interestDistributionId)) as InterestDistribution;
		} catch (error) {
			return `Interest distribution record ${interestDistributionId} not found.`;
		}

		if (interestDistribution.status === "distributed") {
			return `Interest distribution ${interestDistributionId} has already been distributed.`;
		}

		// Get the loan record
		let loan: Loan;
		try {
			loan = (await db.get(interestDistribution.loanId)) as Loan;
		} catch (error) {
			return `Loan ${interestDistribution.loanId} not found.`;
		}

		// Get all contributions to calculate member percentages
		const allDocs = await db.allDocs({ include_docs: true });
		const contributions = allDocs.rows
			.filter((row) => row.doc?.type === "contribution")
			.map((row) => row.doc as IContribution);

		// Calculate total pool and member contributions
		const totalPool = contributions.reduce((sum, contrib) => sum + contrib.amountInUsd, 0);
		const memberContributions = new Map<string, number>();

		// Group contributions by member
		contributions.forEach((contrib) => {
			const current = memberContributions.get(contrib.walletAddress) || 0;
			memberContributions.set(contrib.walletAddress, current + contrib.amountInUsd);
		});

		// Calculate distribution amounts
		const distributionDetails: Array<{
			walletAddress: string;
			amount: number;
			percentage: number;
		}> = [];

		memberContributions.forEach((amount, address) => {
			const percentage = amount / totalPool;
			const distributionAmount = interestDistribution.amount * percentage;
			distributionDetails.push({
				walletAddress: address,
				amount: distributionAmount,
				percentage: percentage * 100
			});
		});

		// Sort by amount for efficient processing
		distributionDetails.sort((a, b) => b.amount - a.amount);

		let response = `Distributing interest of $${interestDistribution.amount.toFixed(2)} from loan ${loan._id}:\n\n`;
		response += `Distribution breakdown:\n`;

		// Process distributions
		const distributionResults: Array<{
			walletAddress: string;
			amount: number;
			transactionHash?: string;
		}> = [];

		for (const detail of distributionDetails) {
			if (detail.amount < 0.01) continue; // Skip tiny amounts

			response += `- ${detail.walletAddress}: $${detail.amount.toFixed(2)} (${detail.percentage.toFixed(2)}%)\n`;

			try {
				// Convert USD amount to ETH
				const ethPriceInUSD = await getEthPriceToday();
				const ethAmount = new Decimal(detail.amount).dividedBy(new Decimal(ethPriceInUSD));

				// Transfer ETH to member
				const txHash = await transferMoney(detail.walletAddress, ethAmount);
				
				if (txHash) {
					distributionResults.push({
						walletAddress: detail.walletAddress,
						amount: detail.amount,
						transactionHash: txHash
					});
					response += `  ✓ Transferred ${ethAmount.toString()} ETH (Transaction: ${txHash})\n`;
				} else {
					response += `  ✗ Transfer failed\n`;
				}
			} catch (error) {
				console.error(`Error transferring to ${detail.walletAddress}:`, error);
				response += `  ✗ Transfer failed: ${error.message}\n`;
			}
		}

		// Update interest distribution record
		interestDistribution.status = "distributed";
		interestDistribution.distributionDetails = distributionResults;
		await db.put(interestDistribution);

		// Update group pool
		let groupDoc: IGroup;
		try {
			groupDoc = (await db.get("chama")) as IGroup;
		} catch (error) {
			groupDoc = { _id: "chama", type: "group", name: "Chama", totalPool: 0 } as IGroup;
		}
		groupDoc.totalPool += interestDistribution.amount;
		await db.put(groupDoc);

		response += `\nInterest distribution completed. Updated total pool: $${groupDoc.totalPool.toFixed(2)}`;

		return response;
	},
	{
		name: "distributeInterestTool",
		description: "Distributes interest payments to group members based on their contribution percentages. Processes transfers in ETH and updates the interest distribution record.",
		schema: z.object({
			interestDistributionId: z.string().describe("ID of the interest distribution record to process"),
		}),
	}
);

export const withdrawFundsTool = tool(
	async ({ amount }, config: RunnableConfig) => {
		const walletAddress = config["configurable"]["walletAddress"];
		if (!walletAddress) {
			return "Wallet address missing in configuration.";
		}

		if (!amount || amount <= 0) {
			return "Withdrawal amount must be positive.";
		}

		// Get all contributions from this wallet
		const allDocs = await db.allDocs({ include_docs: true });
		const contributions = allDocs.rows
			.filter((row) => row.doc?.type === "contribution" && 
				(row.doc as IContribution).walletAddress === walletAddress)
			.map((row) => row.doc as IContribution);

		if (contributions.length === 0) {
			return "No contributions found for this wallet.";
		}

		// Calculate total contribution
		const totalContribution = contributions.reduce((sum, contrib) => sum + contrib.amountInUsd, 0);

		// Get group pool status
		let groupDoc: IGroup;
		try {
			groupDoc = (await db.get("chama")) as IGroup;
		} catch (error) {
			groupDoc = { _id: "chama", type: "group", name: "Chama", totalPool: 0 } as IGroup;
		}

		// Check if requested amount is available in the pool
		if (amount > groupDoc.totalPool) {
			const availableAmount = groupDoc.totalPool;
			return `Insufficient funds in the pool. Available amount: $${availableAmount.toFixed(2)}. Please try a smaller amount.`;
		}

		// Check if user has enough contribution balance
		if (amount > totalContribution) {
			return `Withdrawal amount exceeds your contribution balance of $${totalContribution.toFixed(2)}. Please try a smaller amount.`;
		}

		// Check for active loans
		const activeLoans = allDocs.rows
			.filter((row) => row.doc?.type === "loan" && 
				(row.doc as Loan).walletAddress === walletAddress && 
				(row.doc as Loan).status === "approved")
			.map((row) => row.doc as Loan);

		if (activeLoans.length > 0) {
			const totalLoanAmount = activeLoans.reduce((sum, loan) => sum + loan.amount, 0);
			return `Cannot withdraw while having active loans totaling $${totalLoanAmount.toFixed(2)}. Please repay your loans first.`;
		}

		// Calculate withdrawal percentage
		const withdrawalPercentage = (amount / totalContribution) * 100;

		// If withdrawing more than 50%, require confirmation
		if (withdrawalPercentage > 50) {
			return `Warning: You are withdrawing ${withdrawalPercentage.toFixed(2)}% of your total contribution. This may affect your loan eligibility and voting power. Please confirm the withdrawal.`;
		}

		try {
			// Convert USD amount to ETH
			const ethPriceInUSD = await getEthPriceToday();
			const ethAmount = new Decimal(amount).dividedBy(new Decimal(ethPriceInUSD));

			// Transfer ETH to member
			const txHash = await transferMoney(walletAddress, ethAmount);

			if (!txHash) {
				return "Failed to process withdrawal. Please try again.";
			}

			// Create withdrawal record
			const withdrawalId = `withdraw_${walletAddress}_${Date.now()}`;
			const withdrawal: IContribution = {
				_id: withdrawalId,
				type: "contribution",
				walletAddress,
				amountInWei: ethAmount.times("1000000000000000000").toString(),
				amountInEth: ethAmount.toNumber(),
				amountInUsd: -amount, // Negative amount to indicate withdrawal
				transactionHash: txHash,
				transactionTimestamp: new Date().toISOString()
			};

			await db.put(withdrawal);

			// Update group pool
			groupDoc.totalPool -= amount;
			await db.put(groupDoc);

			return `Successfully withdrew $${amount.toFixed(2)} (${ethAmount.toString()} ETH).\nTransaction hash: ${txHash}\nUpdated pool balance: $${groupDoc.totalPool.toFixed(2)}`;
		} catch (error) {
			console.error("Error processing withdrawal:", error);
			return `Failed to process withdrawal: ${error.message}. Please try again.`;
		}
	},
	{
		name: "withdrawFundsTool",
		description: "Processes fund withdrawals from the Chama pool, with checks for available balance, active loans, and contribution limits. Converts USD amount to ETH for transfer.",
		schema: z.object({
			amount: z.number().positive().describe("Amount to withdraw in USD"),
		}),
	}
);
