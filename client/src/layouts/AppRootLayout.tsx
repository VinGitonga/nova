import { jakartaSans } from "@/lib/font";
import { cn } from "@/lib/utils";
import { FC, ReactNode } from "react";

interface AppRootLayoutProps {
	children: ReactNode;
}

const AppRootLayout: FC<AppRootLayoutProps> = ({ children }) => {
	return <div className={cn("min-h-screen bg-gray-100 font-jakarta antialiased", "transition-colors duration-200 ease-in-out", jakartaSans.variable)}>{children}</div>;
};

export default AppRootLayout;
