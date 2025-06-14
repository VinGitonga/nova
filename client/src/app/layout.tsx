import type { Metadata } from "next";
import "./globals.css";
import "@coinbase/onchainkit/styles.css";
import { jakartaSans } from "@/lib/font";
import AppProvider from "@/providers/AppProvider";

export const metadata: Metadata = {
	title: "Nova",
	description: "XMPT AI agent Powered Chat APP for Groups.",
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head />
			<body className={`${jakartaSans.variable}`} suppressHydrationWarning>
				<AppProvider>{children}</AppProvider>
			</body>
		</html>
	);
}
