import dotenv from "dotenv";

dotenv.config();

export const NETWORK_ID = process.env.NETWORK_ID;
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const CDP_API_KEY_NAME = process.env.CDP_API_KEY_NAME;
export const CDP_API_KEY = process.env.CDP_API_KEY;
export const CDP_API_KEY_PRIVATE_KEY = process.env.CDP_API_KEY_PRIVATE_KEY;
export const XMTP_ENV = process.env.XMTP_ENV;
export const WALLET_KEY = process.env.WALLET_KEY;
export const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
export const CDP_WALLET_SECRET = process.env.CDP_WALLET_SECRET;
export const WALLET_MNEMONIC_PHRASE = process.env.WALLET_MNEMONIC_PHRASE;
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;
