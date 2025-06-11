import AppRootLayout from "@/layouts/AppRootLayout";
import { FC, ReactNode } from "react";
import OnchainkitAppProvider from "./OnchainkitAppProvider";

interface AppProviderProps {
	children: ReactNode;
}

const AppProvider: FC<AppProviderProps> = ({ children }) => {
	return (
		<AppRootLayout>
			<OnchainkitAppProvider>{children}</OnchainkitAppProvider>
		</AppRootLayout>
	);
};

export default AppProvider;
