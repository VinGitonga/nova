import ConnectWalletBtn from "@/components/btn/connect-wallet";
import { Button } from "@/components/ui/button";
import Link from "next/link";

const HomeScreen = () => {
	return (
		<div className="flex items-center justify-center h-svh">
			<div className="flex items-center justify-center gap-2">
				<Link href={"/chat"}>
					<Button color="primary" className="bg-[#37A290]">
						Login
					</Button>
				</Link>
				<ConnectWalletBtn />
			</div>
		</div>
	);
};

export default HomeScreen;
