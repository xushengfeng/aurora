import { assertEquals } from "jsr:@std/assert";
import { parsePKGBUILD, parsePKGBUILDMore } from "../src/main.ts";

Deno.test({
	name: "PKGBUILD",
	fn: () => {
		const x = parsePKGBUILD(Deno.readTextFileSync("./test/pkgbuild/PKGBUILD"));
		console.log(x);
		const haveKey = [
			"pkgname",
			"pkgver",
			"pkgrel",
			"pkgdesc",
			"arch",
			"url",
			"license",
			"provides",
			"conflicts",
			"depends",
			"makedepends",
			"source",
			"sha256sums",
		];
		assertEquals(Object.keys(x).sort(), haveKey.sort());
	},
});

Deno.test({
	name: "PKGBUILD2",
	fn: () => {
		const x = parsePKGBUILD(Deno.readTextFileSync("./test/pkgbuild/PKGBUILD"));
		console.log(parsePKGBUILDMore(x));
		const x2 = parsePKGBUILD(
			Deno.readTextFileSync("./test/pkgbuild/PKGBUILD2"),
		);
		console.log(parsePKGBUILDMore(x2));
	},
});
