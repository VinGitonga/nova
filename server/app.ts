import { Address, Coinbase, Wallet } from "@coinbase/coinbase-sdk";
import { CDP_API_KEY, CDP_API_KEY_PRIVATE_KEY, ENCRYPTION_KEY, NETWORK_ID, OPENAI_API_KEY, WALLET_KEY, XMTP_ENV } from "./constants";
import { createSigner, getEncryptionKeyFromHex, logAgentDetails } from "@helpers/client";
import { Client, ConsentState, Conversation, ConversationType, DecodedMessage, Group, Identifier, IdentifierKind, XmtpEnv } from "@xmtp/node-sdk";
import { ChatOpenAI } from "@langchain/openai";
import { AgentKit, AgentKitOptions, CdpWalletProvider, erc20ActionProvider, walletActionProvider } from "@coinbase/agentkit";
import { getLangChainTools } from "@coinbase/agentkit-langchain";
import { END, MemorySaver, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { createReactAgent, ToolNode } from "@langchain/langgraph/prebuilt";
import {
	askHumanTool,
	checkContributionBalanceTool,
	checkGroupStatusTool,
	checkLoanBalanceTool,
	checkLoanEligibilityTool,
	checkPaymentHistoryTool,
	checkWalletAddressTool,
	distributeInterestTool,
	groupSavingsTool,
	investmentTool,
	investmentVotingTool,
	lendingTool,
	listContributionsTool,
	listInterestDistributionsTool,
	resetPoolTool,
	verifyGroupSavingTransactionHash,
	verifyLoanRepaymentTool,
	votingTool,
	withdrawFundsTool,
} from "tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import { StructuredTool } from "@langchain/core/tools";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { Runnable, RunnableConfig } from "@langchain/core/runnables";
import * as fs from "fs";
import { SYSTEM_PROMPT } from "constants/prompt";

Coinbase.configure({ apiKeyName: CDP_API_KEY, privateKey: CDP_API_KEY_PRIVATE_KEY.replace(/\\n/g, "\n") });

const XMTP_STORAGE_DIR = ".data/xmtp";

type Agent = ReturnType<typeof createReactAgent>;

interface AgentConfig {
	configurable: {
		thread_id: string;
		walletAddress: string;
	};
}

const memoryStore: Record<string, MemorySaver> = {};
const agentStore: Record<string, { agent: Agent; config: AgentConfig }> = {};
const chamaTools = [
	groupSavingsTool,
	lendingTool,
	votingTool,
	investmentTool,
	askHumanTool,
	checkWalletAddressTool,
	checkPaymentHistoryTool,
	checkLoanBalanceTool,
	checkGroupStatusTool,
	checkLoanEligibilityTool,
	checkContributionBalanceTool,
	verifyGroupSavingTransactionHash,
	investmentVotingTool,
	verifyLoanRepaymentTool,
	distributeInterestTool,
	withdrawFundsTool,
	listContributionsTool,
	resetPoolTool,
	listInterestDistributionsTool
];

async function createAgent({ llm, tools, systemMessage }: { llm: ChatOpenAI; tools: StructuredTool[]; systemMessage: string }) {
	const toolNames = tools.map((tool) => tool.name).join(", ");
	let prompt = ChatPromptTemplate.fromMessages([["system", SYSTEM_PROMPT], new MessagesPlaceholder("messages")]);

	prompt = await prompt.partial({
		system_message: systemMessage,
		tool_names: toolNames,
	});

	return prompt.pipe(llm.withConfig({ tools: tools.map((t) => convertToOpenAITool(t)) }));
}

function askHuman(state: typeof MessagesAnnotation.State): Partial<typeof MessagesAnnotation.State> {
	const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
	const toolCallId = lastMessage.tool_calls?.[0].id;
	console.log(`Human input required: ${lastMessage.content}`);
	console.log("Options: approve, reject, adjust (with JSON input)");
	return { messages: [] };
}

function shouldContinue(state: typeof MessagesAnnotation.State): "action" | "askHuman" | typeof END {
	const lastMessage = state.messages[state.messages.length - 1] as AIMessage;

	if (lastMessage && !lastMessage.tool_calls?.length) {
		return END;
	}

	if (lastMessage.tool_calls?.[0]?.name === "askHuman") {
		console.log("--- ASKING HUMAN ---");
		return "askHuman";
	}

	return "action";
}

function ensureLocalStorage() {
	if (!fs.existsSync(XMTP_STORAGE_DIR)) {
		fs.mkdirSync(XMTP_STORAGE_DIR, { recursive: true });
	}
}

async function initXMTPClient() {
	const signer = createSigner(WALLET_KEY);
	const dbEncrptionKey = getEncryptionKeyFromHex(ENCRYPTION_KEY);

	const identifier = await signer.getIdentifier();
	const address = identifier.identifier;

	const client = await Client.create(signer, {
		dbEncryptionKey: dbEncrptionKey,
		env: XMTP_ENV as XmtpEnv,
		apiUrl: "https://grpc.dev.xmtp.network:443",
		dbPath: `${XMTP_STORAGE_DIR}/${XMTP_ENV}-${address}`,
	});

	void logAgentDetails(client);

	console.log("✓ Syncing conversations...");
	await client.conversations.sync();

	const groupMembers: Identifier[] = [
		{
			identifier: "0x5413eb0c19d3a7ca4876c02036c6decc390f3687",
			identifierKind: IdentifierKind.Ethereum,
		},
		{
			identifier: "0x1758ba28a5d95b217fa9723e9a1198f0a18a4cf5",
			identifierKind: IdentifierKind.Ethereum,
		},
	];

	// check if group exists
	const existingGroups = client.conversations.listGroups();

	const alreadyGroup = existingGroups.find((item) => item.name === "Nova Group");

	let group;

	if (alreadyGroup) {
		group = alreadyGroup;
	} else {
		// create a group,
		group = await client.conversations.newGroupWithIdentifiers(groupMembers, { groupName: "Nova Group", groupDescription: "Test Group for XMTP with Coinbase AI" });
	}

	return { client, group };
}

async function runAgentNode(props: { state: typeof MessagesAnnotation.State; agent: Runnable; name: string; config?: RunnableConfig }) {
	const { state, agent, name, config } = props;

	let result = await agent.invoke(state, config);

	if (!result?.tool_calls || result?.tool_calls?.length === 0) {
		result = new HumanMessage({ ...result, name });
	}

	return {
		messages: [result],
	};
}

async function getWalletTransactions(walletAddress: string) {
	const address = new Address("base-sepolia", walletAddress);

	let transactions = await address.listTransactions({ limit: 5 });
	console.log("transactions", transactions.data);
}

async function initAgent(conversationId: string, wallet: string) {
	try {
		const llm = new ChatOpenAI({
			model: "gpt-4o",
			apiKey: OPENAI_API_KEY,
			temperature: 0.7,
		});

		const walletInfo = await Wallet.import({
			mnemonicPhrase: process.env.WALLET_MNEMONIC_PHRASE!,
		});

		// pool information
		// getWalletTransactions("0x5413eb0c19d3a7ca4876c02036c6decc390f3687");

		const walletProvider = await CdpWalletProvider.configureWithWallet({
			apiKeyId: CDP_API_KEY,
			apiKeySecret: CDP_API_KEY_PRIVATE_KEY.replace(/\\n/g, "\n"),
			networkId: NETWORK_ID,
			wallet: walletInfo,
		});

		const options = {
			cdpApiKeyId: CDP_API_KEY,
			cdpApiKeySecret: CDP_API_KEY_PRIVATE_KEY.replace(/\\n/g, "\n"),
			walletProvider,
			actionProviders: [
				// walletActionProvider(),
				// erc20ActionProvider()
			],
		} satisfies AgentKitOptions;

		const agentKit = await AgentKit.from(options);

		const tools = await getLangChainTools(agentKit);

		memoryStore[conversationId] = new MemorySaver();

		const agentConfig: AgentConfig = {
			configurable: { thread_id: conversationId, walletAddress: wallet },
		};

		const allTools = [...chamaTools, ...tools];

		const toolNode = new ToolNode<typeof MessagesAnnotation.State>([...allTools]);
		const modelWithTools = llm.bindTools(allTools.map((t) => convertToOpenAITool(t)));

		async function callModel(state: typeof MessagesAnnotation.State): Promise<Partial<typeof MessagesAnnotation.State>> {
			const messages = state.messages;
			const response = await modelWithTools.invoke(messages);
			return { messages: [response] };
		}

		const chamaAgent = await createAgent({
			llm,
			tools,
			systemMessage: "Execute Chama DeFi tasks with human oversight for confirmations.",
		});

		async function chamaNode(state: typeof MessagesAnnotation.State, config?: RunnableConfig) {
			return runAgentNode({
				state,
				agent: chamaAgent,
				name: "ChamaAgent",
				config,
			});
		}

		const workflow = new StateGraph(MessagesAnnotation)
			.addNode("agent", callModel)
			.addNode("action", toolNode)
			.addNode("askHuman", askHuman)
			.addEdge(START, "agent")
			.addEdge("action", "agent")
			.addEdge("askHuman", "agent")
			.addConditionalEdges("agent", shouldContinue);

		const app = workflow.compile({ checkpointer: memoryStore[conversationId] });

		return { agent: app, config: agentConfig };
	} catch (error) {
		console.error("Failed to initialize agent:", error);
		throw error;
	}
}

async function processMessage(agent: Agent, config: AgentConfig, message: string, senderAddress: string): Promise<string> {
	let response = "";
	try {
		const stream = await agent.stream({ messages: [new HumanMessage({ content: message, additional_kwargs: { walletAddress: senderAddress } })] }, config);
		for await (const event of stream) {
			if (!event.__end__) {
				const node = Object.keys(event)[0];
				// console.log('node', node)
				// console.log('event', event)
				const recentMsg = event[node].messages[event[node].messages.length - 1] as BaseMessage;
				response += String(recentMsg.content) + "\n";
			}
		}
		return response.trim() || "Action processed. Awaiting your next input.";
	} catch (error) {
		console.error("Error processing message:", error);
		return "Sorry, I encountered an error while processing your request. Please try again later.";
	}
}

async function handleMessage(message: DecodedMessage, client: Client, group: any) {
	let conversation: Conversation | null = null;
	try {
		const senderAddress = message.senderInboxId.toLowerCase();
		const botAddress = client.inboxId.toLowerCase();
		const conversationId = message.conversationId;

		const convo = await client.conversations.getConversationById(conversationId);

		const members = await convo.members();

		// console.log("members[0].inboxId", members[0].inboxId);

		// console.log("members", members[0].accountIdentifiers[0].identifier);

		// console.log("message", message);
		if (senderAddress === botAddress) {
			return; // Ignore self-messages
		}

		const senderDetails = members.find((member) => member.inboxId === senderAddress);

		const walletAddress = senderDetails.accountIdentifiers[0].identifier;

		console.log(`Received message from ${senderAddress}: ${message.content}`);

		// Check if agent is already initialized for this user
		let agentData = agentStore[senderAddress];
		if (!agentData) {
			// Initialize agent only if it doesn't exist
			agentData = await initAgent(message.conversationId, walletAddress);
			agentStore[senderAddress] = agentData;
		}
		const { agent, config } = agentData;

		// Check if the message is an exit command
		if ((message.content as string).toLowerCase() === "exit") {
			conversation = await client.conversations.getConversationById(message.conversationId);
			if (conversation) {
				await conversation.send("AI: Exiting Chama DeFi. Goodbye!");
			}
			// Clear memory and agent for this user
			delete memoryStore[senderAddress];
			delete agentStore[senderAddress];
			return;
		}

		// Check current state for HITL
		let state = await agent.getState(config);
		let response = "";

		if (state.next.includes("askHuman")) {
			// Handle HITL response
			console.log(`AI: Resuming with human input: ${message.content}`);
			const stream = await agent.stream({ resume: message.content }, config);
			for await (const event of stream) {
				if (!event.__end__) {
					const node = Object.keys(event)[0];
					const recentMsg = event[node].messages[event[node].messages.length - 1] as BaseMessage;
					response += String(recentMsg.content) + "\n";
				}
			}
		} else {
			// Process new message
			response = await processMessage(agent, config, String(message.content), senderAddress);
		}

		// Check if agent is paused for human input
		state = await agent.getState(config);
		if (state.next.includes("askHuman")) {
			const lastMessage = state.values.messages[state.values.messages.length - 1] as BaseMessage;
			response = `${lastMessage.content}\nPlease respond with 'approve', 'reject', or 'adjust' (with JSON, e.g., {\"amount\": 500}).`;
		}

		conversation = await client.conversations.getConversationById(message.conversationId);
		if (!conversation) {
			throw new Error(`Could not find conversation for ID: ${message.conversationId}`);
		}
		await conversation.send(response.trim());
		// await group.send(response.trim());
		console.log(`Sent response to ${senderAddress}: ${response.trim()}`);
	} catch (error) {
		console.error("Error handling message:", error);
		if (conversation) {
			await conversation.send("I encountered an error while processing your request. Please try again later.");
		}
	}
}

async function startMessageListener(client: Client, group: any) {
	console.log("Starting XMTP message listener...");
	const stream = await client.conversations.streamAllMessages((err, val) => {}, ConversationType.Group, [ConsentState.Allowed]);
	for await (const message of stream) {
		if (message) {
			await handleMessage(message, client, group);
		}
	}
}

async function main(): Promise<void> {
	console.log("Initializing Chama DeFi Bot on XMTP...");
	ensureLocalStorage();
	try {
		const { client: xmtpClient, group } = await initXMTPClient();
		await startMessageListener(xmtpClient, group);
	} catch (error) {
		console.log(error);
		console.error("Failed to start bot:", error);
		process.exit(1);
	}
}

main().catch(console.error);
