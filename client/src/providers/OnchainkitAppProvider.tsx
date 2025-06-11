import { ONCHAINKIT_API_KEY } from "@/helpers/constants";
import { OnchainKitProvider } from "@coinbase/onchainkit";
import { FC, ReactNode } from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { coinbaseWallet } from "wagmi/connectors";

interface OnchainkitProviderProps {
	children: ReactNode;
}

const wagmiConfig = createConfig({
	chains: [baseSepolia],
	connectors: [
		coinbaseWallet({
			appName: "onchainkit",
		}),
	],
	ssr: true,
	transports: {
		[baseSepolia.id]: http(),
	},
});

const OnchainkitAppProvider: FC<OnchainkitProviderProps> = ({ children }) => {
	return (
		<WagmiProvider config={wagmiConfig}>
			<OnchainKitProvider apiKey={ONCHAINKIT_API_KEY} chain={baseSepolia}>
				{children}
			</OnchainKitProvider>
		</WagmiProvider>
	);
};

export default OnchainkitAppProvider;
