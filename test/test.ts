import { assertEquals } from "jsr:@std/assert";
import { parsePkgData } from "../src/main.ts";

Deno.test({
	name: "PKGBUILD",
	fn: () => {
		const x = parsePkgData(Deno.readTextFileSync("./test/pkgbuild/.SRCINFO"));
		console.log(x);
	},
});

Deno.test({
	name: "PKGBUILD2",
	fn: () => {
		const x = parsePkgData(Deno.readTextFileSync("./test/pkgbuild/.SRCINFO"));
		console.log(x);
		const x2 = parsePkgData(Deno.readTextFileSync("./test/pkgbuild/.SRCINFO2"));
		console.log(x2);
		const x3 = parsePkgData(Deno.readTextFileSync("./test/pkgbuild/.SRCINFO3"));
		console.log(x3);
	},
});
