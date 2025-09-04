import { delay } from "@std/async/delay";
import { changeOut } from "../src/simple_tui.ts";

Deno.test({
	name: "tui",
	fn: async () => {
		console.log("1\n2\n3\n4\n5\n6");
		const xx = changeOut();
		xx.update("Goodbye\n1234");
		await delay(500);
		xx.update("AA\nBB");
		await delay(500);
		xx.log("test");
		await delay(500);
		xx.update("a\nb");
		await delay(500);
		console.log("xxx");
	},
});
