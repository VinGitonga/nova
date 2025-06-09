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
	async ({ walletAddress, amount }) => {
		if (!amount || amount <= 0) {
			return "Deposit amount must be positive";
		}

		const contribId = `contrib_${walletAddress}`;
		const contrib = (await db.get(contribId).catch(
			() =>
				({
					_id: contribId,
					type: "contribution",
					walletAddress,
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

		return `Wallet ${walletAddress} deposited ${amount} to the Chama pool. Total pool: ${groupDoc.totalPool}.`;
	},
	{
		name: "groupSavingsTool",
		description: "Manages deposits to the single Chama savings pool.",
		schema: z.object({
			walletAddress: z.string().describe("Wallet address of the user"),
			amount: z.number().positive().describe("Amount to deposit"),
		}),
	}
);

export const lendingTool = tool(
	async ({ walletAddress, amount, collateral, interestRate }) => {
		const contribId = `contrib_${walletAddress}`;
		const contrib = (await db.get(contribId).catch(
			() =>
				({
					_id: contribId,
					type: "contribution",
					walletAddress,
					amount: 0,
				} as IContribution)
		)) as IContribution;

		if (contrib.amount < amount / 5) {
			return `Wallet ${walletAddress} needs to contribute at least ${amount / 5} (1/5 of ${amount}). Current: ${contrib.amount}.`;
		}

		// Validate collateral and interest
		if (collateral < amount * 1.5) {
			return `Collateral (${collateral}) must be at least 150% of loan amount (${amount}). Please confirm or adjust.`;
		}
		if (interestRate < 0 || interestRate > 20) {
			return `Interest rate (${interestRate}%) must be between 0-20%. Please confirm or adjust.`;
		}

		// Create loan request
		const loanId = `loan_${Date.now()}`;
		await db.put({
			_id: loanId,
			type: "loan",
			walletAddress,
			amount,
			collateral,
			interestRate,
			status: "pending",
			votes: [],
		} as Loan);

		return `Loan request ${loanId} created for ${amount} by wallet ${walletAddress}. Collateral: ${collateral}, Interest: ${interestRate}%. Awaiting group vote.`;
	},
	{
		name: "lendingTool",
		description: "Requests a loan with 1/5 contribution rule in the Chama pool.",
		schema: z.object({
			walletAddress: z.string().describe("Wallet address of the user requesting the loan"),
			amount: z.number().positive().describe("Loan amount"),
			collateral: z.number().positive().describe("Collateral amount"),
			interestRate: z.number().describe("Proposed interest rate (%)"),
		}),
	}
);

export const votingTool = tool(
	async ({ walletAddress, loanId, vote }) => {
		// Verify loan
		const loan = (await db.get(loanId).catch(() => {
			throw new Error(`Loan ${loanId} not found.`);
		})) as Loan;
		if (loan.status !== "pending") {
			return `Loan ${loanId} is not open for voting. Status: ${loan.status}.`;
		}

		// Cast vote
		const existingVote = loan.votes.find((v) => v.walletAddress === walletAddress);
		if (existingVote) {
			return `Wallet ${walletAddress} already voted on loan ${loanId}.`;
		}
		loan.votes.push({ walletAddress, vote });
		await db.put(loan);

		// Check if voting is complete (60% approval threshold)
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

		return `Vote (${vote ? "approve" : "reject"}) recorded for wallet ${walletAddress} on loan ${loanId}.`;
	},
	{
		name: "votingTool",
		description: "Casts a vote on a loan request, weighted by contributions in the Chama pool.",
		schema: z.object({
			walletAddress: z.string().describe("Wallet address of the voting user"),
			loanId: z.string().describe("ID of the loan to vote on"),
			vote: z.boolean().describe("Vote: true to approve, false to reject"),
		}),
	}
);

export const investmentTool = tool(
	async ({ walletAddress, description, amount, action }) => {
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

		return `Investment ${investId} proposed by wallet ${walletAddress} for ${amount}: ${description}. Please confirm proposal details.`;
	},
	{
		name: "investmentTool",
		description: "Proposes an investment project for voting in the Chama pool.",
		schema: z.object({
			walletAddress: z.string().describe("Wallet address of the user proposing the investment"),
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
