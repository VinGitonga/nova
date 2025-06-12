import { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import PouchDB from "pouchdb";
import { z } from "zod";
import { Address, Coinbase, Wallet } from "@coinbase/coinbase-sdk";
import { GROUP_WALLET_ADDRESS, WALLET_MNEMONIC_PHRASE } from "../constants";
import { convertWeiToUSD, getEthPriceToday } from "helpers";
import { Command } from "@langchain/langgraph";
import { AIMessage, ToolMessage } from "@langchain/core/messages";

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

interface Loan {
	_id: string;
	_rev?: string;
	type: "loan";
	walletAddress: string;
	amount: number;
	collateral: number;
	interestRate: number;
	status: "pending" | "approved" | "rejected";
	votes: Array<{ walletAddress: string; vote: boolean }>;
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

type ChamaDocument = IGroup | IContribution | Loan | Investment;

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
			ethPriceInUSD = new BigNumber(response.data.ethereum.usd);
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

async function transferMoney(walletAddress: string, amount: number) {
	const wallet = await Wallet.import({ mnemonicPhrase: WALLET_MNEMONIC_PHRASE });

	const transfer = await wallet.createTransfer({
		amount: amount,
		assetId: Coinbase.assets.Eth,
		destination: walletAddress,
	});

	try {
		await transfer.wait();

		return transfer.getTransaction().content().hash;
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

		// Check contribution (1/5 of loan amount as "collateral")
		const contribId = `contrib_${walletAddress}`;
		let contrib: IContribution;
		try {
			contrib = (await db.get(contribId)) as IContribution;
		} catch (error) {
			contrib = { _id: contribId, type: "contribution", walletAddress, amountInWei: "0", amountInEth: 0, amountInUsd: 0, transactionHash: "", transactionTimestamp: "" } as IContribution;
		}
		const requiredContribution = amount / 5;
		if ((contrib.amountInUsd || 0) < requiredContribution) {
			return `Need to contribute at least $${requiredContribution.toFixed(2)} USD (1/5 of $${amount}) to borrow. Current contribution: $${(contrib.amountInUsd || 0).toFixed(2)}.`;
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
				amount,
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
		description: "Requests a loan from the Chama pool, requiring a contribution of at least 1/5 of the loan amount and sufficient pool funds. Uses a fixed 10% interest rate.",
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

		const loan = (await db.get(loanId).catch(() => {
			throw new Error(`Loan ${loanId} not found.`);
		})) as Loan;
		if (loan.status !== "pending") {
			return `Loan ${loanId} is not open for voting. Status: ${loan.status}.`;
		}

		const existingVote = loan.votes.find((v) => v.walletAddress === walletAddress);
		if (existingVote) {
			return `Already voted on loan ${loanId}.`;
		}
		loan.votes.push({ walletAddress, vote });
		await db.put(loan);

		const group = (await db.get("chama").catch(() => {
			throw new Error("Chama pool not found.");
		})) as IGroup;
		const contrib = await db.get(`contrib_${walletAddress}`).catch(
			() =>
				({
					_id: `contrib_${walletAddress}`,
					type: "contribution",
					walletAddress,
					amountInWei: "0",
					amountInEth: 0,
					amountInUsd: 0,
					amount: 0,
				} as IContribution)
		);
		const totalVotes = await loan.votes.reduce(async (acc: Promise<number>, v: { walletAddress: string; vote: boolean }) => {
			const c = (await db.get(`contrib_${v.walletAddress}`).catch(
				() =>
					({
						_id: `contrib_${v.walletAddress}`,
						type: "contribution",
						walletAddress: v.walletAddress,
						amountInWei: "0",
						amountInEth: 0,
						amountInUsd: 0,
						amount: 0,
					} as IContribution)
			)) as IContribution;
			return (await acc) + (v.vote ? c.amountInUsd || 0 : 0);
		}, Promise.resolve(0));
		const totalPool = group.totalPool;
		const approvalRatio = totalVotes / totalPool;

		const status = approvalRatio >= 0.6 ? "approved" : "rejected";

		if (approvalRatio >= 0.6) {
			loan.status = status;
			await db.put(loan);
			// transfer the funds
			const ethPriceInUSD = await getEthPriceToday();
			const ethAmount = loan.amount / ethPriceInUSD;
			const txHash = await transferMoney(loan.walletAddress, ethAmount);
			if (!txHash) {
				return `Voting complete for loan ${loanId}. Status: ${status}. Approval ratio: ${(approvalRatio * 100).toFixed(2)}%. However, the fund transfer failed. Please try again.`;
			}
			return `Voting complete for loan ${loanId}. Status: ${status}. Approval ratio: ${(approvalRatio * 100).toFixed(2)}%. Transferred ${ethAmount.toFixed(6)} ETH ($${loan.amount.toFixed(2)} USD) to ${loan.walletAddress}. Transaction hash: ${txHash}`;
		}

		return `Vote (${vote ? "approve" : "reject"}) recorded on loan ${loanId}.`;
	},
	{
		name: "votingTool",
		description: "Casts a vote on a loan request, weighted by contributions in the Chama pool.",
		schema: z.object({
			loanId: z.string().describe("ID of the loan to vote on"),
			vote: z.boolean().describe("Vote: true to approve, false to reject"),
		}),
	}
);

export const investmentTool = tool(
	async ({ description, amount, action }, config: RunnableConfig) => {
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
			description,
			amount,
			status: "pending",
			votes: [],
		} as Investment);

		return `Investment ${investId} proposed for ${amount}: ${description}. Please confirm proposal details.`;
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
		console.log("config", config);
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

		const groupDoc = (await db.get("chama").catch(
			() =>
				({
					_id: "chama",
					type: "group",
					name: "Chama",
					totalPool: 0,
				} as IGroup)
		)) as IGroup;

		if (contrib.amountInUsd === 0 && contrib._rev === undefined) {
			return `No contribution record. Deposit funds to join with 'deposit 10'.`;
		}

		return `Balance:\n- Contribution: ${contrib.amountInUsd}\n- Total Chama Pool: ${groupDoc.totalPool}.`;
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

		const loans = (await db.allDocs({ include_docs: true })).rows.filter((row) => row.doc?.type === "loan" && row.doc?.status === "approved").map((row) => row.doc as Loan);

		if (!loans.length) {
			return `No active loans found.`;
		}

		let totalBalance = 0;
		let response = `Loan Balance:\n`;
		for (const loan of loans) {
			const principal = loan.amount;
			const interest = (principal * (loan.interestRate / 100) * 30) / 365;
			const outstanding = principal + interest;
			totalBalance += outstanding;
			response += `- ${loan._id}: Principal=${principal}, Interest=${interest.toFixed(2)}, Total=${outstanding.toFixed(2)} (approved)\n`;
		}
		response += `Total Outstanding: ${totalBalance.toFixed(2)}`;

		return response;
	},
	{
		name: "checkLoanBalanceTool",
		description: "Retrieves the user's total outstanding loan balance, including principal and 30-day interest.",
		schema: z.object({}),
	}
);

export const checkLoanEligibilityTool = tool(
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

		if (contrib.amountInUsd === 0 && contrib._rev === undefined) {
			return `No contribution record. Deposit funds to become eligible for loans with 'deposit 10'.`;
		}

		const maxLoan = contrib.amountInUsd * 5;
		return `Eligible for a loan up to ${maxLoan} based on contribution of ${contrib.amountInUsd}.`;
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
