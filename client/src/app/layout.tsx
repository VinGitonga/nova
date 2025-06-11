import type { Metadata } from "next";
import "@coinbase/onchainkit/styles.css";
import "./globals.css";
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
