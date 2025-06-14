"use client";

import { ArrowRight } from "lucide-react";
import ConnectWalletBtn from "../btn/connect-wallet";

const WalletConnections = () => {
	return (
		<div className="flex items-center gap-2">
			<ConnectWalletBtn />
			<a href="http://xmtp.chat/dm/0x41a9dc633fafd6cfa50107ed7040a1c39b5e1319" target="_blank">
				<button className="transition-all duration-300 hover:scale-105 active:scale-95">
					<div className="bg-gradient-to-r from-[#201641] to-[#FF6106] font-bold text-white rounded-4xl px-6 py-3 transition-all duration-300 hover:shadow-xl hover:shadow-[#FF6106]/30">
						<div className="flex items-center gap-2">
							<p>{"Go To Chat"}</p>
							<ArrowRight />
						</div>
					</div>
				</button>
			</a>
		</div>
	);
};

export default WalletConnections;
