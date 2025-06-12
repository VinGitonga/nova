import axios from "axios";
import { COINGECKO_API_KEY, COINGECKO_BASE_URL } from "../constants";
import { BigNumber } from "bignumber.js";

export async function convertWeiToUSD(weiAmt: string) {
	const weiPerEth = new BigNumber("1000000000000000000");
	const ethAmount = new BigNumber(weiAmt).dividedBy(weiPerEth);

	const ethPriceToday = await getEthPriceToday();
	if (!ethPriceToday) {
        throw new Error("Unable to retrieve eth price today")
    }

	const ethPriceInUSD = new BigNumber(ethPriceToday);

	const usdAmount = ethAmount.multipliedBy(ethPriceInUSD);

	return {
		weiAmt,
		usdAmount,
		ethAmount,
	};
}
export async function getEthPriceToday() {
	try {
		const response = await axios.get(`${COINGECKO_BASE_URL}/simple/price?ids=ethereum&vs_currencies=usd`, { headers: { "x-cg-demo-api-key": COINGECKO_API_KEY } });

		return response.data.ethereum.usd;
	} catch (err) {
		console.log("error", err);
		return null;
	}
}
