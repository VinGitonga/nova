"use client";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";

interface HomeConnectBtnProps {
	text?: string;
}

const HomeConnectBtn = ({ text }: HomeConnectBtnProps) => {
	const router = useRouter();
	return (
		<button
			onClick={
				text
					? () => {
							router.push("/chat");
					  }
					: () => {}
			}
			className="transition-all duration-300 hover:scale-105 active:scale-95">
			<div className="bg-gradient-to-r from-[#201641] to-[#FF6106] font-bold text-white rounded-4xl px-6 py-3 transition-all duration-300 hover:shadow-xl hover:shadow-[#FF6106]/30">
				<div className="flex items-center gap-2">
					<p>{text ? text : "Connect Wallet"}</p>
					<ArrowRight />
				</div>
			</div>
		</button>
	);
};

export default HomeConnectBtn;
