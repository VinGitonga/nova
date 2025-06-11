import { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import PouchDB from "pouchdb";
import { z } from "zod";

interface IGroup {
	_id: "chama";
	_rev?: string;
	type: "group";
	name: string;
	totalPool: number;
}

interface IContribution {
	_id: string;
	_rev?: string;
	type: "contribution";
	walletAddress: string;
	amount: number;
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
	async ({ amount }, config: RunnableConfig) => {
		const walletAddress = config["configurable"]["walletAddress"];
		if (!walletAddress) {
			return "Wallet address missing in configuration.";
		}
		if (!amount || amount <= 0) {
			return "Deposit amount must be positive";
		}

		const contribId = `contrib_${walletAddress}`;
		const contrib = (await db.get(contribId).catch(
			() =>
				({
					_id: contribId,
					type: "contribution",
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

		contrib.amount += amount;
		groupDoc.totalPool += amount;

		await db.put(contrib);
		await db.put(groupDoc);

		return `Deposited ${amount} to the Chama pool. Total pool: ${groupDoc.totalPool}.`;
	},
	{
		name: "groupSavingsTool",
		description: "Manages deposits to the single Chama savings pool.",
		schema: z.object({
			amount: z.number().positive().describe("Amount to deposit"),
		}),
	}
);

export const lendingTool = tool(
	async ({ amount, collateral, interestRate }, config: RunnableConfig) => {
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
					amount: 0,
				} as IContribution)
		)) as IContribution;

		if (contrib.amount < amount / 5) {
			return `Need to contribute at least ${amount / 5} (1/5 of ${amount}). Current: ${contrib.amount}.`;
		}

		if (collateral < amount * 1.5) {
			return `Collateral (${collateral}) must be at least 150% of loan amount (${amount}). Please confirm or adjust.`;
		}
		if (interestRate < 0 || interestRate > 20) {
			return `Interest rate (${interestRate}%) must be between 0-20%. Please confirm or adjust.`;
		}

		const loanId = `loan_${Date.now()}`;
		await db.put({
			_id: loanId,
			type: "loan",
			amount,
			collateral,
			interestRate,
			status: "pending",
			votes: [],
		} as Loan);

		return `Loan request ${loanId} created for ${amount}. Collateral: ${collateral}, Interest: ${interestRate}%. Awaiting group vote.`;
	},
	{
		name: "lendingTool",
		description: "Requests a loan with 1/5 contribution rule in the Chama pool.",
		schema: z.object({
			amount: z.number().positive().describe("Loan amount"),
			collateral: z.number().positive().describe("Collateral amount"),
			interestRate: z.number().describe("Proposed interest rate (%)"),
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
		const contrib = await db.get(`contrib_${walletAddress}`).catch(() => ({ amount: 0 } as IContribution));
		const totalVotes = await loan.votes.reduce(async (acc: Promise<number>, v: { walletAddress: string; vote: boolean }) => {
			const c = (await db.get(`contrib_${v.walletAddress}`).catch(() => ({ amount: 0 } as IContribution))) as IContribution;
			return (await acc) + (v.vote ? c.amount : 0);
		}, Promise.resolve(0));
		const totalPool = group.totalPool;
		const approvalRatio = totalVotes / totalPool;

		const status = approvalRatio >= 0.6 ? "approved" : "rejected";

		if (approvalRatio >= 0.6) {
			loan.status = status;
			await db.put(loan);
			return `Voting complete for loan ${loanId}. Status: ${status}. Approval ratio: ${(approvalRatio * 100).toFixed(2)}%. Please confirm final decision.`;
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
        console.log('config', config)
		if (!walletAddress) {
			return "Wallet address missing in configuration.";
		}

		const contribId = `contrib_${walletAddress}`;
		const contrib = (await db.get(contribId).catch(
			() =>
				({
					_id: contribId,
					type: "contribution",
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

		if (contrib.amount === 0 && contrib._rev === undefined) {
			return `No contribution record. Deposit funds to join with 'deposit 10'.`;
		}

		return `Balance:\n- Contribution: ${contrib.amount}\n- Total Chama Pool: ${groupDoc.totalPool}.`;
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
					amount: 0,
				} as IContribution)
		)) as IContribution;

		if (contrib.amount === 0 && contrib._rev === undefined) {
			return `No contribution record. Deposit funds to become eligible for loans with 'deposit 10'.`;
		}

		const maxLoan = contrib.amount * 5;
		return `Eligible for a loan up to ${maxLoan} based on contribution of ${contrib.amount}.`;
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
					amount: 0,
				} as IContribution)
		)) as IContribution;

		const loans = (await db.allDocs({ include_docs: true })).rows.filter((row) => row.doc?.type === "loan").map((row) => row.doc as Loan);

		const investments = (await db.allDocs({ include_docs: true })).rows.filter((row) => row.doc?.type === "investment").map((row) => row.doc as Investment);

		let response = `Payment History:\n`;
		response += `- Contributions: ${contrib.amount > 0 ? `Total ${contrib.amount}` : "None"}\n`;
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
