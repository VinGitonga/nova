import { Coinbase, Wallet } from "@coinbase/coinbase-sdk";
import { CDP_API_KEY, CDP_API_KEY_PRIVATE_KEY, ENCRYPTION_KEY, NETWORK_ID, OPENAI_API_KEY, WALLET_KEY, XMTP_ENV } from "./constants";
import { createSigner, getEncryptionKeyFromHex, logAgentDetails } from "@helpers/client";
import { Client, Conversation, DecodedMessage, XmtpEnv } from "@xmtp/node-sdk";
import { ChatOpenAI } from "@langchain/openai";
import { AgentKit, AgentKitOptions, CdpWalletProvider, erc20ActionProvider, walletActionProvider } from "@coinbase/agentkit";
import { getLangChainTools } from "@coinbase/agentkit-langchain";
import { END, MemorySaver, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { createReactAgent, ToolNode } from "@langchain/langgraph/prebuilt";
import { askHumanTool, groupSavingsTool, investmentTool, lendingTool, votingTool } from "tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import { StructuredTool } from "@langchain/core/tools";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { Runnable, RunnableConfig } from "@langchain/core/runnables";

Coinbase.configure({ apiKeyName: CDP_API_KEY, privateKey: CDP_API_KEY_PRIVATE_KEY.replace(/\\n/g, "\n") });

const XMTP_STORAGE_DIR = ".data/xmtp";

type Agent = ReturnType<typeof createReactAgent>;

interface AgentConfig {
	configurable: {
		thread_id: string;
	};
}

const memoryStore: Record<string, MemorySaver> = {};
const agentStore: Record<string, Agent> = {};
const chamaTools = [groupSavingsTool, lendingTool, votingTool, investmentTool, askHumanTool];

async function createAgent({ llm, tools, systemMessage }: { llm: ChatOpenAI; tools: StructuredTool[]; systemMessage: string }) {
	const toolNames = tools.map((tool) => tool.name).join(", ");
	let prompt = ChatPromptTemplate.fromMessages([
		[
			"system",
			"You are a helpful AI assistant for the Chama DeFi project, managing a single savings pool for group-based financial activities. " +
				"All actions occur within a single group (no group IDs needed). Users are identified by their wallet address (e.g., '0x123...'). " +
				"Interpret natural language inputs to perform actions using the provided tools: deposit funds, request loans, vote on loans, or propose investments. " +
				"For deposits, call groupSavingsTool with walletAddress and amount. " +
				"For loan requests, call lendingTool with walletAddress, amount, collateral, and interestRate (0-20%). " +
				"For voting on loans, call votingTool with walletAddress, loanId, and vote (true/false). " +
				"For proposing investments, call investmentTool with walletAddress, description, amount, and action='propose'. " +
				"If a tool response includes 'Please confirm' or 'requires confirmation', call askHuman to pause for human input (approve, reject, or adjust with JSON). " +
				"If the user input is ambiguous, ask for clarification using askHuman. " +
				"Prefix final answers with 'FINAL ANSWER' when the action is complete and no further input is needed. " +
				"Available tools: {tool_names}.\n{system_message}",
		],
		new MessagesPlaceholder("messages"),
	]);

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
	// Human input is provided via Command({ resume: ... }) in stream; this node waits
	return { messages: [] }; // Return empty messages; resume handled by Command
}

// Router function
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

async function initXMTPClient() {
	const signer = createSigner(WALLET_KEY);
	const dbEncrptionKey = getEncryptionKeyFromHex(ENCRYPTION_KEY);

	const identifier = await signer.getIdentifier();
	const address = identifier.identifier;

	const client = await Client.create(signer, { dbEncryptionKey: dbEncrptionKey, env: XMTP_ENV as XmtpEnv, apiUrl: "https://grpc.dev.xmtp.network:443", dbPath: `${XMTP_STORAGE_DIR}/${XMTP_ENV}-${address}` });

	void logAgentDetails(client);

	// Sync Conversations from the network to update the local instance
	console.log("✓ Syncing conversations...");
	await client.conversations.sync();

	return client;
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

async function initAgent(userId: string) {
	try {
		const llm = new ChatOpenAI({
			model: "gpt-4o",
			apiKey: OPENAI_API_KEY,
			temperature: 0.7,
		});

		const walletInfo = await Wallet.import({
			mnemonicPhrase: process.env.WALLET_MNEMONIC_PHRASE!,
		});

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
			actionProviders: [walletActionProvider(), erc20ActionProvider()],
		} satisfies AgentKitOptions;

		const agentKit = await AgentKit.from(options);

		const tools = await getLangChainTools(agentKit);

		memoryStore[userId] = new MemorySaver();

		const agentConfig: AgentConfig = {
			configurable: { thread_id: userId },
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
			.addNode("agent", chamaNode)
			.addNode("action", toolNode)
			.addNode("askHuman", askHuman)
			.addEdge(START, "agent")
			.addEdge("action", "agent")
			.addEdge("askHuman", "agent")
			.addConditionalEdges("agent", shouldContinue);

		const app = workflow.compile({ checkpointer: memoryStore[userId] });

		agentStore[userId] = app;

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
		for await (const chunk of stream) {
			if (chunk && typeof chunk === "object" && "agent" in chunk) {
				const agentChunk = chunk as { agent: { messages: Array<{ content: unknown }> } };
				response += String(agentChunk.agent.messages[0].content) + "\n";
			} else if (chunk && typeof chunk === "object" && "askHuman" in chunk) {
				const askHumanChunk = chunk as { askHuman: { messages: Array<{ content: unknown }> } };
				response += String(askHumanChunk.askHuman.messages[0]?.content || "Please respond with 'approve', 'reject', or 'adjust' (with JSON, e.g., {\"amount\": 500}).") + "\n";
			}
		}
		return response.trim() || "Action processed. Awaiting your next input.";
	} catch (error) {
		console.error("Error processing message:", error);
		return "Sorry, I encountered an error while processing your request. Please try again later.";
	}
}

async function handleMessage(message: DecodedMessage, client: Client) {
	let conversation: Conversation | null = null;
	try {
		const senderAddress = message.senderInboxId.toLowerCase();
		const botAddress = client.inboxId.toLowerCase();

		if (senderAddress === botAddress) {
			return; // Ignore self-messages
		}

		console.log(`Received message from ${senderAddress}: ${message.content}`);

		const { agent, config } = await initAgent(senderAddress);
		let response = await processMessage(agent, config, String(message.content), senderAddress);

		// Check if agent is paused for human input
		const state = await agent.getState(config);
		if (state.next.includes("askHuman")) {
			const lastMessage = state.values.messages[state.values.messages.length - 1] as BaseMessage;
			response = `${lastMessage.content}\nPlease respond with 'approve', 'reject', or 'adjust' (with JSON, e.g., {\"amount\": 500}).`;
		}

		conversation = await client.conversations.getConversationById(message.conversationId);
		if (!conversation) {
			throw new Error(`Could not find conversation for ID: ${message.conversationId}`);
		}
		await conversation.send(response);
		console.log(`Sent response to ${senderAddress}: ${response}`);
	} catch (error) {
		console.error("Error handling message:", error);
		if (conversation) {
			await conversation.send("I encountered an error while processing your request. Please try again later.");
		}
	}
}

async function startMessageListener(client: Client) {
	console.log("Starting XMTP message listener...");
	const stream = await client.conversations.streamAllMessages();
	for await (const message of stream) {
		if (message) {
			await handleMessage(message, client);
		}
	}
}

async function main(): Promise<void> {
	console.log("Initializing Chama DeFi Bot on XMTP...");
	try {
		const xmtpClient = await initXMTPClient();
		await startMessageListener(xmtpClient);
	} catch (error) {
		console.error("Failed to start bot:", error);
		process.exit(1);
	}
}

main().catch(console.error);
