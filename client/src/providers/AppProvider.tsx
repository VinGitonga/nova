"use client";
import AppRootLayout from "@/layouts/AppRootLayout";
import { FC, ReactNode } from "react";
import { OnchainKitProvider } from "@coinbase/onchainkit";
import { ONCHAINKIT_API_KEY } from "@/helpers/constants";
import { baseSepolia } from "wagmi/chains";

interface AppProviderProps {
	children: ReactNode;
}

const AppProvider: FC<AppProviderProps> = ({ children }) => {
	return (
		<AppRootLayout>
			<OnchainKitProvider apiKey={ONCHAINKIT_API_KEY} chain={baseSepolia}>
				{children}
			</OnchainKitProvider>
		</AppRootLayout>
	);
};

export default AppProvider;
