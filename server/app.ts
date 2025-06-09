import { Coinbase, Wallet } from "@coinbase/coinbase-sdk";
import { CDP_API_KEY, CDP_API_KEY_PRIVATE_KEY, ENCRYPTION_KEY, WALLET_KEY, XMTP_ENV } from "./constants";
import { createSigner, getEncryptionKeyFromHex, logAgentDetails } from "@helpers/client";
import { Client, XmtpEnv } from "@xmtp/node-sdk";

Coinbase.configure({ apiKeyName: CDP_API_KEY, privateKey: CDP_API_KEY_PRIVATE_KEY.replace(/\\n/g, "\n") });

const XMTP_STORAGE_DIR = ".data/xmtp";
const WALLET_STORAGE_DIR = ".data/wallet";

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

async function initAgent(userId: string) {}
