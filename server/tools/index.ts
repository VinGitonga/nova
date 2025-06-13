import { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import PouchDB from "pouchdb";
import { z } from "zod";
import { Address, Coinbase, Wallet } from "@coinbase/coinbase-sdk";
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

		try {
			// Get all transactions for the group wallet
			const transactions = await getWalletTransactions(GROUP_WALLET_ADDRESS);

			// Find the transaction with the provided hash
			const transaction = transactions.data.find(
				(item) => item.content().hash === hash
			);
			if (!transaction) {
				return `Transaction ${hash} not found. Please verify the hash and try again.`;
			}

			// Verify the transaction is to the group wallet
			if (transaction.content().to.toLowerCase() !== GROUP_WALLET_ADDRESS.toLowerCase()) {
				return `Transaction ${hash} is not a deposit to the group wallet.`;
			}

			// Verify the transaction is from the correct wallet
			if (transaction.content().from.toLowerCase() !== walletAddress.toLowerCase()) {
				return `Transaction ${hash} is not from your wallet address.`;
			}

			// Check if transaction has already been processed
			try {
				const existingContrib = await db.get(`contrib_${walletAddress}_${hash}`);
				if (existingContrib) {
					// If contribution exists, show its details
					const contrib = existingContrib as IContribution;
					return (
						`Transaction ${hash} has already been processed:\n` +
						`- Amount: $${contrib.amountInUsd.toFixed(2)} (${contrib.amountInEth.toFixed(6)} ETH)\n` +
						`- Date: ${new Date(contrib.transactionTimestamp || "").toLocaleString()}\n` +
						`- Status: Verified`
					);
				}
			} catch (error) {
				// Transaction not found in database, proceed with verification
			}

			// Convert Wei to USD and ETH
			const amountInWei = transaction.content().value;
			const transactionAmts = await convertWeiToUSD(amountInWei);
			const amountInUsd = transactionAmts.usdAmount.toNumber();
			const amountInEth = transactionAmts.ethAmount.toNumber();

			// Get active loans for the user
			const allDocs = await db.allDocs({ include_docs: true });
			const activeLoans = allDocs.rows
				.filter(
					(row) =>
						row.doc?.type === "loan" &&
						(row.doc as Loan).walletAddress === walletAddress &&
						(row.doc as Loan).status === "approved" &&
						(row.doc as Loan).paidAmount !== (row.doc as Loan).amount
				)
				.map((row) => row.doc as Loan);

			let remainingAmount = amountInUsd;
			let response = `Processing transaction ${hash}:\n`;
			response += `- Total Amount: $${amountInUsd.toFixed(2)} (${amountInEth.toFixed(6)} ETH)\n`;

			// If user has active loans, apply payment to loans first
			if (activeLoans.length > 0) {
				response += `\nActive Loans Found - Applying Payment to Loans:\n`;
				
				for (const loan of activeLoans) {
					const remainingLoanAmount = loan.amount - (loan.paidAmount || 0);
					if (remainingLoanAmount <= 0) continue;

					const paymentAmount = Math.min(remainingAmount, remainingLoanAmount);
					const interestPortion = Math.min(
						paymentAmount,
						remainingLoanAmount - (loan.amount - (loan.interestPaid || 0))
					);

					// Create loan payment record
					const loanPayment: LoanPayment = {
						amount: paymentAmount,
						timestamp: new Date().toISOString(),
						transactionHash: hash,
						interestAmount: interestPortion
					};

					// Update loan document
					loan.paidAmount = (loan.paidAmount || 0) + paymentAmount;
					loan.interestPaid = (loan.interestPaid || 0) + interestPortion;
					loan.payments = loan.payments || [];
					loan.payments.push(loanPayment);

					// Update loan status if fully paid
					if (loan.paidAmount >= loan.amount) {
						loan.status = "paid";
					}

					// Save updated loan document
					await db.put(loan);

					// If there's interest to distribute, create an interest distribution record
					if (interestPortion > 0) {
						const interestDistribution: InterestDistribution = {
							_id: `interest_${loan._id}_${Date.now()}`,
							type: "interest_distribution",
							loanId: loan._id,
							amount: interestPortion,
							timestamp: new Date().toISOString(),
							status: "pending"
						};
						await db.put(interestDistribution);
						response += `  • Interest Distribution Created: $${interestPortion.toFixed(2)}\n`;
					}

					remainingAmount -= paymentAmount;

					response += `- Applied $${paymentAmount.toFixed(2)} to loan ${loan._id}:\n`;
					response += `  • Principal: $${(paymentAmount - interestPortion).toFixed(2)}\n`;
					response += `  • Interest: $${interestPortion.toFixed(2)}\n`;
					response += `  • Remaining Balance: $${(remainingLoanAmount - paymentAmount).toFixed(2)}\n`;
					response += `  • Loan Status: ${loan.status}\n`;
					response += `  • Payment Recorded: Yes\n`;

					if (remainingAmount <= 0) break;
				}
			}

			// Get group doc for pool updates
			const groupDoc = (await db.get("chama")) as IGroup;

			// If there's remaining amount, add it to contributions
			if (remainingAmount > 0) {
				// Save contribution
				const contribution: IContribution = {
					_id: `contrib_${walletAddress}_${hash}`,
					type: "contribution",
					walletAddress,
					amountInWei,
					amountInEth,
					amountInUsd: remainingAmount,
					transactionHash: hash,
					transactionTimestamp: new Date().toISOString(),
				};

				await db.put(contribution);

				// Update group total pool
				groupDoc.totalPool += remainingAmount;
				await db.put(groupDoc);

				response += `\nRemaining Amount Added to Contributions:\n`;
				response += `- Amount: $${remainingAmount.toFixed(2)} (${(remainingAmount / amountInUsd * amountInEth).toFixed(6)} ETH)\n`;
			} else {
				// Even if no remaining amount, still update the group doc to ensure consistency
				await db.put(groupDoc);
			}

			// Get user's total contribution after update
			const userContributions = allDocs.rows
				.filter(
					(row) =>
						row.doc?.type === "contribution" &&
						(row.doc as IContribution).walletAddress === walletAddress
				)
				.map((row) => row.doc as IContribution);

			const totalContribution = userContributions.reduce(
				(sum, contrib) => sum + contrib.amountInUsd,
				0
			);

			response += `\nUpdated Status:\n`;
			response += `- Your total contribution: $${totalContribution.toFixed(2)}\n`;
			response += `- Maximum loan amount: $${(totalContribution * 5).toFixed(2)} (5x contribution)\n`;
			response += `- Total pool size: $${groupDoc.totalPool.toFixed(2)}\n\n`;

			response += `Use listInterestDistributionsTool to see pending interest distributions.`;

			return response;
		} catch (error) {
			return `Error verifying transaction: ${error}`;
		}
	},
	{
		name: "verifyGroupSavingTransactionHash",
		description:
			"Verifies a group savings transaction deposit using a transaction hash, converts the amount to USD, and saves it to the database. Handles cases where transactions weren't initially recorded and provides detailed contribution information.",
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
			.filter((row) => row.doc?.type === "loan" && (row.doc as Loan).walletAddress === walletAddress && (row.doc as Loan).status === "approved")
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

			if (approvalRatio >= 0.7) {
				// Higher threshold for investments (70% vs 60% for loans)
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

		if (approvalRatio >= 0.7) {
			// Higher threshold for investments (70% vs 60% for loans)
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

		// Get all documents for this wallet
		const allDocs = await db.allDocs({ include_docs: true });

		// Get contributions and withdrawals
		const contributions = allDocs.rows.filter((row) => row.doc?.type === "contribution" && (row.doc as IContribution).walletAddress === walletAddress).map((row) => row.doc as IContribution);

		// Get active loans
		const activeLoans = allDocs.rows.filter((row) => row.doc?.type === "loan" && (row.doc as Loan).walletAddress === walletAddress && (row.doc as Loan).status === "approved").map((row) => row.doc as Loan);

		// Get group pool status
		let groupDoc: IGroup;
		try {
			groupDoc = (await db.get("chama")) as IGroup;
		} catch (error) {
			groupDoc = { _id: "chama", type: "group", name: "Chama", totalPool: 0 } as IGroup;
		}

		let response = `Contribution Status for ${walletAddress}:\n\n`;

		// Calculate contribution statistics
		const totalContributions = contributions.filter((contrib) => contrib.amountInUsd > 0).reduce((sum, contrib) => sum + contrib.amountInUsd, 0);

		const totalWithdrawals = contributions.filter((contrib) => contrib.amountInUsd < 0).reduce((sum, contrib) => sum + Math.abs(contrib.amountInUsd), 0);

		const netContribution = totalContributions - totalWithdrawals;
		const contributionPercentage = (netContribution / groupDoc.totalPool) * 100;

		// Show summary
		response += `Summary:\n`;
		response += `- Total Contributions: $${totalContributions.toFixed(2)}\n`;
		response += `- Total Withdrawals: $${totalWithdrawals.toFixed(2)}\n`;
		response += `- Net Contribution: $${netContribution.toFixed(2)}\n`;
		response += `- Pool Share: ${contributionPercentage.toFixed(2)}%\n`;
		response += `- Total Chama Pool: $${groupDoc.totalPool.toFixed(2)}\n\n`;

		// Show active loans if any
		if (activeLoans.length > 0) {
			response += `Active Loans:\n`;
			activeLoans.forEach((loan) => {
				const date = new Date(parseInt(loan._id.split("_")[1])).toLocaleString();
				response += `- ${loan._id}:\n`;
				response += `  Amount: $${loan.amount.toFixed(2)}\n`;
				response += `  Interest Rate: ${loan.interestRate}%\n`;
				response += `  Created: ${date}\n`;
				if (loan.paidAmount) {
					response += `  Paid: $${loan.paidAmount.toFixed(2)}\n`;
					response += `  Remaining: $${(loan.amount - loan.paidAmount).toFixed(2)}\n`;
				}
			});
			response += `\n`;
		}

		// Show recent transactions
		response += `Recent Transactions:\n`;
		if (contributions.length === 0) {
			response += `- No transactions found\n`;
		} else {
			// Sort by timestamp and show last 5 transactions
			const recentTransactions = contributions.sort((a, b) => new Date(b.transactionTimestamp || "").getTime() - new Date(a.transactionTimestamp || "").getTime()).slice(0, 5);

			recentTransactions.forEach((contrib) => {
				const date = new Date(contrib.transactionTimestamp || "").toLocaleString();
				const type = contrib.amountInUsd < 0 ? "Withdrawal" : "Contribution";
				response += `- ${type}: $${Math.abs(contrib.amountInUsd).toFixed(2)} (${contrib.amountInEth.toFixed(6)} ETH) on ${date}\n`;
				response += `  Transaction: ${contrib.transactionHash}\n`;
			});
		}

		// Show eligibility information
		response += `\nEligibility Information:\n`;
		response += `- Maximum Loan Amount: $${(netContribution * 5).toFixed(2)} (5x contribution)\n`;
		response += `- Voting Power: ${contributionPercentage.toFixed(2)}% of total pool\n`;

		// Show withdrawal limits
		const maxWithdrawal = netContribution * 0.5; // 50% of net contribution
		response += `- Maximum Withdrawal: $${maxWithdrawal.toFixed(2)} (50% of net contribution)\n`;

		return response;
	},
	{
		name: "checkContributionBalanceTool",
		description: "Provides detailed information about user's contributions, withdrawals, pool share, and eligibility for loans and withdrawals.",
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
			.filter((row) => row.doc?.type === "loan" && ((row.doc as Loan).status === "approved" || (row.doc as Loan).status === "paid"))
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

		try {
			// Get all transactions for the group wallet
			const transactions = await getWalletTransactions(GROUP_WALLET_ADDRESS);

			// Find the transaction with the provided hash
			const transaction = transactions.data.find(
				(item) => item.content().hash === hash
			);
			if (!transaction) {
				return `Transaction ${hash} not found. Please verify the hash and try again.`;
			}

			// Verify the transaction is to the group wallet
			if (transaction.content().to.toLowerCase() !== GROUP_WALLET_ADDRESS.toLowerCase()) {
				return `Transaction ${hash} is not a deposit to the group wallet.`;
			}

			// Verify the transaction is from the correct wallet
			if (transaction.content().from.toLowerCase() !== walletAddress.toLowerCase()) {
				return `Transaction ${hash} is not from your wallet address.`;
			}

			// Convert Wei to USD and ETH
			const amountInWei = transaction.content().value;
			const transactionAmts = await convertWeiToUSD(amountInWei);
			const amountInUsd = transactionAmts.usdAmount.toNumber();
			const amountInEth = transactionAmts.ethAmount.toNumber();

			// Get active loans for the user
			const allDocs = await db.allDocs({ include_docs: true });
			const activeLoans = allDocs.rows
				.filter(
					(row) =>
						row.doc?.type === "loan" &&
						(row.doc as Loan).walletAddress === walletAddress &&
						(row.doc as Loan).status === "approved" &&
						(row.doc as Loan).paidAmount !== (row.doc as Loan).amount
				)
				.map((row) => row.doc as Loan);

			if (activeLoans.length === 0) {
				return `No active loans found for your wallet.`;
			}

			let remainingAmount = amountInUsd;
			let response = `Processing transaction ${hash}:\n`;
			response += `- Total Amount: $${amountInUsd.toFixed(2)} (${amountInEth.toFixed(6)} ETH)\n`;

			// Process each active loan
			for (const loan of activeLoans) {
				const remainingLoanAmount = loan.amount - (loan.paidAmount || 0);
				if (remainingLoanAmount <= 0) continue;

				const paymentAmount = Math.min(remainingAmount, remainingLoanAmount);
				const interestPortion = Math.min(
					paymentAmount,
					remainingLoanAmount - (loan.amount - (loan.interestPaid || 0))
				);

				// Create loan payment record
				const loanPayment: LoanPayment = {
					amount: paymentAmount,
					timestamp: new Date().toISOString(),
					transactionHash: hash,
					interestAmount: interestPortion
				};

				// Update loan document
				loan.paidAmount = (loan.paidAmount || 0) + paymentAmount;
				loan.interestPaid = (loan.interestPaid || 0) + interestPortion;
				loan.payments = loan.payments || [];
				loan.payments.push(loanPayment);

				// Update loan status if fully paid
				if (loan.paidAmount >= loan.amount) {
					loan.status = "paid";
				}

				// Save updated loan document
				await db.put(loan);

				// If there's interest to distribute, create an interest distribution record
				if (interestPortion > 0) {
					const interestDistribution: InterestDistribution = {
						_id: `interest_${loan._id}_${Date.now()}`,
						type: "interest_distribution",
						loanId: loan._id,
						amount: interestPortion,
						timestamp: new Date().toISOString(),
						status: "pending"
					};
					await db.put(interestDistribution);
					response += `  • Interest Distribution Created: $${interestPortion.toFixed(2)}\n`;
				}

				remainingAmount -= paymentAmount;

				response += `- Applied $${paymentAmount.toFixed(2)} to loan ${loan._id}:\n`;
				response += `  • Principal: $${(paymentAmount - interestPortion).toFixed(2)}\n`;
				response += `  • Interest: $${interestPortion.toFixed(2)}\n`;
				response += `  • Remaining Balance: $${(remainingLoanAmount - paymentAmount).toFixed(2)}\n`;
				response += `  • Loan Status: ${loan.status}\n`;
				response += `  • Payment Recorded: Yes\n`;

				if (remainingAmount <= 0) break;
			}

			// Get group doc for pool updates
			const groupDoc = (await db.get("chama")) as IGroup;

			// If there's remaining amount, add it to contributions
			if (remainingAmount > 0) {
				// Save contribution
				const contribution: IContribution = {
					_id: `contrib_${walletAddress}_${hash}`,
					type: "contribution",
					walletAddress,
					amountInWei,
					amountInEth,
					amountInUsd: remainingAmount,
					transactionHash: hash,
					transactionTimestamp: new Date().toISOString(),
				};

				await db.put(contribution);

				// Update group total pool
				groupDoc.totalPool += remainingAmount;
				await db.put(groupDoc);

				response += `\nRemaining Amount Added to Contributions:\n`;
				response += `- Amount: $${remainingAmount.toFixed(2)} (${(remainingAmount / amountInUsd * amountInEth).toFixed(6)} ETH)\n`;
			} else {
				// Even if no remaining amount, still update the group doc to ensure consistency
				await db.put(groupDoc);
			}

			// Get user's total contribution after update
			const userContributions = allDocs.rows
				.filter(
					(row) =>
						row.doc?.type === "contribution" &&
						(row.doc as IContribution).walletAddress === walletAddress
				)
				.map((row) => row.doc as IContribution);

			const totalContribution = userContributions.reduce(
				(sum, contrib) => sum + contrib.amountInUsd,
				0
			);

			response += `\nUpdated Status:\n`;
			response += `- Your total contribution: $${totalContribution.toFixed(2)}\n`;
			response += `- Maximum loan amount: $${(totalContribution * 5).toFixed(2)} (5x contribution)\n`;
			response += `- Total pool size: $${groupDoc.totalPool.toFixed(2)}\n\n`;

			response += `Use listInterestDistributionsTool to see pending interest distributions.`;

			return response;
		} catch (error) {
			return `Error verifying transaction: ${error}`;
		}
	},
	{
		name: "verifyLoanRepaymentTool",
		description:
			"Verifies a loan repayment transaction using a transaction hash, converts the amount to USD, and processes partial or full payments. Any excess amount is added to the user's contributions. Tracks interest payments for distribution.",
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

		// Get all documents for this wallet
		const allDocs = await db.allDocs({ include_docs: true });

		// Get contributions
		const contributions = allDocs.rows.filter((row) => row.doc?.type === "contribution" && (row.doc as IContribution).walletAddress === walletAddress).map((row) => row.doc as IContribution);

		// Get active loans
		const activeLoans = allDocs.rows.filter((row) => row.doc?.type === "loan" && (row.doc as Loan).walletAddress === walletAddress && (row.doc as Loan).status === "approved").map((row) => row.doc as Loan);

		// Get paid loans
		const paidLoans = allDocs.rows.filter((row) => row.doc?.type === "loan" && (row.doc as Loan).walletAddress === walletAddress && (row.doc as Loan).status === "paid").map((row) => row.doc as Loan);

		let response = `Loan Eligibility Check for ${walletAddress}:\n\n`;

		// Check contributions
		if (contributions.length === 0) {
			return `No contribution record. Deposit funds to become eligible for loans with 'deposit 10'.`;
		}

		// Calculate total contribution
		const totalContribution = contributions.reduce((sum, contrib) => sum + contrib.amountInUsd, 0);
		const maxLoan = totalContribution * 5; // 5x contribution limit

		// Check active loans
		if (activeLoans.length > 0) {
			const totalActiveLoanAmount = activeLoans.reduce((sum, loan) => sum + loan.amount, 0);
			const totalPaidAmount = activeLoans.reduce((sum, loan) => sum + (loan.paidAmount || 0), 0);
			const totalRemaining = totalActiveLoanAmount - totalPaidAmount;

			response += `Active Loans:\n`;
			activeLoans.forEach((loan) => {
				const date = new Date(parseInt(loan._id.split("_")[1])).toLocaleString();
				response += `- ${loan._id}:\n`;
				response += `  Amount: $${loan.amount.toFixed(2)}\n`;
				response += `  Interest Rate: ${loan.interestRate}%\n`;
				response += `  Created: ${date}\n`;
				if (loan.paidAmount) {
					response += `  Paid: $${loan.paidAmount.toFixed(2)}\n`;
					response += `  Remaining: $${(loan.amount - loan.paidAmount).toFixed(2)}\n`;
				}
			});
			response += `\nTotal Active Loan Amount: $${totalActiveLoanAmount.toFixed(2)}\n`;
			response += `Total Paid: $${totalPaidAmount.toFixed(2)}\n`;
			response += `Total Remaining: $${totalRemaining.toFixed(2)}\n\n`;
			response += `Cannot apply for new loans while having active loans. Please repay your existing loans first.\n`;
			return response;
		}

		// Show loan history if any
		if (paidLoans.length > 0) {
			response += `Loan History:\n`;
			paidLoans.forEach((loan) => {
				const date = new Date(parseInt(loan._id.split("_")[1])).toLocaleString();
				response += `- ${loan._id}: $${loan.amount.toFixed(2)} (Paid on ${date})\n`;
			});
			response += `\n`;
		}

		// Show eligibility information
		response += `Eligibility Information:\n`;
		response += `- Total Contribution: $${totalContribution.toFixed(2)}\n`;
		response += `- Maximum Loan Amount: $${maxLoan.toFixed(2)} (5x contribution)\n`;
		response += `- Current Status: Eligible for new loans\n\n`;

		// Show contribution history
		response += `Contribution History:\n`;
		contributions.forEach((contrib) => {
			const date = new Date(contrib.transactionTimestamp || "").toLocaleString();
			const type = contrib.amountInUsd < 0 ? "Withdrawal" : "Contribution";
			response += `- ${type}: $${Math.abs(contrib.amountInUsd).toFixed(2)} on ${date}\n`;
		});

		return response;
	},
	{
		name: "checkLoanEligibilityTool",
		description: "Checks loan eligibility based on contributions, active loans, and loan history. Provides detailed information about current status and maximum loan amount.",
		schema: z.object({}),
	}
);

export const checkPaymentHistoryTool = tool(
	async ({}, config: RunnableConfig) => {
		const walletAddress = config["configurable"]["walletAddress"];
		if (!walletAddress) {
			return "Wallet address missing in configuration.";
		}

		// Get all documents for this wallet
		const allDocs = await db.allDocs({ include_docs: true });

		// Get contributions (including withdrawals)
		const contributions = allDocs.rows.filter((row) => row.doc?.type === "contribution" && (row.doc as IContribution).walletAddress === walletAddress).map((row) => row.doc as IContribution);

		// Get loans
		const loans = allDocs.rows.filter((row) => row.doc?.type === "loan" && (row.doc as Loan).walletAddress === walletAddress).map((row) => row.doc as Loan);

		// Get interest distributions received
		const interestDistributions = allDocs.rows
			.filter((row) => row.doc?.type === "interest_distribution" && (row.doc as InterestDistribution).distributionDetails?.some((detail) => detail.walletAddress === walletAddress))
			.map((row) => row.doc as InterestDistribution);

		let response = `Payment History for ${walletAddress}:\n\n`;

		// Contributions and Withdrawals
		response += `Contributions & Withdrawals:\n`;
		if (contributions.length === 0) {
			response += `- No contributions or withdrawals found\n`;
		} else {
			contributions.forEach((contrib) => {
				const date = new Date(contrib.transactionTimestamp || "").toLocaleString();
				const type = contrib.amountInUsd < 0 ? "Withdrawal" : "Contribution";
				response += `- ${type}: $${Math.abs(contrib.amountInUsd).toFixed(2)} (${contrib.amountInEth.toFixed(6)} ETH) on ${date}\n`;
				response += `  Transaction: ${contrib.transactionHash}\n`;
			});
		}

		// Loans
		response += `\nLoans:\n`;
		if (loans.length === 0) {
			response += `- No loans found\n`;
		} else {
			loans.forEach((loan) => {
				const date = new Date(parseInt(loan._id.split("_")[1])).toLocaleString();
				response += `- ${loan._id}:\n`;
				response += `  Amount: $${loan.amount.toFixed(2)}\n`;
				response += `  Interest Rate: ${loan.interestRate}%\n`;
				response += `  Status: ${loan.status}\n`;
				response += `  Created: ${date}\n`;

				if (loan.payments && loan.payments.length > 0) {
					response += `  Payment History:\n`;
					loan.payments.forEach((payment, index) => {
						const paymentDate = new Date(payment.timestamp).toLocaleString();
						response += `    ${index + 1}. $${payment.amount.toFixed(2)} on ${paymentDate}\n`;
						if (payment.interestAmount) {
							response += `       Interest: $${payment.interestAmount.toFixed(2)}\n`;
						}
						response += `       Transaction: ${payment.transactionHash}\n`;
					});
				}
			});
		}

		// Interest Distributions
		response += `\nInterest Distributions Received:\n`;
		if (interestDistributions.length === 0) {
			response += `- No interest distributions received\n`;
		} else {
			interestDistributions.forEach((dist) => {
				const date = new Date(dist.timestamp).toLocaleString();
				const userDistribution = dist.distributionDetails?.find((detail) => detail.walletAddress === walletAddress);
				if (userDistribution) {
					response += `- From loan ${dist.loanId}:\n`;
					response += `  Amount: $${userDistribution.amount.toFixed(2)}\n`;
					response += `  Date: ${date}\n`;
					response += `  Status: ${dist.status}\n`;
					if (userDistribution.transactionHash) {
						response += `  Transaction: ${userDistribution.transactionHash}\n`;
					}
				}
			});
		}

		return response;
	},
	{
		name: "checkPaymentHistoryTool",
		description: "Retrieves detailed payment history including contributions, withdrawals, loans, and interest distributions for the user.",
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

		const allDocs = await db.allDocs({ include_docs: true });

		// Get all contributions
		const contributions = allDocs.rows.filter((row) => row.doc?.type === "contribution").map((row) => row.doc as IContribution);

		// Get all loans
		const loans = allDocs.rows.filter((row) => row.doc?.type === "loan").map((row) => row.doc as Loan);

		// Get all interest distributions
		const interestDistributions = allDocs.rows.filter((row) => row.doc?.type === "interest_distribution").map((row) => row.doc as InterestDistribution);

		// Calculate total interest distributed
		const totalInterestDistributed = interestDistributions.reduce((sum, dist) => sum + (dist.status === "distributed" ? dist.amount : 0), 0);

		// Calculate total interest pending distribution
		const totalInterestPending = interestDistributions.reduce((sum, dist) => sum + (dist.status === "pending" ? dist.amount : 0), 0);

		let response = `Chama Pool Status:\n\n`;

		// Pool Overview
		response += `Pool Overview:\n`;
		response += `- Total Pool: $${groupDoc.totalPool.toFixed(2)}\n`;
		response += `- Total Interest Distributed: $${totalInterestDistributed.toFixed(2)}\n`;
		response += `- Pending Interest Distribution: $${totalInterestPending.toFixed(2)}\n\n`;

		// Active Loans
		response += `Active Loans:\n`;
		const activeLoans = loans.filter((loan) => loan.status === "approved");
		if (activeLoans.length === 0) {
			response += `- No active loans\n`;
		} else {
			activeLoans.forEach((loan) => {
				const date = new Date(parseInt(loan._id.split("_")[1])).toLocaleString();
				response += `- ${loan._id}:\n`;
				response += `  Amount: $${loan.amount.toFixed(2)}\n`;
				response += `  Borrower: ${loan.walletAddress}\n`;
				response += `  Interest Rate: ${loan.interestRate}%\n`;
				response += `  Created: ${date}\n`;
				if (loan.paidAmount) {
					response += `  Paid: $${loan.paidAmount.toFixed(2)}\n`;
					response += `  Remaining: $${(loan.amount - loan.paidAmount).toFixed(2)}\n`;
				}
			});
		}

		// Recent Contributions
		response += `\nRecent Contributions:\n`;
		const recentContributions = contributions.sort((a, b) => new Date(b.transactionTimestamp || "").getTime() - new Date(a.transactionTimestamp || "").getTime()).slice(0, 5);

		if (recentContributions.length === 0) {
			response += `- No recent contributions\n`;
		} else {
			recentContributions.forEach((contrib) => {
				const date = new Date(contrib.transactionTimestamp || "").toLocaleString();
				const type = contrib.amountInUsd < 0 ? "Withdrawal" : "Contribution";
				response += `- ${type}: $${Math.abs(contrib.amountInUsd).toFixed(2)} by ${contrib.walletAddress} on ${date}\n`;
			});
		}

		// Pending Interest Distributions
		response += `\nPending Interest Distributions:\n`;
		const pendingDistributions = interestDistributions.filter((dist) => dist.status === "pending");
		if (pendingDistributions.length === 0) {
			response += `- No pending interest distributions\n`;
		} else {
			pendingDistributions.forEach((dist) => {
				const date = new Date(dist.timestamp).toLocaleString();
				response += `- From loan ${dist.loanId}: $${dist.amount.toFixed(2)} (Created: ${date})\n`;
			});
		}

		return response;
	},
	{
		name: "checkGroupStatusTool",
		description: "Provides a comprehensive overview of the Chama pool, including total pool size, active loans, recent contributions, and interest distributions.",
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
		const contributions = allDocs.rows.filter((row) => row.doc?.type === "contribution").map((row) => row.doc as IContribution);

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
				percentage: percentage * 100,
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
						transactionHash: txHash,
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
		const contributions = allDocs.rows.filter((row) => row.doc?.type === "contribution" && (row.doc as IContribution).walletAddress === walletAddress).map((row) => row.doc as IContribution);

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
		const activeLoans = allDocs.rows.filter((row) => row.doc?.type === "loan" && (row.doc as Loan).walletAddress === walletAddress && (row.doc as Loan).status === "approved").map((row) => row.doc as Loan);

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
				transactionTimestamp: new Date().toISOString(),
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

export const listContributionsTool = tool(
	async ({}, config: RunnableConfig) => {
		const walletAddress = config?.configurable?.walletAddress;
		if (!walletAddress) {
			return "Wallet address missing in configuration.";
		}

		// Get all documents
		const allDocs = await db.allDocs({ include_docs: true });

		// Get all contributions
		const contributions = allDocs.rows.filter((row) => row.doc?.type === "contribution").map((row) => row.doc as IContribution);

		// Get group pool status
		let groupDoc: IGroup;
		try {
			groupDoc = (await db.get("chama")) as IGroup;
		} catch (error) {
			groupDoc = { _id: "chama", type: "group", name: "Chama", totalPool: 0 } as IGroup;
		}

		let response = `Chama Pool Contributions Overview:\n\n`;

		// Calculate pool statistics
		const totalContributions = contributions.filter((contrib) => contrib.amountInUsd > 0).reduce((sum, contrib) => sum + contrib.amountInUsd, 0);

		const totalWithdrawals = contributions.filter((contrib) => contrib.amountInUsd < 0).reduce((sum, contrib) => sum + Math.abs(contrib.amountInUsd), 0);

		const netContributions = totalContributions - totalWithdrawals;

		// Show pool statistics
		response += `Pool Statistics:\n`;
		response += `- Total Contributions: $${totalContributions.toFixed(2)}\n`;
		response += `- Total Withdrawals: $${totalWithdrawals.toFixed(2)}\n`;
		response += `- Net Contributions: $${netContributions.toFixed(2)}\n`;
		response += `- Current Pool Size: $${groupDoc.totalPool.toFixed(2)}\n\n`;

		// Group contributions by wallet
		const contributionsByWallet = new Map<
			string,
			{
				totalContributed: number;
				totalWithdrawn: number;
				transactions: IContribution[];
			}
		>();

		contributions.forEach((contrib) => {
			const wallet = contrib.walletAddress;
			const current = contributionsByWallet.get(wallet) || {
				totalContributed: 0,
				totalWithdrawn: 0,
				transactions: [],
			};

			if (contrib.amountInUsd > 0) {
				current.totalContributed += contrib.amountInUsd;
			} else {
				current.totalWithdrawn += Math.abs(contrib.amountInUsd);
			}
			current.transactions.push(contrib);
			contributionsByWallet.set(wallet, current);
		});

		// Sort wallets by total contribution
		const sortedWallets = Array.from(contributionsByWallet.entries()).sort((a, b) => b[1].totalContributed - a[1].totalContributed);

		// Show member contributions
		response += `Member Contributions:\n`;
		sortedWallets.forEach(([wallet, data]) => {
			const netContribution = data.totalContributed - data.totalWithdrawn;
			const poolShare = (netContribution / groupDoc.totalPool) * 100;

			response += `\n${wallet}:\n`;
			response += `- Total Contributed: $${data.totalContributed.toFixed(2)}\n`;
			response += `- Total Withdrawn: $${data.totalWithdrawn.toFixed(2)}\n`;
			response += `- Net Contribution: $${netContribution.toFixed(2)}\n`;
			response += `- Pool Share: ${poolShare.toFixed(2)}%\n`;
			response += `- Maximum Loan Amount: $${(netContribution * 5).toFixed(2)}\n`;

			// Show recent transactions (last 3)
			const recentTransactions = data.transactions.sort((a, b) => new Date(b.transactionTimestamp || "").getTime() - new Date(a.transactionTimestamp || "").getTime()).slice(0, 3);

			if (recentTransactions.length > 0) {
				response += `  Recent Transactions:\n`;
				recentTransactions.forEach((contrib) => {
					const date = new Date(contrib.transactionTimestamp || "").toLocaleString();
					const type = contrib.amountInUsd < 0 ? "Withdrawal" : "Contribution";
					response += `  - ${type}: $${Math.abs(contrib.amountInUsd).toFixed(2)} (${contrib.amountInEth.toFixed(6)} ETH) on ${date}\n`;
					response += `    Transaction: ${contrib.transactionHash}\n`;
				});
			}
		});

		// Show your contribution status if different from current wallet
		if (walletAddress) {
			const yourData = contributionsByWallet.get(walletAddress);
			if (yourData) {
				const netContribution = yourData.totalContributed - yourData.totalWithdrawn;
				const poolShare = (netContribution / groupDoc.totalPool) * 100;

				response += `\nYour Contribution Status:\n`;
				response += `- Total Contributed: $${yourData.totalContributed.toFixed(2)}\n`;
				response += `- Total Withdrawn: $${yourData.totalWithdrawn.toFixed(2)}\n`;
				response += `- Net Contribution: $${netContribution.toFixed(2)}\n`;
				response += `- Pool Share: ${poolShare.toFixed(2)}%\n`;
				response += `- Maximum Loan Amount: $${(netContribution * 5).toFixed(2)}\n`;
			}
		}

		return response;
	},
	{
		name: "listContributionsTool",
		description: "Lists all contributions in the Chama pool, showing pool statistics, member contributions, and individual contribution status.",
		schema: z.object({}),
	}
);

export const resetPoolTool = tool(
	async ({ confirm }, config: RunnableConfig) => {
		if (confirm !== "YES_RESET_POOL") {
			return `WARNING: This action will reset the entire Chama pool and refund all members.
This action cannot be undone.

To proceed, you must confirm by setting confirm="YES_RESET_POOL".

This will:
1. Calculate each member's net contribution
2. Process refunds to all members
3. Reset the pool to zero
4. Clear all contribution records
5. Clear all pending loans

Are you sure you want to proceed?`;
		}

		const walletAddress = config?.configurable?.walletAddress;
		if (!walletAddress) {
			return "Error: No wallet address configured";
		}

		try {
			// Get all documents
			const allDocs = await db.allDocs({ include_docs: true });
			const docs = allDocs.rows.map((row) => row.doc as ChamaDocument);

			// Get contributions and loans
			const contributions = docs.filter((doc) => doc.type === "contribution") as IContribution[];
			const loans = docs.filter((doc) => doc.type === "loan") as Loan[];

			// Check for active loans
			const activeLoans = loans.filter((loan) => loan.status === "approved" && loan.paidAmount !== loan.amount);
			if (activeLoans.length > 0) {
				return `Cannot reset pool while there are active loans:
${activeLoans.map((loan) => `- ${loan._id}: $${loan.amount.toFixed(2)} by ${loan.walletAddress}`).join("\n")}

Please ensure all loans are repaid before resetting the pool.`;
			}

			// Group contributions by wallet address
			const memberContributions = contributions.reduce((acc, contrib) => {
				if (!acc[contrib.walletAddress]) {
					acc[contrib.walletAddress] = [];
				}
				acc[contrib.walletAddress].push(contrib);
				return acc;
			}, {} as Record<string, IContribution[]>);

			let response = "Starting pool reset process...\n\n";
			let totalRefunded = 0;
			let refundCount = 0;

			// Process refunds
			for (const [memberWallet, memberContribs] of Object.entries(memberContributions)) {
				const totalContributed = memberContribs.reduce((sum, contrib) => sum + contrib.amountInUsd, 0);

				if (totalContributed > 0) {
					response += `Processing refund for ${memberWallet}:\n`;
					response += `- Net Contribution: $${totalContributed.toFixed(2)}\n`;

					try {
						// Convert USD to ETH for refund
						const ethPrice = await getEthPriceToday();
						const ethAmount = new Decimal(totalContributed).div(ethPrice).toDecimalPlaces(6);
						const txHash = await transferMoney(memberWallet, ethAmount);

						response += `  ✓ Refunded ${ethAmount} ETH (Transaction: ${txHash})\n\n`;
						totalRefunded += totalContributed;
						refundCount++;
					} catch (error) {
						response += `  ✗ Refund failed: ${error}\n\n`;
						throw new Error(`Failed to process refund for ${memberWallet}`);
					}
				}
			}

			// Reset pool size
			const groupDoc = docs.find((doc) => doc.type === "group") as IGroup;
			if (groupDoc) {
				await db.put({
					...groupDoc,
					totalPool: 0,
				});
			}

			// Delete all contribution records
			for (const contrib of contributions) {
				if (contrib._rev) {
					await db.remove(contrib._id, contrib._rev);
				}
			}

			// Delete all pending loans
			const pendingLoans = loans.filter((loan) => loan.status === "pending");
			for (const loan of pendingLoans) {
				if (loan._rev) {
					await db.remove(loan._id, loan._rev);
				}
			}

			response += `Pool reset completed successfully:\n`;
			response += `- Total refunds processed: ${refundCount}\n`;
			response += `- Total amount refunded: $${totalRefunded.toFixed(2)}\n`;
			response += `- Pool size reset to: $0.00\n`;
			response += `- All contribution records cleared\n`;
			response += `- ${pendingLoans.length} pending loans cleared\n`;

			return response;
		} catch (error) {
			return `Error resetting pool: ${error}`;
		}
	},
	{
		name: "resetPoolTool",
		description: "Resets the Chama pool by refunding all members their net contributions and clearing all records. Requires explicit confirmation and checks for active loans.",
		schema: z.object({
			confirm: z.string().describe("Confirmation string. Must be 'YES_RESET_POOL' to proceed."),
		}),
	}
);

export const listInterestDistributionsTool = tool(
	async ({}, config: RunnableConfig) => {
		const walletAddress = config["configurable"]["walletAddress"];
		if (!walletAddress) {
			return "Wallet address missing in configuration.";
		}

		// Get all interest distributions
		const allDocs = await db.allDocs({ include_docs: true });
		const interestDistributions = allDocs.rows
			.filter((row) => row.doc?.type === "interest_distribution")
			.map((row) => row.doc as InterestDistribution);

		if (interestDistributions.length === 0) {
			return "No interest distributions found.";
		}

		let response = `Interest Distributions:\n\n`;

		// Group by status
		const pendingDistributions = interestDistributions.filter(dist => dist.status === "pending");
		const distributedDistributions = interestDistributions.filter(dist => dist.status === "distributed");

		// Show pending distributions first
		if (pendingDistributions.length > 0) {
			response += `Pending Distributions:\n`;
			pendingDistributions.forEach(dist => {
				const date = new Date(dist.timestamp).toLocaleString();
				response += `- ID: ${dist._id}\n`;
				response += `  • Loan ID: ${dist.loanId}\n`;
				response += `  • Amount: $${dist.amount.toFixed(2)}\n`;
				response += `  • Created: ${date}\n`;
				response += `  • Status: ${dist.status}\n\n`;
			});
		}

		// Show distributed interest
		if (distributedDistributions.length > 0) {
			response += `Distributed Interest:\n`;
			distributedDistributions.forEach(dist => {
				const date = new Date(dist.timestamp).toLocaleString();
				response += `- ID: ${dist._id}\n`;
				response += `  • Loan ID: ${dist.loanId}\n`;
				response += `  • Amount: $${dist.amount.toFixed(2)}\n`;
				response += `  • Created: ${date}\n`;
				response += `  • Status: ${dist.status}\n`;
				
				if (dist.distributionDetails && dist.distributionDetails.length > 0) {
					response += `  • Distribution Details:\n`;
					dist.distributionDetails.forEach(detail => {
						response += `    - ${detail.walletAddress}: $${detail.amount.toFixed(2)}\n`;
						if (detail.transactionHash) {
							response += `      Transaction: ${detail.transactionHash}\n`;
						}
					});
				}
				response += `\n`;
			});
		}

		// Show summary
		const totalPending = pendingDistributions.reduce((sum, dist) => sum + dist.amount, 0);
		const totalDistributed = distributedDistributions.reduce((sum, dist) => sum + dist.amount, 0);

		response += `Summary:\n`;
		response += `- Total Pending: $${totalPending.toFixed(2)}\n`;
		response += `- Total Distributed: $${totalDistributed.toFixed(2)}\n`;
		response += `- Total Interest: $${(totalPending + totalDistributed).toFixed(2)}\n\n`;

		response += `To distribute pending interest, use distributeInterestTool with the distribution ID.`;

		return response;
	},
	{
		name: "listInterestDistributionsTool",
		description: "Lists all interest distributions with their IDs, showing both pending and distributed interest. Includes distribution details and transaction hashes for completed distributions.",
		schema: z.object({}),
	}
);
