import { Button } from "@/components/ui/button";
import Link from "next/link";

const HomeScreen = () => {
	return (
		<div className="flex items-center justify-center h-svh">
			<Link href={"/chat"}>
				<Button color="primary" className="bg-[#37A290]">
					Login
				</Button>
			</Link>
		</div>
	);
};

export default HomeScreen;
